import { parisToday, reminderAt, type BookingStatus } from "./bookings";
import type { Deps } from "./deps";
import { chatIds } from "./env";
import { sha256Hex } from "./http";
import { offer } from "./offer";
import {
  cancelNotification,
  claimNotification,
  enqueue,
  getBooking,
  getContactMessage,
  listDueNotifications,
  listUpcoming,
  markFailed,
  markSent,
  type Booking,
  type NotificationRow,
  type NotificationSpec,
} from "./repository";
import { renderEmail, renderTelegram, type MessageContext } from "./templates";

/**
 * Les modèles de message de la spec (section 5) et de la rubrique de contact (section 3), partagés par la planification,
 * l'envoi et les tests.
 */
export const ALL_TEMPLATES = [
  "client_received",
  "client_refused",
  "client_deposit_link",
  "client_deposit_reminder",
  "client_confirmed",
  "client_released",
  "client_unanswered",
  "client_cancelled",
  "client_d7",
  "owner_new_request",
  "owner_review_reminder",
  "owner_deposit_paid",
  "owner_released",
  "owner_d7",
  "owner_d1",
  "owner_digest",
  "owner_late_payment",
  "owner_email_failed",
  "owner_contact",
  "owner_contact_failed",
] as const;

export type Template = (typeof ALL_TEMPLATES)[number];

export type PlanEvent =
  | "requested"
  | "validated"
  | "refused"
  | "paid"
  | "manual_confirmed"
  | "released"
  | "cancelled";

type Channel = NotificationSpec["channel"];
type Draft = { template: Template; channels: readonly Channel[]; due: Date; mark?: string };

const HOUR_MS = 3_600_000;
const EMAIL: readonly Channel[] = ["email"];
const TELEGRAM: readonly Channel[] = ["telegram"];
const BOTH: readonly Channel[] = ["telegram", "email"];

/** Relances du propriétaire sans réponse, en heures après l'arrivée de la demande. */
const REVIEW_REMINDER_HOURS = [24, 48];
/** Rappel du délai d'acompte, en heures avant l'échéance. */
const DEPOSIT_REMINDER_LEAD_HOURS = 24;

const hoursFrom = (from: Date | string, hours: number): Date =>
  new Date(new Date(from).getTime() + hours * HOUR_MS);

const draft = (template: Template, channels: readonly Channel[], due: Date, mark?: string): Draft => ({
  template,
  channels,
  due,
  mark,
});

const recipientOf = (template: Template): NotificationSpec["recipient"] =>
  template.startsWith("client_") ? "client" : "owner";

/** Les rappels de J-7 et de J-1, à l'heure de rappel de Paris. */
function eventReminders(b: Booking): Draft[] {
  const at = (daysBefore: number) => reminderAt(b.event_date, daysBefore);
  return [draft("owner_d7", BOTH, at(7)), draft("client_d7", EMAIL, at(7)), draft("owner_d1", BOTH, at(1))];
}

function drafts(event: PlanEvent, b: Booking, now: Date): Draft[] {
  switch (event) {
    case "requested":
      return [
        draft("client_received", EMAIL, now),
        draft("owner_new_request", BOTH, now),
        ...REVIEW_REMINDER_HOURS.map((h) => draft("owner_review_reminder", TELEGRAM, hoursFrom(now, h), `${h}h`)),
      ];
    case "validated":
      return [
        draft("client_deposit_link", EMAIL, now),
        ...(b.hold_until
          ? [draft("client_deposit_reminder", EMAIL, hoursFrom(b.hold_until, -DEPOSIT_REMINDER_LEAD_HOURS))]
          : []),
      ];
    case "refused":
      return [draft("client_refused", EMAIL, now)];
    case "paid":
      return [
        draft("client_confirmed", EMAIL, now),
        draft("owner_deposit_paid", BOTH, now),
        ...eventReminders(b),
      ];
    case "manual_confirmed":
      return eventReminders(b);
    case "released":
      // `b` est la réservation d'avant la libération : le client n'a pas à s'entendre dire que le délai est passé quand c'est nous qui n'avons pas répondu.
      return [draft(b.status === "pending_review" ? "client_unanswered" : "client_released", EMAIL, now), draft("owner_released", BOTH, now)];
    case "cancelled":
      return [draft("client_cancelled", EMAIL, now)];
  }
}

/**
 * Les notifications à mettre en file pour un événement, clés `b<id>:<modèle>[:<repère>]:<canal>`.
 * Pour `cancelled`, `b` est la réservation avant l'annulation : une date bloquée ne prévient personne. Pour `released`,
 * c'est la réservation avant la libération : le message au client diffère selon qu'il n'a pas payé ou que nous n'avons pas répondu.
 * Rien pour le client sans e-mail ni pour un rappel dont l'heure est déjà passée.
 */
export function plan(event: PlanEvent, b: Booking, now: Date): NotificationSpec[] {
  if (b.status === "blocked") return [];
  return drafts(event, b, now)
    .filter((d) => d.due.getTime() >= now.getTime() && (recipientOf(d.template) === "owner" || !!b.client_email))
    .flatMap((d) =>
      d.channels.map((channel) => ({
        booking_id: b.id,
        dedupe_key: `b${b.id}:${d.template}${d.mark ? `:${d.mark}` : ""}:${channel}`,
        channel,
        recipient: recipientOf(d.template),
        template: d.template,
        due_at: d.due.toISOString(),
      })),
    );
}

/** L'état que doit avoir la réservation pour qu'un rappel ait encore un sens. */
const REQUIRED_STATUS: ReadonlyMap<string, BookingStatus> = new Map([
  ["owner_review_reminder", "pending_review"],
  ["client_deposit_reminder", "awaiting_deposit"],
  ["owner_d7", "confirmed"],
  ["owner_d1", "confirmed"],
  ["client_d7", "confirmed"],
]);

/** `false` pour un rappel devenu inutile. Sans réservation (le point du lundi), tout modèle est pertinent. */
export const isRelevant = (template: string, b: Booking | null): boolean => {
  const required = REQUIRED_STATUS.get(template);
  return b === null || required === undefined || b.status === required;
};

// ---------- l'envoi ----------

const DEFAULT_LIMIT = 50;
/**
 * Un passage réserve un envoi pour ce temps : plus long qu'un envoi (les appels sortants sont bornés à 10 s), plus court
 * que la tâche automatique (5 minutes), qui reprend donc ce qu'un passage interrompu a laissé.
 */
const CLAIM_LEASE_MS = 2 * 60_000;
/** Un échec met en file une suite (alerte, message de secours) qui peut elle-même échouer : trois tours suffisent. */
const MAX_ROUNDS = 3;
/** À partir de ce nombre d'échecs d'un e-mail au client, ou de celui d'un message de contact, le propriétaire est alerté. */
const ALERT_AFTER_FAILURES = 3;
const MAX_ERROR_LENGTH = 200;
const UPCOMING_STATUSES: readonly BookingStatus[] = ["pending_review", "awaiting_deposit", "confirmed"];

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "erreur inconnue");

/** Une panne se consigne par le numéro, le modèle et le nom de l'erreur : jamais son message, qui peut citer un client. */
const report = (n: Pick<NotificationRow, "id" | "template">, error: unknown): void =>
  console.error(`Notification ${n.id} (${n.template}) : ${errorName(error)}`);

const errorSummary = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}`.slice(0, MAX_ERROR_LENGTH) : "erreur inconnue";

/** Les 16 premiers caractères hexadécimaux de l'empreinte : de quoi distinguer deux contenus, sans citer le message. */
const FINGERPRINT_LENGTH = 16;

/** L'adresse du propriétaire : le message du formulaire de contact va à l'adresse de contact de l'offre quand elle existe, tout le reste à `OWNER_EMAIL`. */
const ownerAddress = (deps: Deps, n: NotificationRow): string | undefined =>
  (n.template === "owner_contact" && offer.contact.email) || deps.env.OWNER_EMAIL;

/**
 * La clé de dédoublonnage accompagne l'e-mail : Resend n'enverra pas deux fois un message que sa reprise répète. Resend
 * refuse aussi une clé réutilisée avec un autre contenu : la clé porte donc l'empreinte de ce qui est envoyé (objet, texte
 * et HTML rendus). Une réservation modifiée entre deux tentatives repart sous une clé neuve, au lieu de rester bloquée.
 */
async function sendEmail(deps: Deps, n: NotificationRow, booking: Booking | null, context: MessageContext): Promise<void> {
  const message = renderEmail(n.template, booking, context);
  const to = n.recipient === "owner" ? ownerAddress(deps, n) : booking?.client_email;
  if (!to) throw new Error("adresse du destinataire manquante");
  const fingerprint = (await sha256Hex(JSON.stringify([message.subject, message.text, message.html]))).slice(0, FINGERPRINT_LENGTH);
  await deps.email.send({ to, ...message, idempotencyKey: `${n.dedupe_key}:${fingerprint}` });
}

/**
 * Le message part à chaque chat configuré, l'un après l'autre. Un chat qui répond a livré le message : le renvoyer
 * aux autres au passage suivant le doublerait, d'où l'échec seulement quand aucun chat ne répond.
 */
async function sendTelegram(deps: Deps, n: NotificationRow, booking: Booking | null, context: MessageContext): Promise<void> {
  const { html, buttons } = renderTelegram(n.template, booking, context);
  const chats = chatIds(deps.env);
  const failures: unknown[] = [];
  for (const chat of chats) {
    try {
      await deps.telegram.send(chat, html, buttons);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === chats.length) throw failures[0] ?? new Error("aucun chat Telegram configuré");
  for (const error of failures) report(n, error);
}

/** `followUp` : un message de secours ou une alerte a été mis en file, à envoyer dans le même appel. */
type Outcome = { status: "sent" | "failed" | "skipped"; followUp?: true };

/**
 * L'alerte Telegram due au troisième échec de l'e-mail `n`, ou `null`. Seul l'e-mail qui porte le message de contact
 * alerte : l'e-mail de secours de l'alerte, qui porte aussi ce message, n'en appelle pas une autre.
 */
const alertFor = (n: NotificationRow): Template | null => {
  if (n.recipient === "client") return "owner_email_failed";
  return n.template === "owner_contact" ? "owner_contact_failed" : null;
};

/**
 * Note l'échec de `n` (son `attempts`-ième essai), puis met en file ce qui doit suivre, dû tout de suite : un
 * e-mail au propriétaire quand Telegram échoue, une alerte Telegram quand l'e-mail au client, ou celui d'un message de
 * contact, échoue pour la troisième fois. Les clés `<clé>:fallback` et `<clé>:alert` font que la suite n'est mise en
 * file qu'une fois. Une suite porte le message de contact de `n` : effacer le message l'efface aussi.
 * Rend `true` si une suite a été mise en file.
 */
async function settleFailure(deps: Deps, n: NotificationRow, attempts: number, error: unknown): Promise<boolean> {
  const db = deps.env.DB;
  await markFailed(db, n.id, errorSummary(error));
  const followUp = (suffix: string, channel: NotificationSpec["channel"], template: string): NotificationSpec => ({
    booking_id: n.booking_id,
    contact_id: n.contact_id,
    dedupe_key: `${n.dedupe_key}:${suffix}`,
    channel,
    recipient: "owner",
    template,
    due_at: deps.now().toISOString(),
  });
  if (n.channel === "telegram") {
    await enqueue(db, [followUp("fallback", "email", n.template)]);
    return true;
  }
  const alert = alertFor(n);
  if (alert !== null && attempts >= ALERT_AFTER_FAILURES) {
    await enqueue(db, [followUp("alert", "telegram", alert)]);
    return true;
  }
  return false;
}

/**
 * Un envoi : le message est rendu d'après la réservation à jour (ou le message de contact qu'il porte), l'envoi est
 * réservé (aucun autre passage ne le prend, et l'essai est compté), puis le message part. `skipped` quand il n'y a rien à
 * envoyer : le rappel est devenu inutile (la réservation a changé d'état depuis sa mise en file) ou le message de contact
 * a été effacé, et l'envoi est annulé sans échec ; ou un autre passage a réservé l'envoi. Ne lève jamais : un échec est
 * noté, et reste en file pour le passage suivant.
 */
async function deliver(deps: Deps, n: NotificationRow): Promise<Outcome> {
  const db = deps.env.DB;
  const now = deps.now();
  let attempts = n.attempts + 1;
  try {
    const booking = n.booking_id === null ? null : await getBooking(db, n.booking_id);
    const contact = n.contact_id === null ? null : await getContactMessage(db, n.contact_id);
    const erased = n.contact_id !== null && contact === null;
    if (erased || !isRelevant(n.template, booking)) {
      await cancelNotification(db, n.id, now.toISOString());
      return { status: "skipped" };
    }
    const claimed = await claimNotification(db, n.id, now.toISOString(), new Date(now.getTime() + CLAIM_LEASE_MS).toISOString());
    if (claimed === null) return { status: "skipped" };
    attempts = claimed;

    const context: MessageContext = {
      baseUrl: deps.env.BASE_URL,
      upcoming: n.template === "owner_digest" ? await listUpcoming(db, parisToday(now), UPCOMING_STATUSES) : undefined,
      contact: contact ?? undefined,
    };
    await (n.channel === "email" ? sendEmail(deps, n, booking, context) : sendTelegram(deps, n, booking, context));
    await markSent(db, n.id, now.toISOString());
    return { status: "sent" };
  } catch (error) {
    report(n, error);
    const followUp = await settleFailure(deps, n, attempts, error).catch((bookkeeping) => {
      report(n, bookkeeping);
      return false;
    });
    return followUp ? { status: "failed", followUp } : { status: "failed" };
  }
}

/**
 * Envoie les notifications échues, les plus anciennes d'abord (`limit` au plus par tour). Chacune a son propre
 * filet : une panne n'arrête pas les suivantes, et reste en file pour le passage suivant. Les suites d'un échec
 * (message de secours, alerte) sont envoyées dans le même appel. Des passages simultanés, celui de la tâche
 * automatique et ceux qui suivent une demande, n'envoient jamais le même message deux fois.
 */
export async function processDue(deps: Deps, limit = DEFAULT_LIMIT): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  const handled = new Set<number>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const due = (await listDueNotifications(deps.env.DB, deps.now().toISOString(), limit)).filter((n) => !handled.has(n.id));
    let followUps = false;
    for (const n of due) {
      handled.add(n.id);
      const outcome = await deliver(deps, n);
      if (outcome.status !== "skipped") result[outcome.status]++;
      followUps ||= outcome.followUp === true;
    }
    if (!followUps) break;
  }
  return result;
}

/**
 * Envoie sans attendre la tâche automatique, une fois la réponse partie. Ce qui échoue reste en file : l'appelant
 * n'a rien à gérer, et une demande ou un paiement déjà enregistré ne se perd jamais à cause d'un envoi.
 */
export function sendSoon(ctx: ExecutionContext, deps: Deps): void {
  ctx.waitUntil(processDue(deps).catch((error) => console.error(`Envoi immédiat : ${errorName(error)}`)));
}
