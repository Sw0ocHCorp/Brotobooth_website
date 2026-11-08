// Branche le bot Telegram sur le Worker : les boutons des messages arrivent ensuite sur POST /api/telegram/webhook.
// À lancer une fois après chaque changement d'adresse ou de secret :
//   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… BASE_URL=https://brotobooth.fr node scripts/set-telegram-webhook.mjs
// Le jeton n'est jamais écrit : ni dans la sortie, ni dans un message d'erreur.

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "BASE_URL"];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) fail(`Variables d'environnement manquantes : ${missing.join(", ")}`);
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, BASE_URL: baseUrl } = process.env;

let webhook;
try {
  webhook = new URL("/api/telegram/webhook", baseUrl);
} catch {
  fail("BASE_URL n'est pas une adresse valide.");
}
// Telegram n'appelle qu'une adresse en HTTPS.
if (webhook.protocol !== "https:") fail("BASE_URL doit commencer par https://.");

let response;
try {
  response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhook.toString(), secret_token: secret, allowed_updates: ["callback_query"] }),
  });
} catch (error) {
  // Le message d'origine peut citer l'adresse appelée, qui porte le jeton : seul le type de la panne est écrit.
  fail(`Telegram est injoignable (${error instanceof Error ? error.name : "erreur inconnue"}).`);
}

const result = await response.json().catch(() => null);
if (!response.ok || result?.ok !== true) {
  const reason = typeof result?.description === "string" ? ` : ${result.description}` : "";
  fail(`Telegram a refusé le webhook (${response.status}${reason}).`);
}
console.log(`Webhook Telegram branché sur ${webhook}`);
