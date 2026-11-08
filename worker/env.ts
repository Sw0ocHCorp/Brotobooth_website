export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
  OWNER_EMAIL: string;
  FROM_EMAIL: string;
  ACCESS_AUD: string;
  TURNSTILE_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_CHAT_IDS: string;
  CALENDAR_TOKEN: string;
  IP_HASH_SALT: string;
  FAKE_GATEWAYS?: string;
  /** `simulated` : paiement factice, sans Stripe. Toute autre valeur, ou aucune : le vrai paiement. */
  PAYMENT_MODE?: string;
}

/** Les chats du propriétaire, d'après `TELEGRAM_CHAT_IDS` (identifiants séparés par des virgules). */
export const chatIds = (env: Env): string[] =>
  (env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
