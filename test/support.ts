import { env } from "cloudflare:workers";
import type { Button, Deps, EmailMessage, StripeGateway, StripeSession } from "../worker/deps";
import { plan } from "../worker/notifications";
import { validateBooking } from "../worker/operations";
import {
  insertBooking,
  type Booking,
  type NewBooking,
  type NotificationSpec,
} from "../worker/repository";

/** L'instant « maintenant » de tous les tests. */
export const T0 = "2026-11-07T10:00:00.000Z";

const randomHex = (): string => crypto.randomUUID().replaceAll("-", "");

/** Une demande du site en attente de réponse, avec toutes les colonnes d'identité renseignées. */
export const newBooking = (over: Partial<NewBooking> = {}): NewBooking => ({
  id: crypto.randomUUID(),
  token: randomHex() + randomHex(),
  event_date: "2026-12-19",
  status: "pending_review",
  source: "site",
  plan: "formule-2",
  price_cents: 150_000,
  deposit_cents: 45_000,
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

export async function insert(nb: NewBooking): Promise<{ booking: Booking }> {
  const result = await insertBooking(env.DB, nb, [], T0);
  if (!result.ok) throw new Error(`insert: ${result.reason}`);
  return { booking: result.booking };
}

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

/**
 * Les dépendances des tests : environnement réel, horloge à `T0`, propriétaire et Turnstile passants,
 * et tout ce que les passerelles reçoivent consigné dans les listes retournées.
 */
export function fakeDeps(over: Partial<Deps> = {}): FakeDeps {
  let current = new Date(T0);
  const emails: EmailMessage[] = [];
  const telegrams: FakeDeps["telegrams"] = [];
  const edits: FakeDeps["edits"] = [];
  const answers: string[] = [];
  const answerTexts: (string | undefined)[] = [];

  const base: FakeDeps = {
    env,
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
