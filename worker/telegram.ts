import type { BookingStatus } from "./bookings";
import type { Button, Deps, TelegramGateway } from "./deps";
import { chatIds, type Env } from "./env";
import { callServiceOk, json, jsonPost, readJson, secretMatches } from "./http";
import { sendSoon } from "./notifications";
import { refuseBooking, validateBooking } from "./operations";
import { getBooking, type Booking } from "./repository";
import { renderTelegram } from "./templates";

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

// ---------- les boutons ----------

const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
/** Une mise à jour de Telegram tient en quelques centaines d'octets : au-delà, ce n'est pas une mise à jour. */
const MAX_UPDATE_BYTES = 64 * 1024;

/** `true` si la requête porte le secret du webhook. */
const hasSecret = (req: Request, env: Env): Promise<boolean> =>
  secretMatches(req.headers.get(SECRET_HEADER), env.TELEGRAM_WEBHOOK_SECRET);

/** L'appui sur un bouton d'un message du bot : ce que Telegram en dit, rien de plus. */
type Tap = { id: string; data: string; chatId: string; messageId: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Le bouton touché d'une mise à jour, ou `null` si elle n'en porte pas, ou pas sous la forme attendue. */
function parseTap(update: unknown): Tap | null {
  const query = isRecord(update) ? update.callback_query : null;
  if (!isRecord(query) || !isRecord(query.message) || !isRecord(query.message.chat)) return null;
  const { id, data } = query;
  const { message_id: messageId } = query.message;
  const chat = query.message.chat.id;
  if (typeof id !== "string" || typeof data !== "string" || typeof messageId !== "number") return null;
  if (typeof chat !== "number" && typeof chat !== "string") return null;
  return { id, data, chatId: String(chat), messageId };
}

/** `toast` : la phrase que le propriétaire lit un instant. `edit` : le nouveau contenu du message, sans bouton s'il n'en a pas. */
type Reply = { toast?: string; edit?: { html: string; buttons?: Button[][] } };

/** Où en est une demande qui n'attend plus de réponse. */
const OUTCOME: Partial<Record<BookingStatus, string>> = {
  awaiting_deposit: "Validée, acompte attendu",
  confirmed: "Validée, acompte reçu",
  refused: "Refusée",
  expired: "Expirée, la date est libérée",
  cancelled: "Annulée",
};

/** La demande telle que le propriétaire l'a reçue, avec ses boutons. */
const asked = (deps: Deps, b: Booking) => renderTelegram("owner_new_request", b, { baseUrl: deps.env.BASE_URL });

/** La demande, suivie d'une ligne d'état et sans bouton. L'échéance de réponse en est retirée : elle ne vaut plus rien. */
const settled = (deps: Deps, b: Booking, line: string): Reply["edit"] => ({
  html: `${asked(deps, { ...b, hold_until: null }).html}\n\n<b>${line}</b>`,
});

/**
 * Le bouton touché ne s'applique plus : on le dit en une phrase, et le message montre l'état actuel, sans
 * bouton. `b` est la réservation relue, `null` si elle n'existe plus ou n'a jamais été une demande à traiter.
 */
function stale(deps: Deps, b: Booking | null): Reply {
  const line = b && OUTCOME[b.status];
  if (!b || !line) return { toast: "Cette demande n'est plus disponible." };
  return {
    toast: b.status === "expired" ? "Cette demande n'est plus disponible : elle a expiré." : "Cette demande est déjà traitée.",
    edit: settled(deps, b, line),
  };
}

type Action = (deps: Deps, ctx: ExecutionContext, id: string) => Promise<Reply>;

/** Valide ou refuse la demande, puis envoie sans attendre ce que cela met en file. Une demande déjà traitée n'envoie rien. */
const decide =
  (run: typeof validateBooking, done: string): Action =>
  async (deps, ctx, id) => {
    const result = await run(deps, id, "owner");
    if (!result.ok) return stale(deps, await getBooking(deps.env.DB, id));
    sendSoon(ctx, deps);
    return { toast: done, edit: settled(deps, result.booking, done) };
  };

/** Une réponse qui ne change rien à la réservation, tant qu'elle attend encore la réponse du propriétaire. */
const whilePending =
  (reply: (deps: Deps, b: Booking) => NonNullable<Reply["edit"]>): Action =>
  async (deps, _ctx, id) => {
    const b = await getBooking(deps.env.DB, id);
    return b?.status === "pending_review" ? { edit: reply(deps, b) } : stale(deps, b);
  };

/** Les boutons du bot, par le code qui précède `:` dans leur donnée. */
const ACTIONS: Record<string, Action> = {
  v: decide(validateBooking, "Validée, le client reçoit son lien de paiement"),
  rc: decide(refuseBooking, "Refusée, le client en est informé"),
  // Refuser libère la date : on demande d'abord confirmation, et rien n'est écrit.
  r: whilePending((deps, b) => ({
    html: `${asked(deps, b).html}\n\n<b>Refuser cette demande ?</b> La date sera libérée et le client en sera informé.`,
    buttons: [
      [
        { text: "Oui, refuser", data: `rc:${b.id}` },
        { text: "Renoncer", data: `x:${b.id}` },
      ],
    ],
  })),
  x: whilePending(asked),
};

/** Une panne de Telegram ne défait pas ce que l'appui a fait : elle est consignée, sans rien d'autre que son message. */
const tolerate = (what: string, call: () => Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(call)
    .catch((error) => console.error(`Bouton Telegram, ${what} : ${error instanceof Error ? error.message : "erreur inconnue"}`));

/** La donnée de chaque bouton du bot : un code, `:`, puis l'identifiant de la réservation. */
const BUTTON_DATA = /^([a-z]+):([\w-]+)$/;

/**
 * Applique l'appui d'un bouton, puis répond toujours à Telegram (le bouton cesse de tourner) et met le message à jour.
 * Seuls les chats du propriétaire agissent : un autre chat reçoit une réponse muette.
 */
async function handleTap(deps: Deps, ctx: ExecutionContext, tap: Tap): Promise<void> {
  const owner = chatIds(deps.env).includes(tap.chatId);
  if (!owner) console.error("Appui Telegram ignoré : chat non autorisé");

  const [, code, id] = BUTTON_DATA.exec(tap.data) ?? [];
  const reply: Reply = owner && code && Object.hasOwn(ACTIONS, code) ? await ACTIONS[code](deps, ctx, id) : {};

  const { edit } = reply;
  await Promise.all([
    tolerate("réponse", () => deps.telegram.answer(tap.id, reply.toast)),
    edit && tolerate("modification", () => deps.telegram.edit(tap.chatId, tap.messageId, edit.html, edit.buttons)),
  ]);
}

/**
 * `POST /api/telegram/webhook` : 401 si le secret ne se vérifie pas, 200 sinon, y compris pour une mise à jour
 * ou un bouton ignoré, pour que Telegram ne la renvoie pas.
 */
export async function telegramWebhook(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  if (!(await hasSecret(req, deps.env))) {
    // Sans trace, un secret erroné ferait ignorer tous les boutons en silence.
    console.error("Webhook Telegram refusé : secret non vérifié");
    return json({ error: "unauthorized" }, 401);
  }
  const body = await readJson(req, MAX_UPDATE_BYTES);
  const tap = body.ok ? parseTap(body.value) : null;
  if (tap) await handleTap(deps, ctx, tap);
  return json({ ok: true });
}
