import type { EmailGateway } from "./deps";
import type { Env } from "./env";
import { callServiceOk, jsonPost } from "./http";

const RESEND_URL = "https://api.resend.com/emails";

/** Les e-mails partent par Resend. Toute réponse qui n'est pas 2xx lève : la notification sera reprise. */
export function resendGateway(env: Env, fetchFn: typeof fetch = fetch): EmailGateway {
  return {
    async send(m) {
      const body = { from: env.FROM_EMAIL, to: [m.to], subject: m.subject, text: m.text, html: m.html };
      await callServiceOk("Resend", fetchFn, RESEND_URL, jsonPost(body, { Authorization: `Bearer ${env.RESEND_API_KEY}` }));
    },
  };
}
