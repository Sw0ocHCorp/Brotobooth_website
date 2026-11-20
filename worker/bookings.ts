import { hasDeposit, offer } from "./offer";

export type BookingStatus =
  | "pending_review"
  | "awaiting_deposit"
  | "confirmed"
  | "blocked"
  | "refused"
  | "expired"
  | "cancelled";

export type BookingAction = "validate" | "refuse" | "pay" | "expire" | "cancel";

/** Les états qui tiennent une date. */
export const ACTIVE_STATUSES: readonly BookingStatus[] = [
  "pending_review",
  "awaiting_deposit",
  "confirmed",
  "blocked",
];

/**
 * Les données personnelles d'une réservation sont effacées 5 ans après son événement, quel que soit son état : le délai
 * pendant lequel un litige peut naître du contrat (article 2224 du Code civil). La tâche automatique l'applique
 * (`worker/cron.ts`) et la politique de confidentialité l'annonce.
 */
export const EVENT_RETENTION_YEARS = 5;

const TRANSITIONS: Record<BookingStatus, Partial<Record<BookingAction, BookingStatus>>> = {
  pending_review: { validate: "awaiting_deposit", refuse: "refused", expire: "expired" },
  awaiting_deposit: { pay: "confirmed", expire: "expired", cancel: "cancelled" },
  confirmed: { cancel: "cancelled" },
  blocked: { cancel: "cancelled" },
  refused: {},
  expired: {},
  cancelled: {},
};

/** État suivant, ou `null` si l'action est interdite depuis cet état. */
export const nextStatus = (status: BookingStatus, action: BookingAction): BookingStatus | null =>
  status === "pending_review" && action === "validate" && !hasDeposit() ? "confirmed" : (TRANSITIONS[status][action] ?? null);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const PARIS_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** Date et heure affichées à Paris à cet instant, lues comme si elles étaient en UTC. */
function parisWall(instant: Date): Date {
  const parts: Record<string, number> = {};
  for (const { type, value } of PARIS_CLOCK.formatToParts(instant)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  );
}

const isoDate = (instant: Date): string => instant.toISOString().slice(0, 10);

export const parisToday = (now: Date): string => isoDate(parisWall(now));

export const parisHour = (now: Date): number => parisWall(now).getUTCHours();

/** Jour de la semaine à Paris : lundi = 1, dimanche = 7. */
export const parisWeekday = (now: Date): number => parisWall(now).getUTCDay() || 7;

/** Les dates sont des jours `YYYY-MM-DD` à Paris, sans heure ni fuseau. */
export const addDays = (date: string, days: number): string =>
  isoDate(new Date(Date.parse(date) + days * DAY_MS));

/** Ajoute des mois en ramenant le jour au dernier du mois d'arrivée s'il n'y existe pas. */
export function addMonths(date: string, months: number): string {
  const start = new Date(date);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months + 1, 0));
  target.setUTCDate(Math.min(start.getUTCDate(), target.getUTCDate()));
  return isoDate(target);
}

const parisOffsetMs = (instant: number): number =>
  parisWall(new Date(instant)).getTime() - instant;

/** Instant UTC où l'horloge de Paris indique `hour` h ce jour-là, été comme hiver. */
export function parisInstant(date: string, hour: number): Date {
  const wall = Date.parse(date) + hour * HOUR_MS;
  const estimate = wall - parisOffsetMs(wall);
  // L'écart a pu changer entre `wall` et l'instant estimé : on le mesure une seconde fois.
  return new Date(wall - parisOffsetMs(estimate));
}

/** Le rappel envoyé `daysBefore` jours avant l'événement du `date`, à l'heure de rappel de Paris. */
export const reminderAt = (date: string, daysBefore: number): Date => parisInstant(addDays(date, -daysBefore), offer.reminderHourParis);

/** `AAAA-MM-JJ` qui existe au calendrier. */
export function isValidDate(date: string): boolean {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date) : null;
  return day !== null && !Number.isNaN(day.getTime()) && isoDate(day) === date;
}

/** La première et la dernière date réservables à cet instant. */
export function bookingWindow(now: Date): { earliest: string; latest: string } {
  const today = parisToday(now);
  return { earliest: addDays(today, offer.minLeadDays), latest: addMonths(today, offer.horizonMonths) };
}

export function checkDate(date: string, now: Date): "ok" | "too_soon" | "too_far" | "invalid" {
  if (!isValidDate(date)) return "invalid";
  const { earliest, latest } = bookingWindow(now);
  if (date < earliest) return "too_soon";
  if (date > latest) return "too_far";
  return "ok";
}

/** Acompte arrondi à l'euro le plus proche, le demi-euro vers le haut. */
export const depositCents = (priceCents: number, percent: number): number =>
  Math.round((priceCents * percent) / 10_000) * 100;

/** `true` si cette réservation a un acompte : c'est elle, et non le réglage du jour, qui décide de ce que disent ses messages. */
export const hasBookingDeposit = (b: { deposit_cents: number | null }): boolean => (b.deposit_cents ?? 0) > 0;

// ---------- ce que le formulaire de réservation assemble ----------

/** Les horaires se choisissent par demi-heure, de 8 h à 7 h 30 le lendemain, écrites comme on les lit : « 19 h », « 19 h 30 ». */
const FIRST_HOUR = 8;
export const HALF_HOURS: readonly string[] = Array.from({ length: 48 }, (_, slot) => {
  const hour = (FIRST_HOUR + Math.floor(slot / 2)) % 24;
  return `${hour}\u00a0h${slot % 2 === 1 ? "\u00a030" : ""}`;
});

/** « De 19 h à 1 h » : les horaires d'un événement, d'après l'heure de début et l'heure de fin choisies. */
export const hoursText = (start: string, end: string): string => `De ${start} à ${end}`;

/** Les plus longues saisies du formulaire : le lieu assemblé tient dans les 300 caractères que le serveur accepte. */
export const ADDRESS_MAX = 200;
export const CITY_MAX = 80;

/** « 12 rue des Lilas, 83330 Le Castellet » : le lieu d'un événement sur une ligne, d'après ses trois champs. */
export const venueText = (address: string, postalCode: string, city: string): string =>
  `${address.trim()}, ${postalCode.trim()} ${city.trim()}`;
