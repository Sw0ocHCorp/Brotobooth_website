import { hasBookingDeposit, type BookingStatus } from "./bookings";
import type { Button, Deps } from "./deps";
import { ServiceRefusal } from "./http";
import { dropAlert, getBooking, listSettledAlerts, type Booking } from "./repository";
import { renderTelegram } from "./templates";

/**
 * L'alerte Telegram d'une demande : le message qui l'annonce au propriétaire, avec ses boutons « Valider / Refuser ».
 * C'est le seul message que le bot retient (`telegram_alerts`), pour le mettre à jour quand la demande reçoit sa réponse
 * ailleurs que par ses boutons : depuis l'administration, depuis un autre chat, ou à l'expiration.
 */
export const REQUEST_ALERT = "owner_new_request";

/** Le nouveau contenu d'un message du bot, sans bouton s'il n'en a pas. */
export type Edit = { html: string; buttons?: Button[][] };

/** Une demande acceptée sans acompte : la date est confirmée, le client n'a rien à payer en ligne. */
export const CONFIRMED = "Confirmée";

/** Où en est une demande qui n'attend plus de réponse. */
export const OUTCOME: Partial<Record<BookingStatus, (b: Booking) => string>> = {
  awaiting_deposit: () => "Validée, acompte attendu",
  confirmed: (b) => (hasBookingDeposit(b) ? "Validée, acompte reçu" : CONFIRMED),
  refused: () => "Refusée",
  expired: () => "Expirée, la date est libérée",
  cancelled: () => "Annulée",
};

/** La demande telle que le propriétaire l'a reçue, avec ses boutons. */
export const asked = (deps: Deps, b: Booking): Edit => renderTelegram(REQUEST_ALERT, b, { baseUrl: deps.env.BASE_URL });

/** La demande, suivie d'une ligne d'état et sans bouton. L'échéance de réponse en est retirée : elle ne vaut plus rien. */
export const settled = (deps: Deps, b: Booking, line: string): Edit => ({
  html: `${asked(deps, { ...b, hold_until: null }).html}\n\n<b>${line}</b>`,
});

/** Les alertes mises à jour par passage : bien plus qu'il n'y a de demandes traitées entre deux passages. */
const PER_PASS = 20;

/**
 * Telegram refuse pour de bon de modifier le message : il a été supprimé, il porte déjà ce texte, le bot est bloqué. Il
 * n'y a plus rien à tenter. Une panne (réseau, 5xx, 429) se retente au passage suivant.
 */
const isFinal = (error: unknown): boolean =>
  error instanceof ServiceRefusal && error.status >= 400 && error.status < 500 && error.status !== 429;

/** Une panne se consigne par ce qu'elle est, jamais par un message qui pourrait citer un client. */
const failure = (error: unknown): string =>
  error instanceof ServiceRefusal ? error.message : error instanceof Error ? error.name : "erreur inconnue";

/**
 * Met à jour les alertes dont la demande n'attend plus de réponse : chacune perd ses boutons et dit où en est la demande,
 * puis n'est plus retenue. Appelée à chaque envoi des messages dus (après chaque action et par la tâche automatique) :
 * une alerte que Telegram n'a pas pu modifier reste retenue, et sera reprise au passage suivant. Ne lève jamais.
 */
export async function settleAlerts(deps: Deps): Promise<void> {
  const db = deps.env.DB;
  try {
    for (const alert of await listSettledAlerts(db, PER_PASS)) {
      try {
        const b = await getBooking(db, alert.booking_id);
        const line = b && OUTCOME[b.status]?.(b);
        if (b && line) await deps.telegram.edit(alert.chat_id, alert.message_id, settled(deps, b, line).html);
      } catch (error) {
        if (!isFinal(error)) {
          console.error(`Alerte Telegram, mise à jour : ${failure(error)}`);
          continue;
        }
      }
      await dropAlert(db, alert.chat_id, alert.message_id);
    }
  } catch (error) {
    console.error(`Alerte Telegram, mise à jour : ${failure(error)}`);
  }
}
