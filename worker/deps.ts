import type { Env } from "./env";
import { simulatedGateway } from "./simulated-payment";

export type EmailMessage = { to: string; subject: string; text: string; html: string };

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

/**
 * Les dépendances réelles. Le vrai Stripe (tâche 20), les messages et Turnstile (tâche 9) et l'accès propriétaire
 * (tâche 12) les remplacent. D'ici là, seul `PAYMENT_MODE=simulated` branche un paiement, factice.
 */
export function makeDeps(env: Env): Deps {
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
    email: { send: notWired("email.send") },
    telegram: {
      send: notWired("telegram.send"),
      edit: notWired("telegram.edit"),
      answer: notWired("telegram.answer"),
    },
    verifyTurnstile: async () => "unavailable",
    isOwner: () => false,
  };
}
