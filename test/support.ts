import { env } from "cloudflare:workers";
import { onTestFinished } from "vitest";
import { depositCents } from "../worker/bookings";
import type { Button, Deps, EmailMessage, StripeGateway, StripeSession } from "../worker/deps";
import { plan } from "../worker/notifications";
import { buildOffer, currentTier, offer, planById, priceOf, type Plan, type Tier } from "../worker/offer";
import { validateBooking } from "../worker/operations";
import {
  countTakenByTier,
  insertBooking,
  type Booking,
  type NewBooking,
  type NotificationRow,
  type NotificationSpec,
} from "../worker/repository";

/** L'instant « maintenant » de tous les tests. */
export const T0 = "2026-11-07T10:00:00.000Z";

/**
 * Deux formules de l'offre, lues dans `config/offer.json` : le propriétaire y change les noms, les identifiants et les prix,
 * et aucun test ne suppose les valeurs d'aujourd'hui.
 */
export const [FIRST_PLAN, SECOND_PLAN]: Plan[] = offer.plans;

/** L'acompte que l'offre prévoit pour ce prix, quel que soit son pourcentage. */
export const depositFor = (priceCents: number): number => depositCents(priceCents, offer.depositPercent);

const randomHex = (): string => crypto.randomUUID().replaceAll("-", "");

/** Une demande du site en attente de réponse, avec toutes les colonnes d'identité renseignées. */
export const newBooking = (over: Partial<NewBooking> = {}): NewBooking => ({
  id: crypto.randomUUID(),
  token: randomHex() + randomHex(),
  event_date: "2026-12-19",
  status: "pending_review",
  source: "site",
  plan: SECOND_PLAN.id,
  price_cents: 150_000,
  deposit_cents: 45_000,
  price_tier: null,
  refill_cents: null,
  client_name: "Camille Martin",
  client_email: "camille@example.test",
  client_phone: "0601020304",
  event_type: "Mariage",
  venue: "Domaine des Pins, Lyon",
  event_hours: "18h-02h",
  message: "Un fond rose, si possible.",
  ip_hash: "ip-hash-1",
  terms_version: "2026-11-07",
  hold_until: "2026-11-10T10:00:00.000Z",
  stripe_session: null,
  stripe_session_expires: null,
  deposit_paid_at: null,
  balance_paid_at: null,
  notes: "Rappeler avant la date.",
  anonymized_at: null,
  ...over,
});

/**
 * Le corps d'une demande du site, comme la page l'envoie. `price_cents` est le prix de la formule au palier en cours, lu
 * dans la base à l'appel : chaque demande enregistrée peut faire avancer le palier. Une formule inconnue prend le prix de
 * la première, pour que seul le champ `plan` soit refusé.
 */
export async function requestBody(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const chosen = (typeof over.plan === "string" && planById(over.plan)) || FIRST_PLAN;
  const { tier } = currentTier(offer, await countTakenByTier(env.DB));
  return {
    date: "2026-12-19", plan: FIRST_PLAN.id, event_type: "Mariage", event_hours: "19 h - 1 h",
    venue: "Salle des fêtes", name: "Camille Durand", phone: "06 12 34 56 78", email: "camille@example.test",
    terms: true, turnstile_token: "t", price_cents: priceOf(tier, chosen.id), ...over,
  };
}

/** Un palier d'essai : `cents` pour la première formule de l'offre, 1 000 centimes de plus à chaque suivante, la recharge au dixième. */
export const testTier = (id: string, cents: number, places?: number): Tier => ({
  id,
  name: `Palier ${id}`,
  ...(places === undefined ? {} : { places }),
  refillCents: cents / 10,
  prices: Object.fromEntries(offer.plans.map((plan, i) => [plan.id, cents + i * 1_000])),
});

/**
 * Remplace les paliers de l'offre le temps du test en cours, après les avoir fait vérifier par `buildOffer` : un test
 * remplit un palier sans rien supposer de ceux de `config/offer.json`.
 */
export function useTiers(...tiers: Tier[]): void {
  const real = offer.tiers;
  offer.tiers = buildOffer({ ...offer, plans: offer.plans.map(({ name: _name, ...plan }) => plan), tiers }).tiers;
  onTestFinished(() => {
    offer.tiers = real;
  });
}

export async function insert(nb: NewBooking): Promise<{ booking: Booking }> {
  const result = await insertBooking(env.DB, nb, [], T0);
  if (!result.ok) throw new Error(`insert: ${result.reason}`);
  return { booking: result.booking };
}

/** La réservation d'un autre client, qui prend une place de `tier`. */
export const takePlace = (tier: string, event_date = "2027-01-09"): Promise<{ booking: Booking }> =>
  insert(newBooking({ event_date, price_tier: tier, client_email: "autre@example.test" }));

/** Une demande du site telle que `createRequest` la laisse à `T0` : à valider, avec ses alertes en file. */
export async function request(over: Partial<NewBooking> = {}): Promise<Booking> {
  const nb = newBooking(over);
  const specs = plan("requested", { ...nb, created_at: T0, updated_at: T0 }, new Date(T0));
  const inserted = await insertBooking(env.DB, nb, specs, T0);
  if (!inserted.ok) throw new Error(`request: ${inserted.reason}`);
  return inserted.booking;
}

/** Une demande que le propriétaire vient de valider : en attente d'acompte, la date tenue 72 h depuis `deps.now()`. */
export async function validatedBooking(deps: Deps, over: Partial<NewBooking> = {}): Promise<Booking> {
  const result = await validateBooking(deps, (await request(over)).id, "owner");
  if (!result.ok) throw new Error(`validatedBooking: ${result.reason}`);
  return result.booking;
}

/** Un e-mail au propriétaire, dû à `T0`. */
export const spec = (key: string, bookingId?: string): NotificationSpec => ({
  booking_id: bookingId ?? null,
  dedupe_key: key,
  channel: "email",
  recipient: "owner",
  template: "test",
  due_at: T0,
});

/** Toutes les notifications, envoyées, annulées ou en attente, dans l'ordre de leur mise en file. */
export const notificationRows = async (): Promise<NotificationRow[]> =>
  (await env.DB.prepare("SELECT * FROM notifications ORDER BY id").all<NotificationRow>()).results;

/** Vide toutes les tables, les tables filles d'abord à cause des clés étrangères. */
export async function resetDb(db: D1Database): Promise<void> {
  await db.batch(
    ["notifications", "booking_history", "bookings", "system_state"].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
}

export type FakeStripe = StripeGateway & {
  sessions: Map<string, StripeSession>;
  /** Le client a payé : la session est terminée et payée. */
  completeSession(id: string): void;
  /** Le prochain appel de cette méthode lève une erreur, une seule fois. */
  failNext(method: keyof StripeGateway): void;
};

export type FakeDeps = Deps & {
  stripe: FakeStripe;
  emails: EmailMessage[];
  telegrams: { chatId: string; html: string; buttons: Button[][] | undefined }[];
  edits: { chatId: string; messageId: number; html: string; buttons: Button[][] | undefined }[];
  /** Identifiants des rappels de bouton auxquels le bot a répondu. */
  answers: string[];
  answerTexts: (string | undefined)[];
  setNow(iso: string): void;
};

/** Une doublure de Stripe en mémoire : les sessions vivent dans `sessions` et les pannes se déclenchent à la demande. */
function fakeStripe(): FakeStripe {
  const sessions = new Map<string, StripeSession>();
  const failing = new Set<keyof StripeGateway>();
  let lastId = 0;

  const session = (id: string): StripeSession => {
    const found = sessions.get(id);
    if (!found) throw new Error(`session inconnue : ${id}`);
    return found;
  };
  const close = (id: string, patch: Partial<StripeSession>) => {
    sessions.set(id, { ...session(id), ...patch, url: null });
  };
  const gateway = <A extends unknown[], R>(method: keyof StripeGateway, run: (...args: A) => R) =>
    async (...args: A): Promise<Awaited<R>> => {
      if (failing.delete(method)) throw new Error(`stripe.${method} : panne simulée`);
      return await run(...args);
    };

  return {
    sessions,
    completeSession: (id) => close(id, { status: "complete", paymentStatus: "paid" }),
    failNext: (method) => {
      failing.add(method);
    },
    createSession: gateway("createSession", (a) => {
      const id = `cs_${++lastId}`;
      const created: StripeSession = {
        id,
        url: `https://checkout.stripe.test/c/pay/${id}`,
        status: "open",
        paymentStatus: "unpaid",
        expiresAt: a.expiresAt,
        bookingId: a.bookingId,
      };
      sessions.set(id, created);
      return { ...created };
    }),
    retrieveSession: gateway("retrieveSession", (id) => ({ ...session(id) })),
    // Fermer une session qui n'est plus ouverte ne change rien : le plus simple pour les tests.
    expireSession: gateway("expireSession", (id) => {
      if (session(id).status === "open") close(id, { status: "expired" });
    }),
    // Le corps d'un faux webhook est `{ type, sessionId }`; la signature « invalid » est refusée.
    verifyWebhook: gateway("verifyWebhook", (rawBody: string, signature: string) => {
      if (signature === "invalid") throw new Error("signature invalide");
      const { type, sessionId } = JSON.parse(rawBody) as { type: string; sessionId?: string };
      const found = sessionId === undefined ? undefined : sessions.get(sessionId);
      return { type, session: found ? { ...found } : null };
    }),
  };
}

/** Les destinataires du propriétaire dans les tests : l'environnement de test n'en définit aucun. */
export const OWNER_EMAIL = "proprietaire@example.test";
export const CHAT_ID = "111";

/**
 * Les dépendances des tests : environnement réel (avec un propriétaire joignable par e-mail et par Telegram),
 * horloge à `T0`, propriétaire et Turnstile passants, et tout ce que les passerelles reçoivent consigné dans
 * les listes retournées.
 */
export function fakeDeps({ env: given, ...over }: Partial<Deps> = {}): FakeDeps {
  let current = new Date(T0);
  const emails: EmailMessage[] = [];
  const telegrams: FakeDeps["telegrams"] = [];
  const edits: FakeDeps["edits"] = [];
  const answers: string[] = [];
  const answerTexts: (string | undefined)[] = [];

  const base: FakeDeps = {
    env: { ...env, OWNER_EMAIL, FROM_EMAIL: "reservations@example.test", TELEGRAM_CHAT_IDS: CHAT_ID, ...given },
    now: () => new Date(current),
    setNow: (iso) => {
      current = new Date(iso);
    },
    stripe: fakeStripe(),
    email: {
      send: async (m) => {
        emails.push(m);
      },
    },
    telegram: {
      send: async (chatId, html, buttons) => {
        telegrams.push({ chatId, html, buttons });
      },
      edit: async (chatId, messageId, html, buttons) => {
        edits.push({ chatId, messageId, html, buttons });
      },
      answer: async (callbackId, text) => {
        answers.push(callbackId);
        answerTexts.push(text);
      },
    },
    verifyTurnstile: async () => "pass",
    isOwner: () => true,
    emails,
    telegrams,
    edits,
    answers,
    answerTexts,
  };
  return Object.assign(base, over);
}

/**
 * Les dépendances des tests, où `meanwhile` s'exécute une fois, juste avant la première écriture groupée dans la base :
 * une autre réservation arrive entre la lecture du palier et l'insertion.
 */
export function racingDeps(meanwhile: () => Promise<unknown>): FakeDeps {
  let pending: (() => Promise<unknown>) | null = meanwhile;
  const DB = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const run = pending;
      pending = null;
      await run?.();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  return fakeDeps({ env: { ...env, DB } });
}

/**
 * Rend la doublure aussi stricte que le vrai Stripe sur un point que `fakeDeps` laisse passer : expirer une
 * session qui n'est plus ouverte (payée, expirée) lève au lieu de ne rien faire.
 */
export function strictStripe(d: FakeDeps): void {
  const expire = d.stripe.expireSession;
  d.stripe.expireSession = async (id) => {
    if (d.stripe.sessions.get(id)?.status !== "open") throw new Error("Stripe : la session n'est plus ouverte");
    await expire(id);
  };
}
