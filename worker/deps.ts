import { demoGateways, withDemoRecipients } from "./demo";
import { resendGateway } from "./email";
import type { Env } from "./env";
import { callService } from "./http";
import { simulatedGateway } from "./simulated-payment";
import { telegramGateway } from "./telegram";

/**
 * `idempotencyKey` : la même clé, répétée, ne fait envoyer le message qu'une fois (Resend la retient 24 h). `replyTo` :
 * l'adresse à laquelle « Répondre » écrit, quand ce n'est pas celle de Brotobooth (le visiteur d'un message de contact).
 */
export type EmailMessage = { to: string; subject: string; text: string; html: string; idempotencyKey?: string; replyTo?: string };

export type EmailGateway = { send(m: EmailMessage): Promise<void> };

export type Button = { text: string; data?: string; url?: string };

export type TelegramGateway = {
  send(chatId: string, html: string, buttons?: Button[][]): Promise<void>;
  edit(chatId: string, messageId: number, html: string, buttons?: Button[][]): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
};

export type StripeSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  expiresAt: number;
  bookingId: string | null;
};

export type StripeGateway = {
  createSession(a: {
    bookingId: string;
    token: string;
    email: string | null;
    amountCents: number;
    label: string;
    expiresAt: number;
  }): Promise<StripeSession>;
  retrieveSession(id: string): Promise<StripeSession>;
  expireSession(id: string): Promise<void>;
  verifyWebhook(rawBody: string, signature: string): Promise<{ type: string; session: StripeSession | null }>;
};

/** Tout ce que le Worker emprunte au monde extérieur : les tests le remplacent par `fakeDeps`. */
export type Deps = {
  env: Env;
  now(): Date;
  stripe: StripeGateway;
  email: EmailGateway;
  telegram: TelegramGateway;
  verifyTurnstile(token: string, ip: string | null): Promise<"pass" | "fail" | "unavailable">;
  isOwner(ctx: ExecutionContext): boolean;
};

/** Une méthode de passerelle pas encore branchée : elle lève à l'appel, jamais à la création. */
const notWired = (method: string) => async (): Promise<never> => {
  throw new Error(`${method} : passerelle pas encore branchée`);
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Les codes d'erreur de siteverify qui disent que le secret du site est absent ou faux, non que le visiteur est un robot. */
const SECRET_ERRORS = ["missing-input-secret", "invalid-input-secret"];

/**
 * Le vrai Turnstile. `siteverify` est toujours interrogé, même pour un jeton vide : un robot qui omet le jeton
 * obtient `fail`. Une panne du service, réseau ou 5xx, donne `unavailable` et ne coûte jamais une demande.
 * Ni le jeton ni le secret ne sont écrits dans les journaux.
 */
export function turnstileVerifier(env: Env, fetchFn: typeof fetch = fetch): Deps["verifyTurnstile"] {
  return async (token, ip) => {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) form.set("remoteip", ip);

    let res: Response;
    try {
      res = await callService("Turnstile", fetchFn, SITEVERIFY_URL, { method: "POST", body: form });
    } catch (error) {
      console.error((error as Error).message);
      return "unavailable";
    }
    if (res.status >= 500) {
      console.error(`Turnstile a répondu ${res.status}`);
      return "unavailable";
    }
    const verdict = await res.json<{ success?: boolean; "error-codes"?: string[] }>().catch(() => null);
    if (verdict === null) {
      console.error("Turnstile : réponse illisible");
      return "unavailable";
    }
    // Un secret absent ou faux est une erreur de configuration du site, pas un robot : elle ne refuse aucun client,
    // et se voit dans les journaux.
    const codes = Array.isArray(verdict["error-codes"]) ? verdict["error-codes"] : [];
    const refused = codes.filter((code) => SECRET_ERRORS.includes(code));
    if (refused.length > 0) {
      console.error(`Turnstile : ${refused.join(", ")}`);
      return "unavailable";
    }
    return verdict.success === true ? "pass" : "fail";
  };
}

/**
 * Les dépendances réelles. Le vrai Stripe (tâche 20) les remplacera. D'ici là, seul `PAYMENT_MODE=simulated`
 * branche un paiement, factice. `FAKE_GATEWAYS=1` remplace les e-mails, Telegram et Turnstile par des
 * passerelles d'essai dont `/demo` montre les messages.
 */
export function makeDeps(realEnv: Env): Deps {
  const demo = realEnv.FAKE_GATEWAYS === "1";
  const env = demo ? withDemoRecipients(realEnv) : realEnv;
  const now = () => new Date();
  return {
    env,
    now,
    stripe:
      env.PAYMENT_MODE === "simulated"
        ? simulatedGateway(env, now)
        : {
            createSession: notWired("stripe.createSession"),
            retrieveSession: notWired("stripe.retrieveSession"),
            expireSession: notWired("stripe.expireSession"),
            verifyWebhook: notWired("stripe.verifyWebhook"),
          },
    ...(demo
      ? demoGateways(env, now)
      : { email: resendGateway(env), telegram: telegramGateway(env), verifyTurnstile: turnstileVerifier(env) }),
    // Cloudflare Access a laissé passer la requête pour cette application : son public (`aud`) est celui attendu.
    // Sans `ACCESS_AUD`, personne n'est le propriétaire : deux publics absents ne s'accorderaient pas.
    isOwner: (ctx) => Boolean(env.ACCESS_AUD) && ctx.access?.aud === env.ACCESS_AUD,
  };
}
