import type { BookingStatus } from "./bookings";
import type { Button } from "./deps";
import { escapeHtml, formatDay, formatEuros, formatMoment } from "./html";
import type { Template } from "./notifications";
import { offer, planById } from "./offer";
import type { Booking } from "./repository";

/** `upcoming` : les prestations du point du lundi, que l'appelant lit dans la base. */
export type MessageContext = { baseUrl: string; upcoming?: Booking[] };

type Channel = "email" | "telegram";

/** Un morceau de ligne : du texte, un mot en gras, ou un lien. Chaque format écrit les trois à sa façon. */
type Piece = string | { bold: string } | { link: string; url: string };

/**
 * Un paragraphe, une ligne par élément. `only` le réserve à un canal. `list` marque une liste dont Telegram
 * abrège la fin s'il le faut.
 */
type Block = { lines: Piece[][]; only?: Channel; list?: true };

/** Un message avant sa mise en forme : le même texte sert à l'e-mail (texte et HTML) et à Telegram. */
type Message = { subject: string; blocks: Block[]; buttons?: Button[][] };

// ---------- les morceaux ----------

const para = (...pieces: Piece[]): Block => ({ lines: [pieces] });

/** « Libellé : valeur », une ligne par valeur renseignée. */
const facts = (rows: readonly (readonly [label: string, value: string | null | undefined])[], only?: Channel): Block => ({
  lines: rows.flatMap(([label, value]) => (value ? [[{ bold: label }, " : ", value]] : [])),
  only,
});

const action = (label: string, url: string): Block => para({ link: label, url });

const absolute = (ctx: MessageContext, path: string): string => new URL(path, ctx.baseUrl).toString();
const adminUrl = (b: Booking, ctx: MessageContext): string => absolute(ctx, `/admin#${b.id}`);
/** Le lien du client porte le jeton, jamais l'identifiant de la réservation. */
const paymentUrl = (b: Booking, ctx: MessageContext): string => absolute(ctx, `/acompte/${b.token}`);

const day = (b: Booking): string => formatDay(b.event_date);
const euros = (cents: number | null): string => formatEuros(cents ?? 0);
export const planName = (b: Booking): string | null => planById(b.plan ?? "")?.name ?? b.plan;
/** Ce qui reste à régler après l'acompte, en euros ; zéro une fois le solde réglé. */
export const balance = (b: Booking): string =>
  euros(b.balance_paid_at ? 0 : Math.max(0, (b.price_cents ?? 0) - (b.deposit_cents ?? 0)));
/** « jusqu'au mardi 10 novembre à 11 h », ou rien quand la date n'a pas d'échéance. */
const through = (b: Booking): string => (b.hold_until ? ` jusqu'au ${formatMoment(b.hold_until)}` : "");

type Row = [label: string, value: string | null];

/** Ce que le client a demandé, lu dans la réservation à jour. */
const eventRows = (b: Booking): Row[] => [
  ["Date", day(b)],
  ["Formule", planName(b)],
  ["Type", b.event_type],
  ["Lieu", b.venue],
  ["Horaires", b.event_hours],
];

/** « Une question ? », avec les coordonnées de l'offre quand elles sont renseignées. */
function contact(): Block[] {
  const { phone, email } = offer.contact;
  const ways: Piece[][] = [];
  if (phone) ways.push(["nous appeler au ", { link: phone, url: `tel:${phone.replace(/[^+\d]/g, "")}` }]);
  if (email) ways.push(["nous écrire à ", { link: email, url: `mailto:${email}` }]);
  if (ways.length === 0) return [];
  return [para("Une question ? Vous pouvez ", ...ways.flatMap((way, i) => (i === 0 ? way : [" ou ", ...way])), ".")];
}

const SIGNATURE: Block = { lines: [["À bientôt,"], ["L'équipe Brotobooth"]] };

/** Un message au client : salutation par son nom, puis le corps, les coordonnées et la signature. */
const forClient = (b: Booking, subject: string, ...body: Block[]): Message => ({
  subject,
  blocks: [para(b.client_name ? `Bonjour ${b.client_name},` : "Bonjour,"), ...body, ...contact(), SIGNATURE],
});

/** Sans réponse, la date est libérée à l'échéance. */
const expiry = (b: Booking): Block[] =>
  b.hold_until ? [para(`Sans réponse avant le ${formatMoment(b.hold_until)}, la date sera libérée.`)] : [];

// ---------- les modèles ----------

type BookingTemplate = Exclude<Template, "owner_digest">;
type Build = (b: Booking, ctx: MessageContext) => Message;

/** Les rappels du propriétaire avant la prestation : le lieu, les horaires, le téléphone et le solde à encaisser. */
const eventReminder =
  (title: string): Build =>
  (b, ctx) => ({
    subject: `${title} : ${day(b)}`,
    blocks: [
      facts([
        ["Client", b.client_name],
        ["Lieu", b.venue],
        ["Horaires", b.event_hours],
        ["Téléphone", b.client_phone],
        ["Solde restant", balance(b)],
      ]),
      action("Ouvrir la fiche", adminUrl(b, ctx)),
    ],
  });

const BOOKING_MESSAGES: Record<BookingTemplate, Build> = {
  client_received: (b) =>
    forClient(
      b,
      `Votre demande pour le ${day(b)}`,
      para(`Nous avons bien reçu votre demande pour le ${day(b)}.`),
      para(`Nous gardons cette date pour vous et nous vous répondons sous ${offer.reviewHours} h. Rien à payer pour l'instant.`),
      facts(eventRows(b)),
    ),

  client_refused: (b, ctx) =>
    forClient(
      b,
      `Votre demande pour le ${day(b)}`,
      para(`Nous ne pouvons malheureusement pas assurer notre prestation le ${day(b)}, et nous vous prions de nous en excuser.`),
      para("Si une autre date vous convient, vous pouvez faire une nouvelle demande :"),
      action("Choisir une autre date", absolute(ctx, "/reserver")),
    ),

  client_deposit_link: (b, ctx) =>
    forClient(
      b,
      `Votre acompte pour le ${day(b)}`,
      para(`Nous pouvons assurer votre prestation le ${day(b)}.`),
      para(`Pour la confirmer, réglez l'acompte de ${euros(b.deposit_cents)}. Votre date est gardée pour vous${through(b)}.`),
      action(`Payer l'acompte de ${euros(b.deposit_cents)}`, paymentUrl(b, ctx)),
      para("La date est confirmée dès que l'acompte est payé."),
    ),

  client_deposit_reminder: (b, ctx) =>
    forClient(
      b,
      "Plus que 24 h pour votre acompte",
      para(`Votre date du ${day(b)} reste gardée pour vous${through(b)}. Passé ce délai, elle ne sera plus réservée.`),
      action(`Payer l'acompte de ${euros(b.deposit_cents)}`, paymentUrl(b, ctx)),
    ),

  client_confirmed: (b) =>
    forClient(
      b,
      `C'est confirmé pour le ${day(b)}`,
      para(`Merci, votre acompte de ${euros(b.deposit_cents)} est bien reçu : votre date est confirmée.`),
      facts([
        ...eventRows(b),
        ["Prix", euros(b.price_cents)],
        ["Acompte réglé", euros(b.deposit_cents)],
        ["Solde restant", balance(b)],
      ]),
    ),

  client_released: (b, ctx) =>
    forClient(
      b,
      `Votre demande pour le ${day(b)}`,
      para(`Le délai est passé : la date du ${day(b)} n'est plus réservée pour vous.`),
      para("Si elle est encore libre, vous pouvez refaire une demande :"),
      action("Refaire une demande", absolute(ctx, "/reserver")),
    ),

  client_unanswered: (b, ctx) =>
    forClient(
      b,
      `Votre demande pour le ${day(b)}`,
      para(`Nous sommes désolés : nous n'avons pas pu vous répondre à temps, et la date du ${day(b)} n'est plus réservée pour vous.`),
      para("Si elle est encore libre, vous pouvez refaire une demande ou nous appeler :"),
      action("Refaire une demande", absolute(ctx, "/reserver")),
    ),

  client_cancelled: (b) =>
    forClient(b, `Votre réservation du ${day(b)}`, para(`Votre réservation du ${day(b)} est annulée. La date n'est plus réservée pour vous.`)),

  client_d7: (b) =>
    forClient(
      b,
      "Votre photobooth arrive dans une semaine",
      para(`Plus qu'une semaine : nous serons là le ${day(b)}.`),
      facts([...eventRows(b), ["Solde restant", balance(b)]]),
    ),

  owner_new_request: (b, ctx) => {
    const open = adminUrl(b, ctx);
    return {
      subject: `Nouvelle demande pour le ${day(b)}`,
      blocks: [
        facts([
          ["Type", b.event_type],
          ["Formule", planName(b)],
          ["Lieu", b.venue],
          ["Client", b.client_name],
          ["Téléphone", b.client_phone],
        ]),
        // Telegram ne reçoit ni l'adresse ni le message du client (spec, section 9) : l'e-mail les donne.
        facts(
          [
            ["E-mail", b.client_email],
            ["Message", b.message],
          ],
          "email",
        ),
        ...expiry(b),
        { ...action("Ouvrir la demande", open), only: "email" },
      ],
      buttons: [
        [
          { text: "Valider", data: `v:${b.id}` },
          { text: "Refuser", data: `r:${b.id}` },
        ],
        [{ text: "Ajuster le prix", url: open }],
      ],
    };
  },

  owner_review_reminder: (b, ctx) => ({
    subject: `Demande en attente pour le ${day(b)}`,
    blocks: [
      para("Cette demande attend toujours votre réponse."),
      facts([
        ["Client", b.client_name],
        ["Type", b.event_type],
        ["Formule", planName(b)],
        ["Lieu", b.venue],
      ]),
      ...expiry(b),
      action("Ouvrir la demande", adminUrl(b, ctx)),
    ],
  }),

  owner_deposit_paid: (b, ctx) => ({
    subject: `Acompte reçu pour le ${day(b)}`,
    blocks: [
      facts([
        ["Client", b.client_name],
        ["Formule", planName(b)],
        ["Acompte", euros(b.deposit_cents)],
        ["Solde restant", balance(b)],
        ["Téléphone", b.client_phone],
      ]),
      action("Ouvrir la fiche", adminUrl(b, ctx)),
    ],
  }),

  owner_released: (b) => ({
    subject: `Date libérée : ${day(b)}`,
    blocks: [
      para("Le délai est passé : la date est de nouveau libre."),
      facts([
        ["Client", b.client_name],
        ["Formule", planName(b)],
      ]),
    ],
  }),

  owner_d7: eventReminder("Dans une semaine"),
  owner_d1: eventReminder("Demain"),

  owner_late_payment: (b, ctx) => ({
    subject: `Paiement à rembourser : ${day(b)}`,
    blocks: [
      para("Ce client a payé son acompte alors que la date n'était plus réservée pour lui. Remboursez-le depuis Stripe, puis prévenez-le."),
      facts([
        ["Client", b.client_name],
        ["Date", day(b)],
        ["Acompte payé", euros(b.deposit_cents)],
        ["Téléphone", b.client_phone],
      ]),
      facts([["E-mail", b.client_email]], "email"),
      action("Ouvrir la fiche", adminUrl(b, ctx)),
    ],
  }),

  owner_email_failed: (b, ctx) => ({
    subject: `Un e-mail n'est pas parti pour la prestation du ${day(b)}`,
    blocks: [
      para("Un e-mail destiné à ce client n'a pas pu être envoyé après plusieurs essais. Contactez-le directement : les essais se poursuivent."),
      facts([
        ["Client", b.client_name],
        ["Téléphone", b.client_phone],
      ]),
      facts([["E-mail", b.client_email]], "email"),
      action("Ouvrir la fiche", adminUrl(b, ctx)),
    ],
  }),
};

/** Ce que le propriétaire lit d'une prestation à venir, d'après son état. */
const OWNER_STATUS: Partial<Record<BookingStatus, string>> = {
  pending_review: "à traiter",
  awaiting_deposit: "acompte attendu",
  confirmed: "confirmée",
};

const digestLine = (b: Booking): Piece[] => [
  "• ",
  day(b),
  " : ",
  b.client_name ?? "client inconnu",
  ...(b.venue ? [`, ${b.venue}`] : []),
  ` (${OWNER_STATUS[b.status] ?? b.status})`,
];

/** Le point du lundi : il n'est lié à aucune réservation, il liste celles que l'appelant fournit. */
function digest(ctx: MessageContext): Message {
  const upcoming = ctx.upcoming ?? [];
  const count = upcoming.length;
  return {
    subject: "Point du lundi : les prestations à venir",
    blocks: [
      para(count === 0 ? "Aucune prestation à venir : le calendrier est libre." : `${count} prestation${count > 1 ? "s" : ""} à venir :`),
      { lines: upcoming.map(digestLine), list: true },
      action("Ouvrir l'administration", absolute(ctx, "/admin")),
    ],
  };
}

function build(template: string, b: Booking | null, ctx: MessageContext): Message {
  if (template === "owner_digest") return digest(ctx);
  if (!Object.hasOwn(BOOKING_MESSAGES, template)) throw new Error(`modèle inconnu : ${template}`);
  if (!b) throw new Error(`${template} : réservation manquante`);
  return BOOKING_MESSAGES[template as BookingTemplate](b, ctx);
}

// ---------- la mise en forme ----------

const isWeb = (url: string): boolean => /^https?:/.test(url);
const visible = (m: Message, channel: Channel): Block[] =>
  m.blocks.filter((block) => block.lines.length > 0 && (block.only ?? channel) === channel);

const joined = (block: Block, piece: (p: Piece) => string, glue: string): string =>
  block.lines.map((line) => line.map(piece).join("")).join(glue);

/** En texte brut, seule une adresse web s'écrit : le numéro et l'adresse e-mail d'un lien sont déjà son texte. */
const plain = (p: Piece): string =>
  typeof p === "string" ? p : "bold" in p ? p.bold : isWeb(p.url) ? `${p.link} : ${p.url}` : p.link;

/** Toute valeur est échappée ; `bold` est la balise du gras, `linkable` dit quelles adresses deviennent des liens. */
const markup =
  (bold: string, linkable: (url: string) => boolean) =>
  (p: Piece): string => {
    if (typeof p === "string") return escapeHtml(p);
    if ("bold" in p) return `<${bold}>${escapeHtml(p.bold)}</${bold}>`;
    return linkable(p.url) ? `<a href="${escapeHtml(p.url)}">${escapeHtml(p.link)}</a>` : escapeHtml(p.link);
  };

const emailMarkup = markup("strong", () => true);
const telegramMarkup = markup("b", isWeb);

/** L'objet tient sur une ligne, quoi qu'il contienne. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function renderEmail(template: string, b: Booking | null, ctx: MessageContext): { subject: string; text: string; html: string } {
  const message = build(template, b, ctx);
  const blocks = visible(message, "email");
  const subject = oneLine(message.subject);
  return {
    subject,
    text: blocks.map((block) => joined(block, plain, "\n")).join("\n\n"),
    html: `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111111">
${blocks.map((block) => `<p style="margin:0 0 16px">${joined(block, emailMarkup, "<br>")}</p>`).join("\n")}
</body></html>`,
  };
}

/** Telegram refuse un message de plus de 4096 caractères. */
const TELEGRAM_LIMIT = 4096;

/** La liste `block` réduite à `keep` lignes, avec un renvoi vers l'administration pour le reste. */
const abridged = (block: Block, keep: number): Block =>
  block.list && block.lines.length > keep
    ? { lines: [...block.lines.slice(0, keep), [`… et ${block.lines.length - keep} autres, à retrouver dans l'administration.`]] }
    : block;

export function renderTelegram(template: string, b: Booking | null, ctx: MessageContext): { html: string; buttons?: Button[][] } {
  const message = build(template, b, ctx);
  const blocks = visible(message, "telegram");
  const write = (keep: number): string =>
    [`<b>${escapeHtml(oneLine(message.subject))}</b>`, ...blocks.map((block) => joined(abridged(block, keep), telegramMarkup, "\n"))].join("\n\n");

  // Seule une liste trop longue (le point du lundi) perd ses dernières lignes, le temps de tenir dans la limite.
  let keep = Math.max(0, ...blocks.map((block) => block.lines.length));
  let html = write(keep);
  while (html.length > TELEGRAM_LIMIT && keep > 0) html = write(--keep);
  return { html, buttons: message.buttons };
}
