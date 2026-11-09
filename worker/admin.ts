import { readRange } from "./api";
import { isValidDate } from "./bookings";
import { LAST_RUN_KEY } from "./cron";
import type { Deps } from "./deps";
import { findRoute, fromOtherOrigin, json, readJson, type Handler, type Route } from "./http";
import { sendSoon } from "./notifications";
import {
  adjustPrice,
  blockDate,
  cancelBooking,
  createManual,
  editNotes,
  markBalancePaid,
  PARSERS,
  PaymentUnavailable,
  refuseBooking,
  resendPaymentLink,
  validateBooking,
  type ManualInput,
  type OpResult,
} from "./operations";
import {
  getBooking,
  getHistory,
  getState,
  listFailedNotifications,
  listRange,
  listTodo,
  type Booking,
} from "./repository";

/**
 * L'API du propriétaire, derrière Cloudflare Access, que le Worker revérifie (`deps.isOwner`). Les réponses
 * ne sont jamais gardées en cache. Une écriture (`POST`, `PATCH`) n'est reçue que de la page d'administration
 * du site : `Origin` égal à `BASE_URL`, corps `application/json` (`{}` pour une action sans donnée).
 *
 * | Route (sous `/api/admin`) | Réponse |
 * |---|---|
 * | `GET  /overview` | `{ todo, health: { lastCronRun, failedNotifications } }` |
 * | `GET  /bookings?from&to` | `{ bookings }` de la période |
 * | `GET  /bookings/:id` | `{ booking, history }`, l'historique commençant par la demande reçue |
 * | `POST /bookings` | `{ kind: "manual" \| "blocked", ... }`, 201 `{ booking }` ; une prestation prend une place du palier en cours |
 * | `POST /bookings/:id/<action>` | `validate`, `refuse`, `cancel`, `resend-link`, `balance-paid` : `{ booking }` |
 * | `PATCH /bookings/:id` | `{ price_cents?, deposit_cents?, notes? }` : `{ booking }` |
 *
 * Erreurs : 400 corps illisible ou période invalide, 403, 404, 405, 409 (`stale`, `date_taken`, `tier_changed`), 413, 415,
 * 422 `{ error: "invalid", fields }`, 503 `payment_unavailable`.
 */

const BOOKINGS = "/api/admin/bookings";
const MAX_BODY_BYTES = 16 * 1024;

const invalid = (fields: string[]): Response => json({ error: "invalid", fields }, 422);

/**
 * Une réservation telle que l'administration la reçoit : toute la ligne, sauf l'empreinte de l'adresse IP, qui ne sert
 * qu'aux limites de la demande publique. Le jeton reste, il porte le lien de paiement du client.
 */
const forAdmin = ({ ip_hash: _ipHash, ...booking }: Booking): Omit<Booking, "ip_hash"> => booking;

const FAILURE_STATUS = { not_found: 404, stale: 409, date_taken: 409, tier_changed: 409, invalid: 422 } as const;

/** La réponse à une opération : la réservation si elle a réussi, sinon la raison du refus. */
function reply(result: OpResult, okStatus = 200): Response {
  if (result.ok) return json({ booking: forAdmin(result.booking) }, okStatus);
  // Seule la date peut être « invalide » ici : les autres champs sont vérifiés avant l'opération.
  return result.reason === "invalid" ? invalid(["date"]) : json({ error: result.reason }, FAILURE_STATUS[result.reason]);
}

/** Le corps de `req`, lu comme un objet JSON ; sinon la réponse d'erreur à rendre. */
async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);
  const value = body.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid(["body"]);
}

/** Une règle de champ : la valeur nettoyée, ou `null` si elle est refusée. Les règles de la demande publique en sont. */
type Rule<T> = (value: unknown, now: Date) => T | null;

const dateRule: Rule<string> = (value) => (typeof value === "string" && isValidDate(value) ? value : null);

/** Un prix ou un acompte, en centimes, avec la règle du prix de la demande publique. */
const centsRule: Rule<number> = PARSERS.price_cents;

/** Un champ absent, nul ou vide n'est pas renseigné. */
const isBlank = (value: unknown): boolean => value === undefined || value === null || value === "";

/**
 * Lit les champs d'un corps JSON. `read` rend la valeur nettoyée, ou `undefined` si le champ n'est pas renseigné
 * (et n'est pas `required`) ou si sa règle le refuse, auquel cas il est nommé dans `fields()`. Une clé que
 * aucune règle n'a lue y figure aussi : une faute de frappe ne perd pas une donnée en silence.
 */
function fieldReader(raw: Record<string, unknown>, now: Date, known: string[] = []) {
  const seen = new Set(known);
  const refused: string[] = [];
  const read = <T>(name: string, rule: Rule<T>, required = false): T | undefined => {
    seen.add(name);
    const value = raw[name];
    if (!required && isBlank(value)) return undefined;
    const parsed = rule(value, now);
    if (parsed === null) refused.push(name);
    return parsed ?? undefined;
  };
  const fields = () => [...refused, ...Object.keys(raw).filter((key) => !seen.has(key))];
  return { read, refused, fields };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; fields: string[] };

/** Les champs de la demande publique, avec ses règles ; le délai minimum de la date n'a pas cours ici. */
function parseManual(raw: Record<string, unknown>, now: Date): Parsed<ManualInput> {
  const { read, refused, fields } = fieldReader(raw, now, ["kind"]);
  const date = read("date", dateRule, true);
  const name = read("name", PARSERS.name, true);
  const phone = read("phone", PARSERS.phone);
  const email = read("email", PARSERS.email);
  const eventType = read("event_type", PARSERS.event_type);
  const venue = read("venue", PARSERS.venue);
  const hours = read("event_hours", PARSERS.event_hours);
  const plan = read("plan", PARSERS.plan);
  const price = read("price_cents", centsRule);
  const deposit = read("deposit_cents", centsRule);
  const notes = read("notes", PARSERS.message) || undefined;
  if (!refused.includes("price_cents") && (deposit ?? 0) > (price ?? 0)) refused.push("deposit_cents");
  if (fields().length > 0) return { ok: false, fields: fields() };
  return {
    ok: true,
    value: { date: date!, name: name!, phone, email, eventType, venue, hours, plan, priceCents: price ?? 0, depositCents: deposit ?? 0, notes },
  };
}

function parseBlocked(raw: Record<string, unknown>, now: Date): Parsed<{ date: string; notes?: string }> {
  const { read, fields } = fieldReader(raw, now, ["kind"]);
  const date = read("date", dateRule, true);
  const notes = read("notes", PARSERS.message) || undefined;
  return fields().length > 0 ? { ok: false, fields: fields() } : { ok: true, value: { date: date!, notes } };
}

type Edit = { price?: number; deposit?: number; notes?: string | null };

/**
 * Ce que `PATCH` change. Les notes vides ou nulles les effacent ; absentes, elles restent. Un acompte seul
 * se compare au prix de `current`. Sans rien à changer, `body` est refusé.
 */
function parseEdit(raw: Record<string, unknown>, current: Booking, now: Date): Parsed<Edit> {
  const { read, refused, fields } = fieldReader(raw, now);
  const price = read("price_cents", centsRule);
  const deposit = read("deposit_cents", centsRule);
  const notes = raw.notes === undefined ? undefined : read("notes", PARSERS.message) || null;
  if (deposit !== undefined && !refused.includes("price_cents") && deposit > (price ?? current.price_cents ?? 0)) {
    refused.push("deposit_cents");
  }
  if (fields().length === 0 && price === undefined && deposit === undefined && notes === undefined) refused.push("body");
  return fields().length > 0 ? { ok: false, fields: fields() } : { ok: true, value: { price, deposit, notes } };
}

const overview: Handler = async (_req, deps) => {
  const db = deps.env.DB;
  const [todo, lastCronRun, failed] = await Promise.all([
    listTodo(db),
    getState(db, LAST_RUN_KEY),
    listFailedNotifications(db, deps.now().toISOString()),
  ]);
  return json({ todo: todo.map(forAdmin), health: { lastCronRun, failedNotifications: failed.length } });
};

const listBookings: Handler = async (req, deps) => {
  const range = readRange(req);
  return range
    ? json({ bookings: (await listRange(deps.env.DB, range.from, range.to)).map(forAdmin) })
    : json({ error: "invalid_range" }, 400);
};

/** Ce que l'historique raconte de la réservation : sa réception d'abord, puis chaque changement dans l'ordre. */
const showBooking: Handler = async (_req, deps, _ctx, [id]) => {
  const booking = await getBooking(deps.env.DB, id);
  if (!booking) return json({ error: "not_found" }, 404);
  const received = { at: booking.created_at, actor: booking.source === "site" ? "client" : "owner", event: "received" };
  const changes = (await getHistory(deps.env.DB, id)).map(({ at, actor, event, detail }) => ({ at, actor, event, detail }));
  return json({ booking: forAdmin(booking), history: [received, ...changes] });
};

const addBooking: Handler = async (req, deps, ctx) => {
  const raw = await readObject(req);
  if (raw instanceof Response) return raw;
  const now = deps.now();
  if (raw.kind === "blocked") {
    const input = parseBlocked(raw, now);
    return input.ok ? reply(await blockDate(deps, input.value.date, input.value.notes), 201) : invalid(input.fields);
  }
  if (raw.kind === "manual") {
    const input = parseManual(raw, now);
    if (!input.ok) return invalid(input.fields);
    const result = await createManual(deps, input.value);
    if (result.ok) sendSoon(ctx, deps);
    return reply(result, 201);
  }
  return invalid(["kind"]);
};

const editBooking: Handler = async (req, deps, ctx, [id]) => {
  const raw = await readObject(req);
  if (raw instanceof Response) return raw;
  const current = await getBooking(deps.env.DB, id);
  if (!current) return json({ error: "not_found" }, 404);
  const edit = parseEdit(raw, current, deps.now());
  if (!edit.ok) return invalid(edit.fields);

  // Le prix d'abord : s'il est refusé, les notes ne sont pas écrites non plus.
  let result: OpResult = { ok: true, booking: current };
  if (edit.value.price !== undefined || edit.value.deposit !== undefined) {
    try {
      result = await adjustPrice(deps, id, {
        priceCents: edit.value.price ?? current.price_cents ?? 0,
        depositCents: edit.value.deposit,
      });
    } catch (error) {
      if (!(error instanceof PaymentUnavailable)) throw error;
      console.error(`PATCH ${BOOKINGS}/:id : ${error.message}`);
      return json({ error: "payment_unavailable" }, 503);
    }
    if (result.ok) sendSoon(ctx, deps);
  }
  if (result.ok && edit.value.notes !== undefined) result = await editNotes(deps, id, edit.value.notes);
  return reply(result);
};

/** `sends` : l'action met des messages en file, qui partent sans attendre la tâche automatique. */
type Action = { run: (deps: Deps, id: string) => Promise<OpResult>; sends: boolean };

const ACTIONS: Record<string, Action> = {
  validate: { run: (deps, id) => validateBooking(deps, id, "owner"), sends: true },
  refuse: { run: (deps, id) => refuseBooking(deps, id, "owner"), sends: true },
  cancel: { run: (deps, id) => cancelBooking(deps, id, "owner"), sends: true },
  "resend-link": { run: resendPaymentLink, sends: true },
  "balance-paid": { run: markBalancePaid, sends: false },
};

const doAction =
  ({ run, sends }: Action): Handler =>
  async (_req, deps, ctx, [id]) => {
    const result = await run(deps, id);
    if (result.ok && sends) sendSoon(ctx, deps);
    return reply(result);
  };

const ROUTES: Route[] = [
  { method: "GET", path: "/api/admin/overview", handler: overview },
  { method: "GET", path: BOOKINGS, handler: listBookings },
  { method: "POST", path: BOOKINGS, handler: addBooking },
  { method: "GET", path: `${BOOKINGS}/:id`, handler: showBooking },
  { method: "PATCH", path: `${BOOKINGS}/:id`, handler: editBooking },
  ...Object.entries(ACTIONS).map(([name, action]) => ({
    method: "POST",
    path: `${BOOKINGS}/:id/${name}`,
    handler: doAction(action),
  })),
];

/**
 * Une écriture n'est reçue que de la page d'administration du site. À la différence des formulaires publics,
 * une requête sans `Origin` est refusée : elle ne vient pas d'une page du site. Rend la réponse de refus, ou `null`.
 */
function refuseForeignWrite(req: Request, deps: Deps): Response | null {
  if (!req.headers.has("Origin") || fromOtherOrigin(req, deps.env.BASE_URL)) return json({ error: "forbidden" }, 403);
  const type = req.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  return type === "application/json" ? null : json({ error: "unsupported_media_type" }, 415);
}

/** Le propriétaire d'abord : sans lui, rien ne dit même si la route existe. `path` est le chemin de la requête. */
export async function adminApi(req: Request, deps: Deps, ctx: ExecutionContext, path: string): Promise<Response> {
  if (!deps.isOwner(ctx)) return json({ error: "forbidden" }, 403);
  const found = findRoute(ROUTES, req.method, path);
  if (found instanceof Response) return found;
  if (req.method !== "GET") {
    const refused = refuseForeignWrite(req, deps);
    if (refused) return refused;
  }
  return found.route.handler(req, deps, ctx, found.params);
}
