import type { Button, TelegramGateway } from "./deps";
import type { Env } from "./env";
import { callServiceOk, jsonPost } from "./http";

/** Les chats du propriétaire, d'après `TELEGRAM_CHAT_IDS` (identifiants séparés par des virgules). */
export const chatIds = (env: Env): string[] =>
  (env.TELEGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

/** Le clavier de Telegram : un bouton à lien ouvre son adresse, les autres renvoient leur donnée au bot. */
const keyboard = (buttons: Button[][]) =>
  buttons.map((row) => row.map(({ text, data, url }) => (url ? { text, url } : { text, callback_data: data })));

/**
 * Le bot Telegram du propriétaire. Les textes sont du HTML limité à `<b>` et `<a>`, dont les valeurs sont
 * échappées par les modèles. Toute réponse qui n'est pas 2xx lève, sans citer l'adresse appelée (elle porte le jeton).
 */
export function telegramGateway(env: Env, fetchFn: typeof fetch = fetch): TelegramGateway {
  const call = (method: string, body: Record<string, unknown>) =>
    callServiceOk("Telegram", fetchFn, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, jsonPost(body)).then(
      () => undefined,
    );
  return {
    send: (chatId, html, buttons) =>
      call("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        ...(buttons && { reply_markup: { inline_keyboard: keyboard(buttons) } }),
      }),
    // Sans bouton, le clavier du message est retiré : une demande traitée n'offre plus rien à presser.
    edit: (chatId, messageId, html, buttons) =>
      call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard(buttons ?? []) },
      }),
    answer: (callbackId, text) => call("answerCallbackQuery", { callback_query_id: callbackId, text }),
  };
}
