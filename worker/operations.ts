import { checkDate, depositCents } from "./bookings";
import type { Deps } from "./deps";
import { plan } from "./notifications";
import { offer, planById } from "./offer";
import {
  countActiveByEmail,
  countRecentByIp,
  findActiveByDateAndEmail,
  insertBooking,
  type Booking,
  type NewBooking,
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
const PARSERS: { [K in keyof RequestInput]-?: (value: unknown, now: Date) => RequestInput[K] | null } = {
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

/** Une panne du service anti-robots, annoncée ou non, ne coûte jamais une demande. */
async function checkTurnstile(deps: Deps, token: string, ip: string | null) {
  try {
    return await deps.verifyTurnstile(token, ip);
  } catch {
    return "unavailable";
  }
}

/**
 * Enregistre la demande d'un client : champs, Turnstile, doublon, limites, puis insertion qui tient la date.
 * Un même envoi répété donne `already_requested`, y compris quand deux envois se croisent.
 */
export async function createRequest(deps: Deps, input: unknown, ip: string | null): Promise<CreateRequestResult> {
  const now = deps.now();
  const parsed = parseRequest(input, now);
  if (!parsed.ok) return { kind: "invalid", fields: parsed.fields };
  const request = parsed.value;
  const db = deps.env.DB;

  if ((await checkTurnstile(deps, request.turnstile_token, ip)) === "fail") return { kind: "bot" };

  const findTwin = () => findActiveByDateAndEmail(db, request.date, request.email);
  const twin = await findTwin();
  if (twin) return { kind: "already_requested", booking: twin };

  const ipHash = ip === null ? null : await hashIp(deps.env.IP_HASH_SALT, ip);
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  if (
    (await countActiveByEmail(db, request.email)) >= offer.maxActivePerEmail ||
    (ipHash !== null && (await countRecentByIp(db, ipHash, dayAgo)) >= offer.maxPerIpPer24h)
  ) {
    return { kind: "too_many" };
  }

  const chosen = planById(request.plan)!; // validé par parseRequest
  const nowIso = now.toISOString();
  const booking: NewBooking = {
    id: crypto.randomUUID(),
    token: randomToken(),
    event_date: request.date,
    status: "pending_review",
    source: "site",
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
    hold_until: new Date(now.getTime() + offer.reviewHours * HOUR_MS).toISOString(),
    stripe_session: null,
    stripe_session_expires: null,
    deposit_paid_at: null,
    balance_paid_at: null,
    notes: null,
    anonymized_at: null,
  };
  const specs = plan("requested", { ...booking, created_at: nowIso, updated_at: nowIso }, now);

  const inserted = await insertBooking(db, booking, specs, nowIso);
  if (inserted.ok) return { kind: "created", booking: inserted.booking };
  // Un envoi identique, arrivé en même temps, vient de prendre la date : pour ce client, c'est une réussite.
  const winner = await findTwin();
  return winner ? { kind: "already_requested", booking: winner } : { kind: "date_taken" };
}
