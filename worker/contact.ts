import type { Deps } from "./deps";
import { PARSERS, checkTurnstile, hashIp } from "./operations";
import { offer } from "./offer";
import { countRecentContactByIp, insertContactMessage } from "./repository";

export type ContactInput = { name: string; email: string; phone: string | null; message: string; turnstile_token: string };

/** `bot` : Turnstile a refusé le visiteur. `too_many` : trop de messages partis de cette connexion en 24 h. */
export type CreateContactResult =
  | { kind: "sent" }
  | { kind: "invalid"; fields: string[] }
  | { kind: "bot" }
  | { kind: "too_many" };

/** La fenêtre de la limite par connexion ; l'empreinte de l'IP est effacée au bout de la même durée (`worker/cron.ts`). */
export const DAY_MS = 24 * 3_600_000;

/** Le message n'est jamais vide : `PARSERS.message` accepte le vide, pour le champ facultatif d'une demande. */
const nonEmpty = (value: string | null | undefined): string | null => (value ? value : null);

/**
 * Le téléphone est facultatif : absent ou blanc, il vaut `null` ; rempli, il suit la règle des demandes.
 * Le résultat est `undefined` si le numéro est refusé.
 */
function parsePhone(value: unknown, now: Date): string | null | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  return PARSERS.phone(value, now) ?? undefined;
}

/** Les champs refusés sont tous nommés, dans l'ordre du formulaire ; un corps qui n'est pas un objet refuse les obligatoires. */
export function parseContact(raw: unknown, now: Date): { ok: true; value: ContactInput } | { ok: false; fields: string[] } {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = PARSERS.name(input.name, now);
  const email = PARSERS.email(input.email, now);
  const phone = parsePhone(input.phone, now);
  const message = nonEmpty(PARSERS.message(input.message, now));
  const token = PARSERS.turnstile_token(input.turnstile_token, now);
  const fields = [
    name === null && "name",
    email === null && "email",
    phone === undefined && "phone",
    message === null && "message",
    token === null && "turnstile_token",
  ].filter((f): f is string => f !== false);
  if (fields.length > 0 || name === null || email === null || phone === undefined || message === null || token === null) {
    return { ok: false, fields };
  }
  return { ok: true, value: { name, email, phone, message, turnstile_token: token } };
}

/**
 * Enregistre un message de contact avec l'e-mail qui le portera au propriétaire : champs, Turnstile, limite par
 * connexion, puis insertion en un seul lot. Aucun envoi au visiteur : le message ne va que chez le propriétaire.
 */
export async function createContact(deps: Deps, input: unknown, ip: string | null): Promise<CreateContactResult> {
  const now = deps.now();
  const parsed = parseContact(input, now);
  if (!parsed.ok) return { kind: "invalid", fields: parsed.fields };
  const contact = parsed.value;
  const db = deps.env.DB;

  if ((await checkTurnstile(deps, contact.turnstile_token, ip)) === "fail") return { kind: "bot" };

  // Sans sel, une empreinte se retrouverait par essais : mieux vaut n'en garder aucune, et sauter la limite par connexion.
  const salt = deps.env.IP_HASH_SALT;
  const ipHash = ip && salt ? await hashIp(salt, ip) : null;
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  if (ipHash !== null && (await countRecentContactByIp(db, ipHash, dayAgo)) >= offer.maxPerIpPer24h) return { kind: "too_many" };

  const id = crypto.randomUUID();
  const nowIso = now.toISOString();
  await insertContactMessage(
    db,
    { id, name: contact.name, email: contact.email, phone: contact.phone, message: contact.message, ip_hash: ipHash, created_at: nowIso },
    [{ booking_id: null, contact_id: id, dedupe_key: `contact:${id}:email`, channel: "email", recipient: "owner", template: "owner_contact", due_at: nowIso }],
  );
  return { kind: "sent" };
}
