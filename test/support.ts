import { env } from "cloudflare:workers";
import {
  insertBooking,
  type Booking,
  type NewBooking,
  type NotificationSpec,
} from "../worker/repository";

/** L'instant « maintenant » de tous les tests. */
export const T0 = "2026-11-07T10:00:00.000Z";

const randomHex = (): string => crypto.randomUUID().replaceAll("-", "");

/** Une demande du site en attente de réponse, avec toutes les colonnes d'identité renseignées. */
export const newBooking = (over: Partial<NewBooking> = {}): NewBooking => ({
  id: crypto.randomUUID(),
  token: randomHex() + randomHex(),
  event_date: "2026-12-19",
  status: "pending_review",
  source: "site",
  plan: "formule-2",
  price_cents: 150_000,
  deposit_cents: 45_000,
  client_name: "Camille Martin",
  client_email: "camille@example.test",
  client_phone: "0601020304",
  event_type: "Mariage",
  venue: "Domaine des Pins, Lyon",
  event_hours: "18h-02h",
  message: "Un fond rose, si possible.",
  ip_hash: "ip-hash-1",
  terms_version: "2026-11-07",
  hold_until: "2026-11-10T10:00:00.000Z",
  stripe_session: null,
  stripe_session_expires: null,
  deposit_paid_at: null,
  balance_paid_at: null,
  notes: "Rappeler avant la date.",
  anonymized_at: null,
  ...over,
});

export async function insert(nb: NewBooking): Promise<{ booking: Booking }> {
  const result = await insertBooking(env.DB, nb, [], T0);
  if (!result.ok) throw new Error(`insert: ${result.reason}`);
  return { booking: result.booking };
}

/** Un e-mail au propriétaire, dû à `T0`. */
export const spec = (key: string, bookingId?: string): NotificationSpec => ({
  booking_id: bookingId ?? null,
  dedupe_key: key,
  channel: "email",
  recipient: "owner",
  template: "test",
  due_at: T0,
});

/** Vide toutes les tables, les tables filles d'abord à cause des clés étrangères. */
export async function resetDb(db: D1Database): Promise<void> {
  await db.batch(
    ["notifications", "booking_history", "bookings", "system_state"].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
}
