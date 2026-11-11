import { addMonths, nextStatus, parisHour, parisToday, parisWeekday } from "./bookings";
import type { Deps } from "./deps";
import { processDue } from "./notifications";
import { offer } from "./offer";
import { closeSession, expireHold } from "./operations";
import { logFailure, recordPayment } from "./payments";
import { anonymizeOld, enqueue, getBooking, getState, listDueHolds, purgeContactMessages, setState, type Booking } from "./repository";

/** Les demandes restées sans suite (refus, expirations, annulations avant acompte) sont anonymisées au bout de 12 mois (spec, section 9). */
const RETENTION_MONTHS = 12;
/** Un message de contact est supprimé 12 mois après sa réception, l'empreinte de son IP 24 h après (spec de la rubrique, §4). */
const CONTACT_RETENTION_MONTHS = 12;
const CONTACT_IP_HOURS = 24;
const HOUR_MS = 3_600_000;
const MONDAY = 1;
const DIGEST_CHANNELS = ["telegram", "email"] as const;

/** La clé de `system_state` où chaque passage écrit son heure : l'administration la lit. */
export const LAST_RUN_KEY = "last_cron_run";
const LAST_ANONYMIZE_KEY = "last_anonymize";

/** Une demande en cours dont l'échéance est atteinte. */
const isDue = (b: Booking, nowIso: string): boolean =>
  nextStatus(b.status, "expire") !== null && b.hold_until !== null && b.hold_until <= nowIso;

/** La réservation `id`, relue, si elle est toujours une demande en cours dont l'échéance est atteinte. */
async function dueBooking(deps: Deps, id: string): Promise<Booking | null> {
  const booking = await getBooking(deps.env.DB, id);
  return booking && isDue(booking, deps.now().toISOString()) ? booking : null;
}

/**
 * Libère la réservation `id` si son échéance est atteinte. La liste de `releaseDueHolds` peut dater de quelques
 * instants : le client a pu prolonger la date ou payer depuis, d'où la relecture. Une session de paiement est
 * fermée avant la date ; payée, elle confirme la réservation comme le ferait le webhook. Si Stripe ne répond
 * pas, ou ne ferme pas la session, la fonction lève sans rien écrire : la date reste tenue au passage suivant.
 */
async function releaseHold(deps: Deps, id: string): Promise<void> {
  let booking = await dueBooking(deps, id);
  if (!booking) return;

  const sessionId = booking.stripe_session;
  if (sessionId) {
    const session = await closeSession(deps.stripe, sessionId);
    if (session.paymentStatus === "paid") {
      await recordPayment(deps, session);
      return;
    }
    // Les appels à Stripe ont pris du temps : un client parti avant l'échéance a pu ouvrir une autre session,
    // ou le propriétaire changer le prix. Sa date reste tenue, la suite se décide au passage suivant.
    booking = await dueBooking(deps, id);
    if (booking?.stripe_session !== sessionId) return;
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

/** L'instant `months` mois avant `nowIso`, à la même heure. */
const monthsBefore = (nowIso: string, months: number): string => `${addMonths(nowIso.slice(0, 10), -months)}${nowIso.slice(10)}`;

/** Efface les données personnelles des demandes restées sans suite de plus de 12 mois, au plus une fois par jour de Paris. */
async function anonymizeExpiredRequests(deps: Deps): Promise<void> {
  const db = deps.env.DB;
  const now = deps.now();
  const today = parisToday(now);
  if ((await getState(db, LAST_ANONYMIZE_KEY)) === today) return;

  const nowIso = now.toISOString();
  await anonymizeOld(db, monthsBefore(nowIso, RETENTION_MONTHS), nowIso);
  await setState(db, LAST_ANONYMIZE_KEY, today);
}

/**
 * Supprime les messages de contact de plus de 12 mois avec leurs envois, et efface les empreintes d'IP de plus de 24 h.
 * À chaque passage, et non une fois par jour comme l'anonymisation : une empreinte ne survit pas jusqu'au lendemain.
 */
async function purgeExpiredContactMessages(deps: Deps): Promise<void> {
  const now = deps.now();
  const ipCutoff = new Date(now.getTime() - CONTACT_IP_HOURS * HOUR_MS).toISOString();
  await purgeContactMessages(deps.env.DB, monthsBefore(now.toISOString(), CONTACT_RETENTION_MONTHS), ipCutoff);
}

/** L'envoi vient après la libération et le point du lundi : leurs messages partent dans le même passage. */
const STEPS: readonly (readonly [name: string, run: (deps: Deps) => Promise<unknown>])[] = [
  ["Libération des dates", releaseDueHolds],
  ["Point du lundi", enqueueWeeklyDigest],
  ["Envoi des messages", processDue],
  ["Anonymisation", anonymizeExpiredRequests],
  ["Effacement des messages de contact", purgeExpiredContactMessages],
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
