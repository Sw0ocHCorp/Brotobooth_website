import type { Button, Deps } from "./deps";
import { chatIds, type Env } from "./env";
import { escapeHtml, formatMoment, page } from "./html";
import { html, json, type Handler } from "./http";
import { getState, setState } from "./repository";

/** Le propriétaire d'essai : ni adresse ni chat réels n'existent encore. */
const DEMO_OWNER_EMAIL = "proprietaire@demo.test";
const DEMO_CHAT_ID = "demo";

const STATE_KEY = "demo_messages";
const KEEP_MESSAGES = 50;

/** Un message que le site aurait envoyé : `subject` est vide pour Telegram, qui n'en a pas. */
export type DemoMessage = {
  at: string;
  channel: "email" | "telegram";
  to: string;
  subject: string;
  text: string;
  buttons?: Button[][];
};

/** L'environnement d'essai : sans adresse ni chat configurés, le propriétaire en reçoit un d'essai. */
export const withDemoRecipients = (env: Env): Env => ({
  ...env,
  OWNER_EMAIL: env.OWNER_EMAIL || DEMO_OWNER_EMAIL,
  TELEGRAM_CHAT_IDS: chatIds(env).length > 0 ? env.TELEGRAM_CHAT_IDS : DEMO_CHAT_ID,
});

/** Les messages gardés, le plus récent d'abord. Une valeur absente ou illisible donne une liste vide. */
async function load(env: Env): Promise<DemoMessage[]> {
  try {
    const messages: unknown = JSON.parse((await getState(env.DB, STATE_KEY)) ?? "[]");
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };

/** Ce que lirait le propriétaire dans Telegram : les balises `<b>` et `<a>` retirées, l'adresse d'un lien gardée. */
const telegramText = (markup: string): string =>
  markup
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, "$2 ($1)")
    .replace(/<\/?b>/g, "")
    .replace(/&(?:lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity]);

/**
 * Les passerelles d'essai (`FAKE_GATEWAYS=1`) : rien ne part, Turnstile répond pass, et les 50 derniers messages
 * se gardent dans `system_state` pour que `/demo` les montre.
 */
export function demoGateways(env: Env, now: () => Date): Pick<Deps, "email" | "telegram" | "verifyTurnstile"> {
  const keep = async (message: Omit<DemoMessage, "at">): Promise<void> => {
    const messages = [{ at: now().toISOString(), ...message }, ...(await load(env))];
    await setState(env.DB, STATE_KEY, JSON.stringify(messages.slice(0, KEEP_MESSAGES)));
  };
  return {
    email: { send: (m) => keep({ channel: "email", to: m.to, subject: m.subject, text: m.text }) },
    telegram: {
      send: (chatId, markup, buttons) =>
        keep({ channel: "telegram", to: chatId, subject: "", text: telegramText(markup), buttons }),
      edit: (chatId, _messageId, markup, buttons) =>
        keep({ channel: "telegram", to: chatId, subject: "Message modifié", text: telegramText(markup), buttons }),
      answer: (_callbackId, text) => keep({ channel: "telegram", to: "", subject: "Réponse au bouton", text: text ?? "" }),
    },
    verifyTurnstile: async () => "pass",
  };
}

// ---------- la page ----------

const PAGE_STYLE = `<style>
.demo-text { margin-top: 14px; padding: 14px 16px; border-radius: 16px; background: var(--row); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.page .demo-text a { text-decoration: underline; }
.demo-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.demo-buttons .btn { min-height: 44px; padding: 8px 18px; }
.demo-buttons .pill { min-height: 44px; display: inline-flex; align-items: center; padding: 8px 18px; }
</style>`;

/** `true` si `url` est sur le site : même schéma, même hôte et même port que `BASE_URL`. */
function isOnSite(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const link = (url: string, label: string, attributes = ""): string =>
  `<a${attributes} href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

/** Les adresses `http` et `https`, sans la ponctuation qui les termine dans une phrase. */
const ADDRESSES = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)]/g;

/** Le texte échappé, avec en lien cliquable chaque adresse du site. Les autres restent du texte. */
function linkify(text: string, origin: string): string {
  let out = "";
  let from = 0;
  for (const match of text.matchAll(ADDRESSES)) {
    out += escapeHtml(text.slice(from, match.index));
    out += isOnSite(match[0], origin) ? link(match[0], match[0]) : escapeHtml(match[0]);
    from = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(from));
}

const button = (b: Button, origin: string): string =>
  b.url && isOnSite(b.url, origin)
    ? link(b.url, b.text, ' class="btn ghost"')
    : `<span class="pill">${escapeHtml(b.text)}</span>`;

const row = (label: string, value: string): string => (value ? `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>` : "");

function card(m: DemoMessage, origin: string): string {
  const email = m.channel === "email";
  const buttons = (m.buttons ?? []).flat();
  return `<article class="card">
<dl class="recap">${row("Canal", email ? "E-mail" : "Telegram")}${row("Destinataire", m.to && !email ? `Chat ${m.to}` : m.to)}${row("Objet", m.subject)}${row("Envoyé", formatMoment(m.at))}</dl>
<div class="demo-text">${linkify(m.text, origin)}</div>${
    buttons.length > 0 ? `\n<div class="demo-buttons">${buttons.map((b) => button(b, origin)).join("")}</div>` : ""
  }
</article>`;
}

/** `GET /demo` : ce que le site aurait envoyé. Sans `FAKE_GATEWAYS=1`, la page n'existe pas. */
export const demoPage: Handler = async (_req, deps) => {
  if (deps.env.FAKE_GATEWAYS !== "1") return json({ error: "not_found" }, 404);
  const origin = new URL(deps.env.BASE_URL).origin;
  const messages = await load(deps.env);
  return html(
    page(
      "Messages d'essai – Brotobooth",
      `${PAGE_STYLE}
<h1>Messages d'essai</h1>
<p>Voici, du plus récent au plus ancien, les e-mails et les messages Telegram que le site aurait envoyés. Rien n'est réellement parti.</p>
${messages.length > 0 ? messages.map((m) => card(m, origin)).join("\n") : "<p>Aucun message pour l'instant.</p>"}`,
    ),
  );
};
