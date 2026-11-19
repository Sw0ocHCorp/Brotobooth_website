export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BASE_URL: string;
  OWNER_EMAIL: string;
  FROM_EMAIL: string;
  ACCESS_AUD: string;
  /** Le domaine de l'équipe Cloudflare Access (`TEAM_DOMAIN_FORMAT`) : ses clés publiques signent le jeton du propriétaire (`worker/access.ts`). */
  ACCESS_TEAM_DOMAIN: string;
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

/** Le domaine d'une équipe Access : `<équipe>.cloudflareaccess.com`, en minuscules, sans protocole, chemin ni autre hôte. Le contrôle d'avant publication exige la même forme. */
export const TEAM_DOMAIN_FORMAT = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;

/** Les chats du propriétaire, d'après `TELEGRAM_CHAT_IDS` (identifiants séparés par des virgules). */
export const chatIds = (env: Env): string[] =>
  (env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
