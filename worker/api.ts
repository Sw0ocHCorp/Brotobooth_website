import { addDays, bookingWindow, isValidDate } from "./bookings";
import { json, readJson, type Handler } from "./http";
import { sendSoon } from "./notifications";
import { offer, pricesBody } from "./offer";
import { createContact } from "./contact";
import { createRequest, readCurrentTier } from "./operations";
import { listUnavailableDates } from "./repository";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RANGE_DAYS = 400;
/** Une réponse publique gardée 30 secondes au plus : l'envoi d'une demande revérifie la date et le prix. */
const CACHED_30_S = { "Cache-Control": "public, max-age=30" };

/** La plage `from`–`to` de l'adresse, ou `null` si ce n'est pas une plage de dates valides d'au plus `MAX_RANGE_DAYS` jours. */
export function readRange(req: Request): { from: string; to: string } | null {
  const params = new URL(req.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const valid = isValidDate(from) && isValidDate(to) && to >= from && to <= addDays(from, MAX_RANGE_DAYS);
  return valid ? { from, to } : null;
}

/** Les dates prises sur une plage, et la fenêtre réservable : jamais rien sur ceux qui les tiennent. */
export const availability: Handler = async (req, deps) => {
  const range = readRange(req);
  if (!range) return json({ error: "invalid_range" }, 400);
  const unavailable = await listUnavailableDates(deps.env.DB, range.from, range.to);
  return json({ unavailable, ...bookingWindow(deps.now()) }, 200, CACHED_30_S);
};

/** Le palier en cours et le prix de chaque formule : des comptes de places, jamais rien d'une réservation. */
export const prices: Handler = async (_req, deps) =>
  json(pricesBody(offer, await readCurrentTier(deps.env.DB)), 200, CACHED_30_S);

export const postRequest: Handler = async (req, deps, ctx) => {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);

  const result = await createRequest(deps, body.value, req.headers.get("CF-Connecting-IP") || null);
  switch (result.kind) {
    case "created":
      sendSoon(ctx, deps); // l'accusé et l'alerte partent sans attendre la tâche automatique
      return json({ status: "created" }, 201);
    case "already_requested":
      return json({ status: "already_requested" });
    case "invalid":
      return json({ error: "invalid", fields: result.fields }, 422);
    case "date_taken":
      return json({ error: "date_taken" }, 409);
    case "price_changed":
      return json({ error: "price_changed", price_cents: result.priceCents }, 409);
    case "too_many":
      return json({ error: "too_many", reason: result.reason }, 429);
    case "bot":
      return json({ error: "bot" }, 403);
  }
};

/** Un message du formulaire de contact : il part chez le propriétaire seul, jamais un accusé au visiteur. */
export const postContact: Handler = async (req, deps, ctx) => {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);

  const result = await createContact(deps, body.value, req.headers.get("CF-Connecting-IP") || null);
  switch (result.kind) {
    case "sent":
      sendSoon(ctx, deps);
      return json({ status: "sent" }, 201);
    case "invalid":
      return json({ error: "invalid", fields: result.fields }, 422);
    case "bot":
      return json({ error: "bot" }, 403);
    case "too_many":
      return json({ error: "too_many" }, 429);
  }
};
