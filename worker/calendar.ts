import { ACTIVE_STATUSES, addDays, parisToday, type BookingStatus } from "./bookings";
import type { Deps } from "./deps";
import { DEFAULT_HEADERS, json, secretMatches } from "./http";
import { formatEuros } from "./html";
import { offer } from "./offer";
import { listUpcoming, type Booking } from "./repository";
import { balance, planName, tierName } from "./templates";

/** L'identifiant d'un événement est `<identifiant de la réservation>@brotobooth.fr` : le même à chaque lecture. */
const UID_DOMAIN = "brotobooth.fr";
/** RFC 5545, 3.1 : une ligne ne dépasse pas 75 octets, fin de ligne exclue. */
const MAX_LINE_OCTETS = 75;

/** Le titre de l'événement de chaque état qui tient une date : les autres états n'ont pas d'événement. */
const TITLES: Partial<Record<BookingStatus, string>> = {
  pending_review: "À valider",
  awaiting_deposit: "Acompte attendu",
  confirmed: "Prestation",
  blocked: "Date bloquée",
};

// ---------- le format ----------

const ESCAPES: Record<string, string> = { "\\": "\\\\", ";": "\\;", ",": "\\,", "\n": "\\n" };
/** Les caractères de contrôle qu'un texte ne peut pas porter (RFC 5545, 3.3.11), tabulation et sauts de ligne exceptés. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Un texte libre tel que le calendrier le porte : `\`, `;`, `,` et les sauts de ligne sont échappés, les autres
 * caractères de contrôle retirés. Un champ saisi par un client ne peut donc ni ouvrir une ligne ni faire refuser le flux.
 */
const escapeText = (text: string): string =>
  text
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\\;,\n]/g, (char) => ESCAPES[char]);

const encoder = new TextEncoder();

/** Une ligne repliée (RFC 5545, 3.1) : chaque suite commence par une espace, comptée dans ses 75 octets. Un caractère n'est jamais coupé. */
function fold(line: string): string {
  let folded = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > MAX_LINE_OCTETS) {
      folded += "\r\n ";
      octets = 1;
    }
    folded += char;
    octets += size;
  }
  return folded;
}

/** `AAAA-MM-JJ` en `AAAAMMJJ`. */
const compactDate = (date: string): string => date.replaceAll("-", "");

/** « 20261107T100000Z » : l'instant en UTC. */
const timestamp = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, "");

// ---------- les événements ----------

/** Ce que le propriétaire veut savoir de la prestation, une ligne par valeur renseignée. */
function details(b: Booking): string[] {
  const rows: [label: string, value: string | null][] = [
    ["Type", b.event_type],
    ["Horaires", b.event_hours],
    ["Formule", planName(b)],
    ["Palier", tierName(b)],
    ["Recharge de 100 tirages", b.refill_cents === null ? null : formatEuros(b.refill_cents)],
    ["Téléphone", b.client_phone],
    // Sans prix, le solde n'est pas nul : il est inconnu.
    ["Solde restant", b.price_cents === null ? null : balance(b)],
  ];
  return rows.flatMap(([label, value]) => (value ? [`${label} : ${value}`] : []));
}

/** L'événement d'une journée commence à minuit : l'alerte sonne la veille à l'heure des autres rappels (9 h, soit `-PT15H`), et non à minuit (`-P1D`). */
const ALARM_TRIGGER = `-PT${24 - offer.reminderHourParis}H`;

/** Un événement sur la journée, avec une alerte la veille à 9 h. */
function event(b: Booking, title: string, now: Date): string[] {
  // Une date bloquée est l'agenda du propriétaire lui-même : sa note tient lieu de nom, et aucun champ client n'y figure.
  const blocked = b.status === "blocked";
  const who = blocked ? b.notes : b.client_name;
  const venue = blocked ? null : b.venue;
  const description = blocked ? [] : details(b);
  const summary = escapeText(who ? `${title} – ${who}` : title);
  return [
    "BEGIN:VEVENT",
    `UID:${b.id}@${UID_DOMAIN}`,
    `DTSTAMP:${timestamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDate(b.event_date)}`,
    `DTEND;VALUE=DATE:${compactDate(addDays(b.event_date, 1))}`,
    `SUMMARY:${summary}`,
    ...(venue ? [`LOCATION:${escapeText(venue)}`] : []),
    ...(description.length > 0 ? [`DESCRIPTION:${escapeText(description.join("\n"))}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `TRIGGER:${ALARM_TRIGGER}`,
    // Une alerte d'affichage porte un texte (RFC 5545, 3.6.6).
    `DESCRIPTION:${summary}`,
    "END:VALARM",
    "END:VEVENT",
  ];
}

/** Le calendrier des dates tenues : une ligne par champ, fins de ligne CRLF. `now` date chaque événement. */
export function renderCalendar(bookings: Booking[], now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Brotobooth//Reservations//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Brotobooth",
    ...bookings.flatMap((b) => {
      const title = TITLES[b.status];
      return title ? event(b, title, now) : [];
    }),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

// ---------- le flux ----------

/**
 * `GET /agenda/<jeton>.ics` : les dates tenues à partir d'aujourd'hui à Paris, pour l'abonnement du téléphone du
 * propriétaire. Un jeton faux, ou un jeton d'agenda absent, donne le 404 d'une adresse inconnue, sans rien de plus.
 */
export async function calendarFeed(deps: Deps, token: string): Promise<Response> {
  if (!(await secretMatches(token, deps.env.CALENDAR_TOKEN))) return json({ error: "not_found" }, 404);
  const now = deps.now();
  const bookings = await listUpcoming(deps.env.DB, parisToday(now), ACTIVE_STATUSES);
  return new Response(renderCalendar(bookings, now), {
    headers: { ...DEFAULT_HEADERS, "Content-Type": "text/calendar; charset=utf-8" },
  });
}
