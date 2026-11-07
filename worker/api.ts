import { addDays, bookingWindow, isValidDate } from "./bookings";
import { json, readJson, type Handler } from "./http";
import { createRequest } from "./operations";
import { listUnavailableDates } from "./repository";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RANGE_DAYS = 400;

/** Les dates prises sur une plage, et la fenêtre réservable : jamais rien sur ceux qui les tiennent. */
export const availability: Handler = async (req, deps) => {
  const params = new URL(req.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!isValidDate(from) || !isValidDate(to) || to < from || to > addDays(from, MAX_RANGE_DAYS)) {
    return json({ error: "invalid_range" }, 400);
  }
  const unavailable = await listUnavailableDates(deps.env.DB, from, to);
  return json({ unavailable, ...bookingWindow(deps.now()) }, 200, { "Cache-Control": "public, max-age=30" });
};

export const postRequest: Handler = async (req, deps) => {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);

  const result = await createRequest(deps, body.value, req.headers.get("CF-Connecting-IP") || null);
  switch (result.kind) {
    case "created":
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
