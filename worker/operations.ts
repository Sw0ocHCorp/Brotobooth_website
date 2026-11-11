import { checkDate, depositCents, isValidDate, nextStatus, type BookingAction, type BookingStatus } from "./bookings";
import type { Deps, StripeGateway, StripeSession } from "./deps";
import { plan, type PlanEvent } from "./notifications";
import { sha256Hex, toHex } from "./http";
import { currentTier, offer, planById, priceOf, type CurrentTier } from "./offer";
import {
  applyTransition,
  countActiveByEmail,
  countRecentByIp,
  countTakenByTier,
  findActiveByDateAndEmail,
  getBooking,
  insertBooking,
  listUnavailableDates,
  patchBooking,
  type Booking,
  type NewBooking,
  type TierCap,
  type Transition,
} from "./repository";

export type RequestInput = {
  date: string;
  plan: string;
  /** Le prix que la page a montré pour la formule, en centimes. */
  price_cents: number;
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

/**
 * `too_many` : trop de demandes en cours pour cette adresse e-mail, ou trop de demandes parties de cette connexion en 24 h.
 * `price_changed` : le prix de la formule n'est plus celui que le client a vu ; `priceCents` est le prix du moment.
 */
export type CreateRequestResult =
  | { kind: "created" | "already_requested"; booking: Booking }
  | { kind: "date_taken" | "bot" }
  | { kind: "too_many"; reason: "email" | "ip" }
  | { kind: "price_changed"; priceCents: number }
  | { kind: "invalid"; fields: string[] };

const HOUR_MS = 3_600_000;
/** Un prix ou un acompte, en centimes : 100 000 €, bien au-delà de toute prestation. */
const MAX_CENTS = 10_000_000;

const PHONE = /^[0-9 +.()-]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 256 bits aléatoires, pour les liens que seul le client connaît. */
const randomToken = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** L'empreinte salée d'une adresse IP : de quoi la compter, pas de quoi la retrouver. */
export const hashIp = (salt: string, ip: string): Promise<string> => sha256Hex(salt + ip);

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
  price_tier: null,
  refill_cents: null,
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
  price_cents: (value) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CENTS ? value : null),
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
export async function checkTurnstile(deps: Deps, token: string, ip: string | null) {
  try {
    return await deps.verifyTurnstile(token, ip);
  } catch (error) {
    console.error(`Turnstile : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    return "unavailable";
  }
}

/** Le palier en cours, d'après les places déjà prises. */
export const readCurrentTier = async (db: D1Database): Promise<CurrentTier> => currentTier(offer, await countTakenByTier(db));

/**
 * Insère `booking` et les messages de `event`. Avec `current`, la réservation prend une place de ce palier, dont le tarif
 * de recharge est figé avec elle, et un palier de lancement déjà plein refuse l'insertion (`tier_full`). Sans lui (une
 * date bloquée), elle n'en prend aucune. Une date prise passe avant un palier plein.
 */
async function insertAtTier(
  deps: Deps,
  booking: NewBooking,
  event: PlanEvent,
  now: Date,
  current?: CurrentTier,
): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "date_taken" | "tier_full" }> {
  const db = deps.env.DB;
  const nowIso = now.toISOString();
  const placed = current ? { ...booking, price_tier: current.tier.id, refill_cents: current.tier.refillCents } : booking;
  const cap: TierCap | undefined = current?.launch ? { tier: current.tier.id, places: current.tier.places! } : undefined;
  const inserted = await insertBooking(db, placed, plan(event, { ...placed, created_at: nowIso, updated_at: nowIso }, now), nowIso, cap);
  // Un palier plein n'écrit rien : l'index des dates n'a pas joué, et une date prise entre-temps reste à vérifier.
  const dateTaken = !inserted.ok && inserted.reason === "tier_full" && (await listUnavailableDates(db, booking.event_date, booking.event_date)).length > 0;
  return dateTaken ? { ok: false, reason: "date_taken" } : inserted;
}

/** `price_changed` si le prix de la formule au palier `current` n'est plus celui que la page a montré, sinon `null`. */
function priceChanged({ tier }: CurrentTier, request: RequestInput): CreateRequestResult | null {
  const priceCents = priceOf(tier, request.plan);
  return priceCents === request.price_cents ? null : { kind: "price_changed", priceCents };
}

/**
 * Enregistre la demande d'un client : champs, doublon, prix, Turnstile, limites, puis insertion qui tient la date et
 * prend une place du palier en cours. Un même envoi répété donne `already_requested`, y compris quand deux envois se
 * croisent. Le client paie le prix qu'il a vu : sinon `price_changed`, et rien n'est enregistré.
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

  // Avant Turnstile aussi : le client renvoie sa demande au nouveau prix, avec un nouveau jeton.
  let current = await readCurrentTier(db);
  const changed = priceChanged(current, request);
  if (changed) return changed;

  if ((await checkTurnstile(deps, request.turnstile_token, ip)) === "fail") return { kind: "bot" };

  // Sans sel, une empreinte se retrouverait par essais : mieux vaut n'en garder aucune, et sauter la limite par adresse.
  const salt = deps.env.IP_HASH_SALT;
  const ipHash = ip && salt ? await hashIp(salt, ip) : null;
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  // L'adresse e-mail d'abord : ses demandes en cours sont ce que le client peut résoudre, la connexion partagée non.
  if ((await countActiveByEmail(db, request.email)) >= offer.maxActivePerEmail) return { kind: "too_many", reason: "email" };
  if (ipHash !== null && (await countRecentByIp(db, ipHash, dayAgo)) >= offer.maxPerIpPer24h) return { kind: "too_many", reason: "ip" };

  const booking = blankBooking(
    { event_date: request.date, status: "pending_review", source: "site" },
    {
      plan: request.plan,
      price_cents: request.price_cents,
      deposit_cents: depositCents(request.price_cents, offer.depositPercent),
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
  // Seul un palier plein refuse l'insertion : le palier en cours avance alors, et le dernier, sans limite, ne refuse jamais.
  for (let tries = 0; tries < offer.tiers.length; tries++) {
    const inserted = await insertAtTier(deps, booking, "requested", now, current);
    if (inserted.ok) return { kind: "created", booking: inserted.booking };
    // Un envoi identique, arrivé en même temps, vient de prendre la date ou la dernière place : pour ce client, c'est une réussite.
    const winner = await findTwin();
    if (winner) return { kind: "already_requested", booking: winner };
    if (inserted.reason === "date_taken") return { kind: "date_taken" };
    // Le palier s'est rempli depuis la lecture : au même prix, la demande prend place au suivant.
    current = await readCurrentTier(db);
    const changedSince = priceChanged(current, request);
    if (changedSince) return changedSince;
  }
  throw new Error("createRequest : le palier en cours n'avance plus");
}

export type Actor = "client" | "owner" | "system" | "stripe";

/** `tier_changed` : le palier s'est rempli pendant l'ajout, le prix proposé au propriétaire n'est peut-être plus le bon. */
export type OpResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "not_found" | "stale" | "date_taken" | "tier_changed" | "invalid" };

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
 * Une prestation prend une place du palier en cours ; une date bloquée n'en prend pas, et `plan` n'y prévient personne.
 * `shownTier`, le palier que le formulaire a montré, doit être encore le palier en cours : sinon `tier_changed`.
 */
async function insertOwnerBooking(
  deps: Deps,
  status: "confirmed" | "blocked",
  date: string,
  fields: Partial<NewBooking>,
  shownTier?: string,
): Promise<OpResult> {
  if (!isValidDate(date)) return { ok: false, reason: "invalid" };
  const current = status === "confirmed" ? await readCurrentTier(deps.env.DB) : undefined;
  if (shownTier !== undefined && shownTier !== current?.tier.id) return { ok: false, reason: "tier_changed" };
  const booking = blankBooking({ event_date: date, status, source: "manual" }, fields);
  const inserted = await insertAtTier(deps, booking, "manual_confirmed", deps.now(), current);
  return inserted.ok ? inserted : { ok: false, reason: inserted.reason === "tier_full" ? "tier_changed" : inserted.reason };
}

export type ManualInput = {
  date: string;
  name: string;
  /** La formule, si le propriétaire en a choisi une ; sans elle, le prix est libre. */
  plan?: string;
  /** Le palier que le formulaire a montré, dont il a proposé le prix. */
  tier?: string;
  phone?: string;
  email?: string;
  eventType?: string;
  venue?: string;
  hours?: string;
  priceCents: number;
  depositCents: number;
  notes?: string;
};

/** Une prestation confirmée pour un client qui appelle : prix et acompte saisis à la main, pas encore encaissés en ligne. */
export const createManual = (deps: Deps, a: ManualInput): Promise<OpResult> =>
  insertOwnerBooking(
    deps,
    "confirmed",
    a.date,
    {
      plan: a.plan ?? null,
      client_name: a.name,
      client_phone: a.phone ?? null,
      client_email: a.email ?? null,
      event_type: a.eventType ?? null,
      venue: a.venue ?? null,
      event_hours: a.hours ?? null,
      price_cents: a.priceCents,
      deposit_cents: a.depositCents,
      notes: a.notes ?? null,
    },
    a.tier,
  );

/** Réserve une date pour le propriétaire (congés, par exemple). Elle se retire avec `cancelBooking`. */
export const blockDate = (deps: Deps, date: string, notes?: string): Promise<OpResult> =>
  insertOwnerBooking(deps, "blocked", date, { notes: notes ?? null });
