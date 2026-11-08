import { checkDate, depositCents, isValidDate, nextStatus, type BookingAction, type BookingStatus } from "./bookings";
import type { Deps, StripeGateway, StripeSession } from "./deps";
import { plan, type PlanEvent } from "./notifications";
import { offer, planById } from "./offer";
import {
  applyTransition,
  countActiveByEmail,
  countRecentByIp,
  findActiveByDateAndEmail,
  getBooking,
  insertBooking,
  patchBooking,
  type Booking,
  type NewBooking,
  type Transition,
} from "./repository";

export type RequestInput = {
  date: string;
  plan: string;
  event_type: string;
  event_hours: string;
  venue: string;
  name: string;
  phone: string;
  email: string;
  message?: string;
  terms: boolean;
  turnstile_token: string;
};

export type CreateRequestResult =
  | { kind: "created" | "already_requested"; booking: Booking }
  | { kind: "date_taken" | "too_many" | "bot" }
  | { kind: "invalid"; fields: string[] };

const HOUR_MS = 3_600_000;

const PHONE = /^[0-9 +.()-]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** 256 bits aléatoires, pour les liens que seul le client connaît. */
const randomToken = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** L'empreinte salée d'une adresse IP : de quoi la compter, pas de quoi la retrouver. */
const hashIp = async (salt: string, ip: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ip))));

/** L'échéance, en UTC, `hours` heures après `now`. */
const holdUntil = (now: Date, hours: number): string => new Date(now.getTime() + hours * HOUR_MS).toISOString();

/** Une réservation sans client ni paiement : chaque colonne est nulle, sauf celles que l'appelant fixe. */
const blankBooking = (
  base: Pick<NewBooking, "event_date" | "status" | "source">,
  fields: Partial<NewBooking> = {},
): NewBooking => ({
  id: crypto.randomUUID(),
  token: randomToken(),
  plan: null,
  price_cents: null,
  deposit_cents: null,
  client_name: null,
  client_email: null,
  client_phone: null,
  event_type: null,
  venue: null,
  event_hours: null,
  message: null,
  ip_hash: null,
  terms_version: null,
  hold_until: null,
  stripe_session: null,
  stripe_session_expires: null,
  deposit_paid_at: null,
  balance_paid_at: null,
  notes: null,
  anonymized_at: null,
  ...base,
  ...fields,
});

/** Le texte rogné s'il est une chaîne qui passe `ok`, sinon `null`. */
const accept =
  (ok: (text: string, now: Date) => boolean) =>
  (value: unknown, now: Date): string | null => {
    const text = typeof value === "string" ? value.trim() : null;
    return text !== null && ok(text, now) ? text : null;
  };

const lengthBetween = (min: number, max: number) => (text: string) => text.length >= min && text.length <= max;

const email = accept((text) => lengthBetween(1, 254)(text) && EMAIL.test(text));
const message = accept(lengthBetween(0, 2000));

/**
 * Une règle par champ : la valeur nettoyée, ou `null` si elle est refusée. L'ordre est celui du formulaire.
 * Le jeton Turnstile peut être vide : le formulaire n'en a pas quand le service est en panne, et c'est
 * `verifyTurnstile` qui tranche.
 */
export const PARSERS: { [K in keyof RequestInput]-?: (value: unknown, now: Date) => RequestInput[K] | null } = {
  date: accept((text, now) => checkDate(text, now) === "ok"),
  plan: accept((text) => planById(text) !== undefined),
  event_type: accept((text) => offer.eventTypes.includes(text)),
  event_hours: accept(lengthBetween(1, 60)),
  venue: accept(lengthBetween(1, 300)),
  name: accept(lengthBetween(1, 120)),
  phone: accept((text) => PHONE.test(text)),
  email: (value, now) => email(typeof value === "string" ? value.toLowerCase() : value, now),
  message: (value, now) => message(value ?? "", now),
  terms: (value) => (value === true ? true : null),
  turnstile_token: accept(lengthBetween(0, 2048)),
};

/** Les champs refusés sont tous nommés : un corps qui n'est pas un objet les refuse tous. */
function parseRequest(input: unknown, now: Date): { ok: true; value: RequestInput } | { ok: false; fields: string[] } {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const name of Object.keys(PARSERS) as (keyof RequestInput)[]) {
    const parsed = PARSERS[name](raw[name], now);
    if (parsed === null) fields.push(name);
    else value[name] = parsed;
  }
  return fields.length > 0 ? { ok: false, fields } : { ok: true, value: value as RequestInput };
}

/**
 * Une panne du service anti-robots, annoncée ou non, ne coûte jamais une demande. Une exception est
 * consignée (message seulement, ni jeton ni adresse) : sans trace, un secret erroné couperait la protection en silence.
 */
async function checkTurnstile(deps: Deps, token: string, ip: string | null) {
  try {
    return await deps.verifyTurnstile(token, ip);
  } catch (error) {
    console.error(`Turnstile : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    return "unavailable";
  }
}

/**
 * Enregistre la demande d'un client : champs, doublon, Turnstile, limites, puis insertion qui tient la date.
 * Un même envoi répété donne `already_requested`, y compris quand deux envois se croisent.
 */
export async function createRequest(deps: Deps, input: unknown, ip: string | null): Promise<CreateRequestResult> {
  const now = deps.now();
  const parsed = parseRequest(input, now);
  if (!parsed.ok) return { kind: "invalid", fields: parsed.fields };
  const request = parsed.value;
  const db = deps.env.DB;

  // Avant Turnstile : un jeton ne sert qu'une fois, un second envoi (double clic) arrive avec un jeton dépensé.
  const findTwin = () => findActiveByDateAndEmail(db, request.date, request.email);
  const twin = await findTwin();
  if (twin) return { kind: "already_requested", booking: twin };

  if ((await checkTurnstile(deps, request.turnstile_token, ip)) === "fail") return { kind: "bot" };

  // Sans sel, une empreinte se retrouverait par essais : mieux vaut n'en garder aucune, et sauter la limite par adresse.
  const salt = deps.env.IP_HASH_SALT;
  const ipHash = ip && salt ? await hashIp(salt, ip) : null;
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  if (
    (await countActiveByEmail(db, request.email)) >= offer.maxActivePerEmail ||
    (ipHash !== null && (await countRecentByIp(db, ipHash, dayAgo)) >= offer.maxPerIpPer24h)
  ) {
    return { kind: "too_many" };
  }

  const chosen = planById(request.plan)!; // validé par parseRequest
  const nowIso = now.toISOString();
  const booking = blankBooking(
    { event_date: request.date, status: "pending_review", source: "site" },
    {
      plan: chosen.id,
      price_cents: chosen.priceCents,
      deposit_cents: depositCents(chosen.priceCents, offer.depositPercent),
      client_name: request.name,
      client_email: request.email,
      client_phone: request.phone,
      event_type: request.event_type,
      venue: request.venue,
      event_hours: request.event_hours,
      message: request.message || null,
      ip_hash: ipHash,
      terms_version: offer.termsVersion,
      hold_until: holdUntil(now, offer.reviewHours),
    },
  );
  const specs = plan("requested", { ...booking, created_at: nowIso, updated_at: nowIso }, now);

  const inserted = await insertBooking(db, booking, specs, nowIso);
  if (inserted.ok) return { kind: "created", booking: inserted.booking };
  // Un envoi identique, arrivé en même temps, vient de prendre la date : pour ce client, c'est une réussite.
  const winner = await findTwin();
  return winner ? { kind: "already_requested", booking: winner } : { kind: "date_taken" };
}

export type Actor = "client" | "owner" | "system" | "stripe";

export type OpResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "not_found" | "stale" | "date_taken" | "invalid" };

const NOT_FOUND: OpResult = { ok: false, reason: "not_found" };
/** L'état de la réservation n'autorise plus l'opération, ou a changé depuis la lecture : rien n'a été écrit. */
const STALE: OpResult = { ok: false, reason: "stale" };

const applied = (booking: Booking | null): OpResult => (booking ? { ok: true, booking } : STALE);

/** Lit la réservation puis lui applique `run`. */
async function withBooking(deps: Deps, id: string, run: (b: Booking) => OpResult | Promise<OpResult>): Promise<OpResult> {
  const b = await getBooking(deps.env.DB, id);
  return b ? run(b) : NOT_FOUND;
}

type Step = { event: PlanEvent; patch: (now: Date) => Partial<Booking> };

const release = (): Partial<Booking> => ({ hold_until: null });

/** Ce que chaque action écrit et annonce. L'événement nomme à la fois les messages à planifier et la ligne d'historique. */
const STEPS: Record<BookingAction, Step> = {
  validate: { event: "validated", patch: (now) => ({ hold_until: holdUntil(now, offer.paymentHours) }) },
  refuse: { event: "refused", patch: release },
  pay: { event: "paid", patch: (now) => ({ hold_until: null, deposit_paid_at: now.toISOString() }) },
  expire: { event: "released", patch: release },
  cancel: { event: "cancelled", patch: release },
};

/**
 * Fait passer `b` à l'état que la machine prévoit pour `action`. Les messages encore en file sont annulés
 * avant ceux de l'événement : aucun message périmé ne part. `stale` si l'action est interdite depuis cet
 * état, ou si `b` n'y est plus au moment de l'écriture.
 */
async function transition(deps: Deps, b: Booking, actor: Actor, action: BookingAction): Promise<OpResult> {
  const to = nextStatus(b.status, action);
  if (to === null) return STALE;
  const { event, patch } = STEPS[action];
  const now = deps.now();
  const fields = patch(now);
  // `cancelled` et `released` lisent la réservation d'avant (une date bloquée ne prévient personne, et le client n'apprend pas
  // la même chose d'une demande restée sans réponse que d'un acompte non payé) ; les autres, celle d'après.
  const planned = event === "cancelled" || event === "released" ? b : { ...b, ...fields, status: to };
  return applied(
    await applyTransition(deps.env.DB, {
      id: b.id,
      from: b.status,
      to,
      patch: fields,
      actor,
      event,
      cancelPending: true,
      notifications: plan(event, planned, now),
      nowIso: now.toISOString(),
    }),
  );
}

const act =
  (action: BookingAction) =>
  (deps: Deps, id: string, actor: Actor): Promise<OpResult> =>
    withBooking(deps, id, (b) => transition(deps, b, actor, action));

export const validateBooking = act("validate");
export const refuseBooking = act("refuse");
export const cancelBooking = act("cancel");
export const confirmDeposit = act("pay");

/** Libère une demande dont l'échéance est passée. Les vérifications Stripe se font avant l'appel. */
export const expireHold = (deps: Deps, b: Booking): Promise<OpResult> => transition(deps, b, "system", "expire");

/**
 * Change des champs ou met des messages en file sans changer l'état, ni annuler ceux déjà prévus. C'est
 * `applyTransition` de l'état à lui-même : à la différence de `patchBooking`, il n'écrit rien si la
 * réservation a changé d'état depuis la lecture.
 */
const stay = async (
  deps: Deps,
  b: Booking,
  now: Date,
  event: string,
  extra: Pick<Transition, "patch" | "notifications"> & { actor?: Actor },
): Promise<OpResult> =>
  applied(
    await applyTransition(deps.env.DB, {
      actor: "owner",
      ...extra,
      id: b.id,
      from: b.status,
      to: b.status,
      event,
      nowIso: now.toISOString(),
    }),
  );

/**
 * Ferme la session d'acompte et rend son dernier état, jamais « ouverte » : expirée, ou payée.
 * Stripe refuse d'expirer une session qui n'est plus ouverte : on la lit d'abord, et si elle se ferme ou se
 * paie entre la lecture et l'appel, on relit. Lève si Stripe est en panne et que la session reste ouverte.
 */
export async function closeSession(stripe: StripeGateway, id: string): Promise<StripeSession> {
  const session = await stripe.retrieveSession(id);
  if (session.status !== "open") return session;
  try {
    await stripe.expireSession(id);
    return { ...session, status: "expired", url: null };
  } catch (error) {
    const after = await stripe.retrieveSession(id);
    if (after.status === "open") throw error; // vraie panne : la réservation reste intacte
    return after;
  }
}

/** Stripe ne répond pas : l'opération qui l'appelait n'a rien modifié. Le message est celui de la passerelle. */
export class PaymentUnavailable extends Error {}

/** Le prix se règle tant que l'acompte n'est pas payé. */
const PRICE_EDITABLE: readonly BookingStatus[] = ["pending_review", "awaiting_deposit"];

/** `closeSession`, dont toute exception est une panne de Stripe, annoncée comme telle : celles de D1 n'en sont pas. */
const closeSessionOrUnavailable = (stripe: StripeGateway, id: string): Promise<StripeSession> =>
  closeSession(stripe, id).catch((error) => {
    throw new PaymentUnavailable(error instanceof Error ? error.message : "Stripe injoignable");
  });

/**
 * Fixe le prix, et l'acompte à la main ou d'après `offer.depositPercent`. Une session ouverte est expirée et
 * oubliée : le client en rouvre une au même montant que le nouveau prix. Une session déjà payée donne `stale`.
 * Une panne de Stripe lève `PaymentUnavailable`, sans rien modifier.
 */
export const adjustPrice = (
  deps: Deps,
  id: string,
  a: { priceCents: number; depositCents?: number },
): Promise<OpResult> =>
  withBooking(deps, id, async (b) => {
    if (!PRICE_EDITABLE.includes(b.status)) return STALE;
    if (b.stripe_session && (await closeSessionOrUnavailable(deps.stripe, b.stripe_session)).paymentStatus === "paid") return STALE;
    return stay(deps, b, deps.now(), "price_adjusted", {
      patch: {
        price_cents: a.priceCents,
        deposit_cents: a.depositCents ?? depositCents(a.priceCents, offer.depositPercent),
        stripe_session: null,
        stripe_session_expires: null,
      },
    });
  });

/** Renvoie le lien de paiement, sans prolonger l'échéance. La clé de dédoublonnage porte l'heure : chaque renvoi part. */
export const resendPaymentLink = (deps: Deps, id: string): Promise<OpResult> =>
  withBooking(deps, id, (b) => {
    if (b.status !== "awaiting_deposit") return STALE;
    const now = deps.now();
    const notifications = plan("validated", b, now)
      .filter((n) => n.template === "client_deposit_link")
      .map((n) => ({ ...n, dedupe_key: `${n.dedupe_key}:${now.toISOString()}` }));
    return stay(deps, b, now, "payment_link_resent", { notifications });
  });

const MINUTE_MS = 60_000;
/** La date reste tenue ce temps après la fin d'une session : de quoi recevoir un paiement fait à la dernière minute. */
const SESSION_GRACE_MS = 5 * MINUTE_MS;

/**
 * Retient la session de paiement que le client vient d'ouvrir. La date est tenue jusqu'à 5 minutes après sa
 * fin si l'échéance tombait avant, jamais moins longtemps qu'avant. Rien n'est écrit si la réservation a
 * quitté `awaiting_deposit` : `stale`, et la session est à fermer.
 */
export const attachSession = (deps: Deps, id: string, session: StripeSession): Promise<OpResult> =>
  withBooking(deps, id, (b) => {
    if (b.status !== "awaiting_deposit") return STALE;
    const expiresAt = session.expiresAt * 1000;
    const heldUntil = new Date(expiresAt + SESSION_GRACE_MS).toISOString();
    return stay(deps, b, deps.now(), "payment_session_opened", {
      actor: "client",
      patch: {
        stripe_session: session.id,
        stripe_session_expires: new Date(expiresAt).toISOString(),
        hold_until: b.hold_until !== null && b.hold_until > heldUntil ? b.hold_until : heldUntil,
      },
    });
  });

/**
 * Remplace les notes du propriétaire (`null` les efface), à tout moment : elles ne changent ni l'état ni les
 * messages. Une réservation déjà anonymisée n'en reçoit plus, pour que ses données ne reviennent pas après l'effacement.
 */
export const editNotes = (deps: Deps, id: string, notes: string | null): Promise<OpResult> =>
  withBooking(deps, id, async (b) => {
    if (b.anonymized_at !== null) return STALE;
    return applied(await patchBooking(deps.env.DB, id, { notes }, "owner", "notes_updated", deps.now().toISOString()));
  });

export const markBalancePaid = (deps: Deps, id: string): Promise<OpResult> =>
  withBooking(deps, id, (b) => {
    if (b.status !== "confirmed") return STALE;
    const now = deps.now();
    return stay(deps, b, now, "balance_paid", { patch: { balance_paid_at: now.toISOString() } });
  });

/**
 * Enregistre une réservation du propriétaire. Le délai minimum ne s'applique pas, mais la date doit exister.
 * `plan` ne prévient personne pour une date bloquée.
 */
async function insertOwnerBooking(
  deps: Deps,
  status: "confirmed" | "blocked",
  date: string,
  fields: Partial<NewBooking>,
): Promise<OpResult> {
  if (!isValidDate(date)) return { ok: false, reason: "invalid" };
  const now = deps.now();
  const nowIso = now.toISOString();
  const booking = blankBooking({ event_date: date, status, source: "manual" }, fields);
  const specs = plan("manual_confirmed", { ...booking, created_at: nowIso, updated_at: nowIso }, now);
  return insertBooking(deps.env.DB, booking, specs, nowIso);
}

export type ManualInput = {
  date: string;
  name: string;
  phone?: string;
  email?: string;
  eventType?: string;
  venue?: string;
  hours?: string;
  priceCents: number;
  depositCents: number;
  notes?: string;
};

/** Une prestation confirmée pour un client qui appelle : acompte saisi à la main, pas encore encaissé en ligne. */
export const createManual = (deps: Deps, a: ManualInput): Promise<OpResult> =>
  insertOwnerBooking(deps, "confirmed", a.date, {
    client_name: a.name,
    client_phone: a.phone ?? null,
    client_email: a.email ?? null,
    event_type: a.eventType ?? null,
    venue: a.venue ?? null,
    event_hours: a.hours ?? null,
    price_cents: a.priceCents,
    deposit_cents: a.depositCents,
    notes: a.notes ?? null,
  });

/** Réserve une date pour le propriétaire (congés, par exemple). Elle se retire avec `cancelBooking`. */
export const blockDate = (deps: Deps, date: string, notes?: string): Promise<OpResult> =>
  insertOwnerBooking(deps, "blocked", date, { notes: notes ?? null });
