import { addMonths, nextStatus, parisHour, parisToday, parisWeekday } from "./bookings";
import type { Deps } from "./deps";
import { offer } from "./offer";
import { closeSession, expireHold } from "./operations";
import { logFailure, recordPayment } from "./payments";
import { anonymizeOld, enqueue, getBooking, getState, listDueHolds, setState, type Booking } from "./repository";

/** Les refus et expirations sont anonymisés au bout de 12 mois (spec, section 9). */
const RETENTION_MONTHS = 12;
const MONDAY = 1;
const DIGEST_CHANNELS = ["telegram", "email"] as const;

const LAST_RUN_KEY = "last_cron_run";
const LAST_ANONYMIZE_KEY = "last_anonymize";

/** Une demande en cours dont l'échéance est atteinte. */
const isDue = (b: Booking, nowIso: string): boolean =>
  nextStatus(b.status, "expire") !== null && b.hold_until !== null && b.hold_until <= nowIso;

/**
 * Libère la réservation `id` si son échéance est atteinte. La liste de `releaseDueHolds` peut dater de quelques
 * instants : le client a pu prolonger la date ou payer depuis, d'où la relecture. Une session de paiement est
 * fermée avant la date ; payée, elle confirme la réservation comme le ferait le webhook. Si Stripe ne répond
 * pas, ou ne ferme pas la session, la fonction lève sans rien écrire : la date reste tenue au passage suivant.
 */
async function releaseHold(deps: Deps, id: string): Promise<void> {
  const booking = await getBooking(deps.env.DB, id);
  if (!booking || !isDue(booking, deps.now().toISOString())) return;

  if (booking.stripe_session) {
    const session = await closeSession(deps.stripe, booking.stripe_session);
    if (session.paymentStatus === "paid") return recordPayment(deps, session);
  }
  await expireHold(deps, booking);
}

/** Libère les dates dont l'échéance est atteinte. Une réservation qui échoue n'arrête pas les suivantes. */
export async function releaseDueHolds(deps: Deps): Promise<void> {
  for (const { id } of await listDueHolds(deps.env.DB, deps.now().toISOString())) {
    try {
      await releaseHold(deps, id);
    } catch (error) {
      logFailure(`Libération de ${id}`, error);
    }
  }
}

/**
 * Met en file le point du lundi (les prestations à venir) pour le propriétaire, à partir de l'heure de rappel de
 * Paris. La clé porte la date : les passages suivants du même lundi n'en ajoutent aucun.
 */
export async function enqueueWeeklyDigest(deps: Deps): Promise<void> {
  const now = deps.now();
  if (parisWeekday(now) !== MONDAY || parisHour(now) < offer.reminderHourParis) return;
  const day = parisToday(now);
  await enqueue(
    deps.env.DB,
    DIGEST_CHANNELS.map((channel) => ({
      booking_id: null,
      dedupe_key: `digest:${day}:${channel}`,
      channel,
      recipient: "owner",
      template: "owner_digest",
      due_at: now.toISOString(),
    })),
  );
}

/** Efface les données personnelles des refus et expirations de plus de 12 mois, au plus une fois par jour de Paris. */
async function anonymizeExpiredRequests(deps: Deps): Promise<void> {
  const db = deps.env.DB;
  const now = deps.now();
  const today = parisToday(now);
  if ((await getState(db, LAST_ANONYMIZE_KEY)) === today) return;

  const nowIso = now.toISOString();
  const cutoff = `${addMonths(nowIso.slice(0, 10), -RETENTION_MONTHS)}${nowIso.slice(10)}`;
  await anonymizeOld(db, cutoff, nowIso);
  await setState(db, LAST_ANONYMIZE_KEY, today);
}

const STEPS: readonly (readonly [name: string, run: (deps: Deps) => Promise<void>])[] = [
  ["Libération des dates", releaseDueHolds],
  ["Point du lundi", enqueueWeeklyDigest],
  ["Anonymisation", anonymizeExpiredRequests],
];

/**
 * Le passage de la tâche automatique, toutes les 5 minutes. Chaque étape a son propre filet : une panne n'arrête
 * pas les suivantes, et l'heure du passage s'écrit quand même, pour que l'administration montre que la tâche tourne.
 */
export async function runCron(deps: Deps): Promise<void> {
  for (const [name, run] of STEPS) {
    try {
      await run(deps);
    } catch (error) {
      logFailure(name, error);
    }
  }
  await setState(deps.env.DB, LAST_RUN_KEY, deps.now().toISOString());
}
