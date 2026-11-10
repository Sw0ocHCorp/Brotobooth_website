import { ACTIVE_STATUSES, type BookingStatus } from "./bookings";

export type BookingSource = "site" | "manual";

/** Une ligne de `bookings`, colonnes de la spec (section 3). */
export interface Booking {
  id: string;
  token: string;
  event_date: string;
  status: BookingStatus;
  source: BookingSource;
  plan: string | null;
  price_cents: number | null;
  deposit_cents: number | null;
  /** Le palier de l'offre où la place a été prise ; nul pour une date bloquée. Jamais modifié ensuite. */
  price_tier: string | null;
  /** Le prix d'une recharge de 100 tirages, figé à la réservation. */
  refill_cents: number | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  event_type: string | null;
  venue: string | null;
  event_hours: string | null;
  message: string | null;
  ip_hash: string | null;
  terms_version: string | null;
  hold_until: string | null;
  stripe_session: string | null;
  stripe_session_expires: string | null;
  deposit_paid_at: string | null;
  balance_paid_at: string | null;
  notes: string | null;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

export type NewBooking = Omit<Booking, "created_at" | "updated_at">;

export interface HistoryRow {
  id: number;
  booking_id: string;
  at: string;
  actor: string;
  event: string;
  detail: string | null;
}

export type NotificationSpec = {
  booking_id: string | null;
  dedupe_key: string;
  channel: "email" | "telegram";
  recipient: "owner" | "client";
  template: string;
  due_at: string;
};

export type NotificationRow = NotificationSpec & {
  id: number;
  sent_at: string | null;
  cancelled_at: string | null;
  /** Les essais d'envoi : chacun est compté quand `claimNotification` réserve l'envoi. */
  attempts: number;
  last_error: string | null;
  /** Jusqu'à cet instant (UTC), un passage a réservé l'envoi et aucun autre ne le prend. */
  claimed_until: string | null;
};

export interface Transition {
  id: string;
  from: BookingStatus;
  to: BookingStatus;
  patch?: Partial<Booking>;
  actor: string;
  event: string;
  detail?: string;
  cancelPending?: boolean;
  notifications?: NotificationSpec[];
  nowIso: string;
}

// Les horodatages ont tous le format `toISOString()` : comparés comme du texte, ils le sont dans le temps.

/** Les colonnes d'un `NewBooking`. Le littéral doit nommer chaque clé du type, ni plus ni moins. */
const NEW_BOOKING_COLUMNS = Object.keys({
  id: 0, token: 0, event_date: 0, status: 0, source: 0, plan: 0, price_cents: 0, deposit_cents: 0,
  price_tier: 0, refill_cents: 0,
  client_name: 0, client_email: 0, client_phone: 0, event_type: 0, venue: 0, event_hours: 0, message: 0,
  ip_hash: 0, terms_version: 0, hold_until: 0, stripe_session: 0, stripe_session_expires: 0,
  deposit_paid_at: 0, balance_paid_at: 0, notes: 0, anonymized_at: 0,
} satisfies Record<keyof NewBooking, 0>) as (keyof NewBooking)[];

/** Colonnes qu'un correctif ne touche pas : l'état ne change que par `applyTransition`. */
const FROZEN_COLUMNS: ReadonlySet<string> = new Set(["id", "token", "status", "price_tier", "created_at", "updated_at"]);

/** Données personnelles effacées par `anonymizeOld`. */
const PERSONAL_COLUMNS = [
  "client_name", "client_email", "client_phone", "venue", "event_hours", "message", "ip_hash", "notes",
] as const satisfies readonly (keyof Booking)[];

/** Demandes en cours : à valider ou en attente d'acompte. */
const IN_PROGRESS_STATUSES: readonly BookingStatus[] = ["pending_review", "awaiting_deposit"];

/** Refus et expirations, anonymisés avec le temps ; une annulation ne l'est que sans acompte payé (`anonymizeOld`). */
const ANONYMIZED_STATUSES: readonly BookingStatus[] = ["refused", "expired"];

/** 24 h de reprises toutes les 5 minutes. */
const MAX_ATTEMPTS = 288;
/** À partir de là, un envoi compte comme en échec pour le propriétaire. */
const FAILED_AFTER_ATTEMPTS = 3;

/** L'envoi n'est réservé par aucun passage à l'instant `?` : jamais réservé, ou réservation échue. */
const UNCLAIMED = "(claimed_until IS NULL OR claimed_until <= ?)";

type Sql = { sql: string; params: unknown[] };

const inList = (values: readonly string[]): Sql => ({
  sql: `(${values.map(() => "?").join(", ")})`,
  params: [...values],
});

/**
 * Listes d'états pour `status IN ...`. `activeIn` suit ACTIVE_STATUSES ; l'index `one_booking_per_day`
 * de migrations/0001_init.sql écrit les mêmes états en SQL, et repository.test.ts vérifie l'accord.
 */
const activeIn: Sql = inList(ACTIVE_STATUSES);
const inProgressIn: Sql = inList(IN_PROGRESS_STATUSES);

const rows = async <T>(stmt: D1PreparedStatement): Promise<T[]> => (await stmt.all<T>()).results;

const count = async (stmt: D1PreparedStatement): Promise<number> => (await stmt.first<{ n: number }>())!.n;

const selectWhere = (db: D1Database, where: Sql) =>
  db.prepare(`SELECT * FROM bookings WHERE ${where.sql}`).bind(...where.params);

const updateBooking = (
  db: D1Database,
  nowIso: string,
  assignments: [column: string, value: unknown][],
  where: Sql,
) => {
  const all: [string, unknown][] = [["updated_at", nowIso], ...assignments];
  return db
    .prepare(`UPDATE bookings SET ${all.map(([column]) => `${column} = ?`).join(", ")} WHERE ${where.sql}`)
    .bind(...all.map(([, value]) => value), ...where.params);
};

/** Colonnes d'un correctif. Une colonne inconnue ou figée lève, pour ne jamais atteindre le SQL. */
function patchAssignments(patch: Partial<Booking> = {}): [string, unknown][] {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  for (const [column] of entries) {
    if (FROZEN_COLUMNS.has(column) || !(NEW_BOOKING_COLUMNS as string[]).includes(column)) {
      throw new Error(`booking column cannot be patched: ${column}`);
    }
  }
  return entries;
}

const historyStmt = (
  db: D1Database,
  bookingId: string,
  at: string,
  actor: string,
  event: string,
  detail: string | undefined,
  onlyIf: Sql,
) =>
  db
    .prepare(
      `INSERT INTO booking_history (booking_id, at, actor, event, detail)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE ${onlyIf.sql})`,
    )
    .bind(bookingId, at, actor, event, detail ?? null, ...onlyIf.params);

/** Une clé déjà connue est ignorée. Avec `onlyIf`, rien n'est écrit si aucune réservation n'y répond. */
const notificationStmt = (db: D1Database, n: NotificationSpec, onlyIf?: Sql) => {
  const guard = onlyIf ? `EXISTS (SELECT 1 FROM bookings WHERE ${onlyIf.sql})` : "1";
  return db
    .prepare(
      `INSERT OR IGNORE INTO notifications (booking_id, dedupe_key, channel, recipient, template, due_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
    )
    .bind(
      ...[n.booking_id, n.dedupe_key, n.channel, n.recipient, n.template, n.due_at],
      ...(onlyIf?.params ?? []),
    );
};

/**
 * Les écritures puis la lecture de la ligne, dans une seule transaction D1. La ligne n'est rendue que si
 * l'écriture n°`deciding` a modifié exactement une ligne : sinon l'appel n'a rien appliqué, et c'est `null`.
 */
async function writeThenRead(
  db: D1Database,
  writes: D1PreparedStatement[],
  deciding: number,
  read: D1PreparedStatement,
): Promise<Booking | null> {
  const results = await db.batch<Booking>([...writes, read]);
  if (results[deciding]?.meta.changes !== 1) return null;
  return results.at(-1)?.results[0] ?? null;
}

/** SQLite nomme la colonne de l'index violé, pas l'index : ici `bookings.event_date`. */
const isDateTaken = (error: unknown): boolean =>
  /one_booking_per_day|UNIQUE constraint failed: bookings\.event_date/.test(String(error));

/** Le palier où la réservation prend place, et le nombre de places qu'il compte. */
export type TierCap = { tier: string; places: number };

/** Les places prises par palier. Toute ligne compte, quel que soit son état : une place prise n'est jamais rendue. */
export async function countTakenByTier(db: D1Database): Promise<Record<string, number>> {
  const found = await rows<{ price_tier: string; n: number }>(
    db.prepare("SELECT price_tier, COUNT(*) AS n FROM bookings WHERE price_tier IS NOT NULL GROUP BY price_tier"),
  );
  return Object.fromEntries(found.map((row) => [row.price_tier, row.n]));
}

/**
 * Insère la demande et ses notifications d'un seul bloc. L'index `one_booking_per_day` refuse une
 * seconde réservation active sur la date : le bloc est alors annulé en entier. Avec `cap`, la ligne n'est
 * écrite que s'il reste une place au palier, comptée dans la même instruction : sinon `tier_full`.
 */
export async function insertBooking(
  db: D1Database,
  b: NewBooking,
  specs: NotificationSpec[],
  nowIso: string,
): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "date_taken" }>;
export async function insertBooking(
  db: D1Database,
  b: NewBooking,
  specs: NotificationSpec[],
  nowIso: string,
  cap: TierCap | undefined,
): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "date_taken" | "tier_full" }>;
export async function insertBooking(
  db: D1Database,
  b: NewBooking,
  specs: NotificationSpec[],
  nowIso: string,
  cap?: TierCap,
): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "date_taken" | "tier_full" }> {
  const columns = [...NEW_BOOKING_COLUMNS, "created_at", "updated_at"];
  const values = [...NEW_BOOKING_COLUMNS.map((column) => b[column] ?? null), nowIso, nowIso];
  const placeholders = columns.map(() => "?").join(", ");
  const insert = cap
    ? db
        .prepare(
          `INSERT INTO bookings (${columns.join(", ")}) SELECT ${placeholders}
           WHERE (SELECT COUNT(*) FROM bookings WHERE price_tier = ?) < ?`,
        )
        .bind(...values, cap.tier, cap.places)
    : db.prepare(`INSERT INTO bookings (${columns.join(", ")}) VALUES (${placeholders})`).bind(...values);
  const written: Sql = { sql: "id = ?", params: [b.id] };
  try {
    const booking = await writeThenRead(
      db,
      [insert, ...specs.map((spec) => notificationStmt(db, spec, cap ? written : undefined))],
      0,
      selectWhere(db, written),
    );
    if (!booking) return { ok: false, reason: "tier_full" }; // seule une limite de palier laisse la ligne non écrite
    return { ok: true, booking };
  } catch (error) {
    if (isDateTaken(error)) return { ok: false, reason: "date_taken" };
    throw error;
  }
}

/**
 * Change l'état de `from` à `to`, ou renvoie `null` si la réservation n'est plus dans `from`.
 * Chaque écriture annexe ne s'exécute que si la réservation est encore dans `from`, et le `UPDATE` qui
 * change l'état vient en dernier : il décide du résultat, d'après le nombre de lignes qu'il a modifiées.
 */
export async function applyTransition(db: D1Database, t: Transition): Promise<Booking | null> {
  const stillFrom: Sql = { sql: "id = ? AND status = ?", params: [t.id, t.from] };
  const cancelPending = db
    .prepare(
      `UPDATE notifications SET cancelled_at = ?
       WHERE booking_id = ? AND sent_at IS NULL AND cancelled_at IS NULL
         AND EXISTS (SELECT 1 FROM bookings WHERE ${stillFrom.sql})`,
    )
    .bind(t.nowIso, t.id, ...stillFrom.params);
  const writes = [
    historyStmt(db, t.id, t.nowIso, t.actor, t.event, t.detail, stillFrom),
    // Avant les nouvelles notifications, pour ne pas annuler celles que cette transition planifie.
    ...(t.cancelPending ? [cancelPending] : []),
    ...(t.notifications ?? []).map((n) => notificationStmt(db, n, stillFrom)),
    updateBooking(db, t.nowIso, [["status", t.to], ...patchAssignments(t.patch)], stillFrom),
  ];
  return writeThenRead(db, writes, writes.length - 1, selectWhere(db, { sql: "id = ?", params: [t.id] }));
}

/** Modifie des champs sans changer l'état. `null` si la réservation n'existe pas. */
export async function patchBooking(
  db: D1Database,
  id: string,
  patch: Partial<Booking>,
  actor: string,
  event: string,
  nowIso: string,
): Promise<Booking | null> {
  const exists: Sql = { sql: "id = ?", params: [id] };
  const writes = [
    historyStmt(db, id, nowIso, actor, event, undefined, exists),
    updateBooking(db, nowIso, patchAssignments(patch), exists),
  ];
  return writeThenRead(db, writes, writes.length - 1, selectWhere(db, exists));
}

export const getBooking = (db: D1Database, id: string): Promise<Booking | null> =>
  selectWhere(db, { sql: "id = ?", params: [id] }).first<Booking>();

export const getBookingByToken = (db: D1Database, token: string): Promise<Booking | null> =>
  selectWhere(db, { sql: "token = ?", params: [token] }).first<Booking>();

/** Les adresses sont comparées sans tenir compte de la casse, comme l'index `bookings_client_email`. */
export const findActiveByDateAndEmail = (
  db: D1Database,
  date: string,
  email: string,
): Promise<Booking | null> =>
  selectWhere(db, {
    sql: `event_date = ? AND client_email = ? COLLATE NOCASE AND status IN ${inProgressIn.sql}`,
    params: [date, email, ...inProgressIn.params],
  }).first<Booking>();

export const listUnavailableDates = async (db: D1Database, from: string, to: string): Promise<string[]> =>
  (
    await rows<{ event_date: string }>(
      db
        .prepare(
          `SELECT event_date FROM bookings
           WHERE event_date BETWEEN ? AND ? AND status IN ${activeIn.sql} ORDER BY event_date`,
        )
        .bind(from, to, ...activeIn.params),
    )
  ).map((row) => row.event_date);

export const countActiveByEmail = (db: D1Database, email: string): Promise<number> =>
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE client_email = ? COLLATE NOCASE AND status IN ${inProgressIn.sql}`,
      )
      .bind(email, ...inProgressIn.params),
  );

/** Toutes les demandes de cette empreinte depuis `sinceIso` (incluse), quel que soit leur état. */
export const countRecentByIp = (db: D1Database, ipHash: string, sinceIso: string): Promise<number> =>
  count(
    db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE ip_hash = ? AND created_at >= ?")
      .bind(ipHash, sinceIso),
  );

/** Les demandes en cours dont l'échéance est atteinte, la plus ancienne d'abord. */
export const listDueHolds = (db: D1Database, nowIso: string): Promise<Booking[]> =>
  rows<Booking>(
    db
      .prepare(
        `SELECT * FROM bookings
         WHERE status IN ${inProgressIn.sql} AND hold_until <= ? ORDER BY hold_until, created_at`,
      )
      .bind(...inProgressIn.params, nowIso),
  );

export const listUpcoming = (
  db: D1Database,
  fromDate: string,
  statuses: readonly BookingStatus[],
): Promise<Booking[]> => {
  const status = inList(statuses);
  return rows<Booking>(
    db
      .prepare(
        `SELECT * FROM bookings
         WHERE event_date >= ? AND status IN ${status.sql} ORDER BY event_date, created_at`,
      )
      .bind(fromDate, ...status.params),
  );
};

export const listRange = (db: D1Database, from: string, to: string): Promise<Booking[]> =>
  rows<Booking>(
    db
      .prepare("SELECT * FROM bookings WHERE event_date BETWEEN ? AND ? ORDER BY event_date, created_at")
      .bind(from, to),
  );

/** Les demandes en cours, celle dont l'échéance tombe en premier d'abord. */
export const listTodo = (db: D1Database): Promise<Booking[]> =>
  rows<Booking>(
    db
      .prepare(`SELECT * FROM bookings WHERE status IN ${inProgressIn.sql} ORDER BY hold_until, created_at`)
      .bind(...inProgressIn.params),
  );

export const getHistory = (db: D1Database, id: string): Promise<HistoryRow[]> =>
  rows<HistoryRow>(db.prepare("SELECT * FROM booking_history WHERE booking_id = ? ORDER BY id").bind(id));

/**
 * Efface les données personnelles des demandes restées sans suite (refusées, expirées, ou annulées avant tout acompte)
 * créées avant `beforeIso`, une seule fois par ligne, et date l'opération à `nowIso`. Une annulation après paiement reste
 * entière. Le délai court depuis la création : modifier une demande ne prolonge pas la conservation. Renvoie le nombre
 * de lignes anonymisées.
 */
export async function anonymizeOld(db: D1Database, beforeIso: string, nowIso: string): Promise<number> {
  const erase = PERSONAL_COLUMNS.map((column) => `${column} = NULL`).join(", ");
  const statuses = inList(ANONYMIZED_STATUSES);
  const result = await db
    .prepare(
      `UPDATE bookings SET ${erase}, anonymized_at = ?
       WHERE (status IN ${statuses.sql} OR (status = ? AND deposit_paid_at IS NULL))
         AND created_at < ? AND anonymized_at IS NULL`,
    )
    .bind(nowIso, ...statuses.params, "cancelled" satisfies BookingStatus, beforeIso)
    .run();
  return result.meta.changes;
}

export async function enqueue(db: D1Database, specs: NotificationSpec[]): Promise<void> {
  if (specs.length > 0) await db.batch(specs.map((spec) => notificationStmt(db, spec)));
}

/**
 * Les envois échus, les plus anciens d'abord, sans ceux faits, annulés, à bout de reprises ou réservés par un
 * passage en cours.
 */
export const listDueNotifications = (
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NotificationRow[]> =>
  rows<NotificationRow>(
    db
      .prepare(
        `SELECT * FROM notifications
         WHERE due_at <= ? AND sent_at IS NULL AND cancelled_at IS NULL AND attempts < ? AND ${UNCLAIMED}
         ORDER BY due_at, id LIMIT ?`,
      )
      .bind(nowIso, MAX_ATTEMPTS, nowIso, limit),
  );

/**
 * Réserve l'envoi `id` jusqu'à `untilIso` et compte l'essai, d'un seul `UPDATE` : de deux passages qui se
 * croisent, un seul l'obtient, même si l'autre a listé l'envoi avant la réservation ou démarre pendant l'envoi.
 * Rend le nombre d'essais, ou `null` si l'envoi est fait, annulé, inconnu ou réservé par un autre passage.
 * Un passage interrompu libère l'envoi à `untilIso` ; `markFailed` le libère plus tôt, et un envoi fait n'est plus pris.
 */
export async function claimNotification(
  db: D1Database,
  id: number,
  nowIso: string,
  untilIso: string,
): Promise<number | null> {
  const claimed = await db
    .prepare(
      `UPDATE notifications SET attempts = attempts + 1, claimed_until = ?
       WHERE id = ? AND sent_at IS NULL AND cancelled_at IS NULL AND ${UNCLAIMED}
       RETURNING attempts`,
    )
    .bind(untilIso, id, nowIso)
    .first<{ attempts: number }>();
  return claimed?.attempts ?? null;
}

export async function markSent(db: D1Database, id: number, nowIso: string): Promise<void> {
  await db.prepare("UPDATE notifications SET sent_at = ? WHERE id = ?").bind(nowIso, id).run();
}

/** Garde l'erreur et libère l'envoi pour le passage suivant. L'essai a déjà été compté par `claimNotification`. */
export async function markFailed(db: D1Database, id: number, error: string): Promise<void> {
  await db.prepare("UPDATE notifications SET last_error = ?, claimed_until = NULL WHERE id = ?").bind(error, id).run();
}

/** Annule un envoi devenu inutile pour qu'il ne soit plus repris. Un envoi déjà fait ou annulé reste tel quel. */
export async function cancelNotification(db: D1Database, id: number, nowIso: string): Promise<void> {
  await db
    .prepare("UPDATE notifications SET cancelled_at = ? WHERE id = ? AND sent_at IS NULL AND cancelled_at IS NULL")
    .bind(nowIso, id)
    .run();
}

/**
 * Les envois ni faits ni annulés qui ont échoué au moins trois fois à l'instant `nowIso`. Un envoi encore
 * réservé par un passage en est exclu : sa dernière tentative est en cours, et peut réussir.
 */
export const listFailedNotifications = (db: D1Database, nowIso: string): Promise<NotificationRow[]> =>
  rows<NotificationRow>(
    db
      .prepare(
        `SELECT * FROM notifications
         WHERE sent_at IS NULL AND cancelled_at IS NULL AND attempts >= ? AND ${UNCLAIMED} ORDER BY due_at, id`,
      )
      .bind(FAILED_AFTER_ATTEMPTS, nowIso),
  );

export const getState = (db: D1Database, key: string): Promise<string | null> =>
  db.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first<string>("value");

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}
