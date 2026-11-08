import { addDays, bookingWindow, isValidDate } from "./bookings";
import { json, readJson, type Handler } from "./http";
import { sendSoon } from "./notifications";
import { createRequest } from "./operations";
import { listUnavailableDates } from "./repository";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RANGE_DAYS = 400;

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
  return json({ unavailable, ...bookingWindow(deps.now()) }, 200, { "Cache-Control": "public, max-age=30" });
};

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
    case "too_many":
      return json({ error: "too_many" }, 429);
    case "bot":
      return json({ error: "bot" }, 403);
  }
};
