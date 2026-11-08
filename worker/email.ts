import type { EmailGateway } from "./deps";
import type { Env } from "./env";
import { callServiceOk, jsonPost } from "./http";
import { offer } from "./offer";

const RESEND_URL = "https://api.resend.com/emails";

/**
 * Les e-mails partent par Resend. Toute réponse qui n'est pas 2xx lève : la notification sera reprise. La clé
 * d'idempotence du message, si elle existe, évite qu'une reprise (réponse perdue, base en panne après l'envoi)
 * n'envoie le même e-mail deux fois. Une réponse à un e-mail part vers l'adresse de contact de l'offre, ou à défaut vers
 * celle du propriétaire : l'expéditeur (`FROM_EMAIL`) n'est qu'une adresse d'envoi.
 */
export function resendGateway(env: Env, fetchFn: typeof fetch = fetch): EmailGateway {
  return {
    async send({ to, subject, text, html, idempotencyKey }) {
      const headers = {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      };
      const replyTo = offer.contact.email || env.OWNER_EMAIL;
      const body = { from: env.FROM_EMAIL, to: [to], ...(replyTo && { reply_to: replyTo }), subject, text, html };
      await callServiceOk("Resend", fetchFn, RESEND_URL, jsonPost(body, headers));
    },
  };
}
