import { addDays, parisInstant, type BookingStatus } from "./bookings";
import { offer } from "./offer";
import type { Booking, NotificationSpec } from "./repository";

/** Les modèles de message de la spec (section 5), partagés par la planification, l'envoi et les tests. */
export const ALL_TEMPLATES = [
  "client_received",
  "client_refused",
  "client_deposit_link",
  "client_deposit_reminder",
  "client_confirmed",
  "client_released",
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
  const at = (daysBefore: number) => parisInstant(addDays(b.event_date, -daysBefore), offer.reminderHourParis);
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
      return [draft("client_released", EMAIL, now), draft("owner_released", BOTH, now)];
    case "cancelled":
      return [draft("client_cancelled", EMAIL, now)];
  }
}

/**
 * Les notifications à mettre en file pour un événement, clés `b<id>:<modèle>[:<repère>]:<canal>`.
 * Pour `cancelled`, `b` est la réservation avant l'annulation : une date bloquée ne prévient personne.
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
