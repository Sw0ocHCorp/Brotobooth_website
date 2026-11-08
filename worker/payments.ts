import type { Deps, StripeSession } from "./deps";
import { escapeHtml, formatDay, formatEuros, formatMoment, page } from "./html";
import { html, json, readText, redirect, type Handler } from "./http";
import { offer } from "./offer";
import { attachSession, confirmDeposit } from "./operations";
import {
  enqueue,
  getBooking,
  getBookingByToken,
  type Booking,
  type NotificationSpec,
} from "./repository";

/**
 * Une session Checkout dure 30 minutes (la spec, section 4). Stripe n'en accepte pas moins de 30 minutes à
 * compter de sa création : le vrai branchement (tâche 20) devra vérifier cette limite à l'appel.
 */
const SESSION_SECONDS = 30 * 60;
/** Un événement Stripe tient en quelques Ko : au-delà, ce n'est pas un événement. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export const acomptePath = (token: string): string => `/acompte/${token}`;

/** Les pannes sont consignées par leur nom seulement : un message de Stripe peut citer l'adresse du client. */
export const logFailure = (what: string, error: unknown): void =>
  console.error(`${what} : ${error instanceof Error ? error.name : "erreur inconnue"}`);

/** Le client peut payer : la réservation attend son acompte et l'échéance n'est pas atteinte. */
const payable = (b: Booking, now: Date): boolean =>
  b.status === "awaiting_deposit" && (b.hold_until === null || b.hold_until > now.toISOString());

// ---------- la page ----------

/** « Une question ? Appelez-nous au … ou écrivez-nous à … », sans ce que l'offre ne renseigne pas encore. */
function contactHtml(): string {
  const { phone, email } = offer.contact;
  const ways = [
    phone && `appelez-nous au <a href="tel:${escapeHtml(phone.replace(/[^+\d]/g, ""))}">${escapeHtml(phone)}</a>`,
    email && `écrivez-nous à <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`,
  ].filter((way): way is string => Boolean(way));
  if (ways.length === 0) return "";
  const sentence = ways.join(" ou ");
  return `<p class="contact">Une question ? ${sentence[0].toUpperCase()}${sentence.slice(1)}.</p>`;
}

const link = (href: string, text: string): string => `<a class="btn primary" href="${href}">${text}</a>`;

/** Un titre, des paragraphes de HTML sûr, des actions éventuelles, puis le contact. */
const view = (title: string, ...parts: string[]): string =>
  page(`${title} – Brotobooth`, `<h1>${escapeHtml(title)}</h1>${parts.join("")}${contactHtml()}`);

const untilDeadline = (b: Booking): string =>
  b.hold_until ? ` jusqu'au ${formatMoment(b.hold_until)}` : "";

const notFoundPage = (): Response =>
  html(
    view(
      "Page introuvable",
      "<p>Ce lien ne correspond à aucune réservation. Vérifiez l'adresse reçue par e-mail, ou contactez-nous.</p>",
    ),
    404,
  );

const unavailablePage = (b: Booking): Response =>
  html(
    view(
      "Le paiement en ligne est momentanément indisponible",
      `<p>Votre date reste gardée pour vous${untilDeadline(b)}. Réessayez dans quelques minutes : le même lien fonctionne, vous n'avez rien à refaire.</p>`,
      `<div class="stack">${link(acomptePath(b.token), "Réessayer")}</div>`,
    ),
    503,
  );

const row = (label: string, value: string | null): string =>
  value ? `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>` : "";

function payView(b: Booking): string {
  const deposit = formatEuros(b.deposit_cents ?? 0);
  return view(
    "Votre acompte",
    `<p>${b.client_name ? `Bonjour ${escapeHtml(b.client_name)}, nous` : "Nous"} pouvons assurer votre prestation. Votre date est gardée pour vous${untilDeadline(b)} : elle sera confirmée dès que l'acompte sera réglé.</p>`,
    `<div class="card"><dl class="recap">${row("Date", formatDay(b.event_date))}${row("Lieu", b.venue)}<dt>Acompte</dt><dd class="amount">${deposit}</dd></dl></div>`,
    `<form class="stack" method="post" action="${escapeHtml(acomptePath(b.token))}"><button class="btn primary" type="submit">Payer l'acompte de ${deposit}</button></form>`,
    "<p>Vous serez redirigé vers une page de paiement sécurisée.</p>",
  );
}

/** Ce que dit la page d'une réservation qui n'attend pas (ou plus) d'acompte. */
function statusView(b: Booking, verifying: boolean): string {
  const day = formatDay(b.event_date);
  const reserve = (text: string) => `<div class="stack">${link("/reserver", text)}</div>`;
  if (verifying) {
    return view(
      "Nous vérifions votre paiement",
      "<p>Nous n'avons pas encore reçu la confirmation de votre paiement. Si vous venez de payer, patientez un instant puis actualisez cette page : il n'est pas nécessaire de payer une seconde fois.</p>",
      `<div class="stack">${link(acomptePath(b.token) + "?paid=1", "Actualiser")}</div>`,
    );
  }
  switch (b.status) {
    case "pending_review":
      return view(
        "Votre demande est bien reçue",
        `<p>Nous étudions votre demande pour le ${day}. Vous recevrez notre réponse par e-mail bientôt, sous ${offer.reviewHours} h au plus tard. Il n'y a rien à payer pour l'instant.</p>`,
      );
    case "confirmed":
      return view(
        "Votre date est confirmée",
        `<p>Nous avons bien reçu votre acompte de <span class="amount">${formatEuros(b.deposit_cents ?? 0)}</span>. La date du ${day} est à vous, un e-mail de confirmation vous est envoyé.</p>`,
      );
    case "cancelled":
      return view("Cette réservation a été annulée", `<p>La date du ${day} n'est plus réservée.</p>`);
    case "refused":
      return view(
        "Nous n'avons pas pu retenir cette date",
        `<p>Nous sommes désolés : nous ne pouvons pas assurer notre prestation le ${day}. Vous pouvez choisir une autre date.</p>`,
        reserve("Choisir une autre date"),
      );
    default:
      return view(
        "Cette date n'est plus réservée",
        `<p>Le délai est passé : la date du ${day} n'est plus réservée pour vous. Si elle est encore libre, vous pouvez refaire une demande ou nous appeler.</p>`,
        reserve("Refaire une demande"),
      );
  }
}

/**
 * Le client revient de la page de paiement : si Stripe confirme que la session est payée, la réservation l'est
 * aussi, sans attendre le webhook. Une panne de Stripe laisse la réservation telle quelle.
 */
async function settleReturn(deps: Deps, b: Booking): Promise<Booking> {
  if (!b.stripe_session) return b;
  let session: StripeSession;
  try {
    session = await deps.stripe.retrieveSession(b.stripe_session);
  } catch (error) {
    logFailure("Retour de paiement", error);
    return b;
  }
  if (session.paymentStatus !== "paid") return b;
  await recordPayment(deps, session);
  return (await getBooking(deps.env.DB, b.id)) ?? b;
}

/** `GET /acompte/<jeton>` : le récapitulatif à payer, ou ce qu'il en est de la réservation. */
export async function paymentPage(req: Request, deps: Deps, token: string): Promise<Response> {
  let booking = await getBookingByToken(deps.env.DB, token);
  if (!booking || booking.status === "blocked") return notFoundPage();

  const returning = booking.status === "awaiting_deposit" && new URL(req.url).searchParams.get("paid") === "1";
  if (returning) booking = await settleReturn(deps, booking);

  // Revenu de la page de paiement sans que Stripe confirme : on ne propose pas de payer une seconde fois.
  const verifying = returning && booking.status === "awaiting_deposit";
  return html(!verifying && payable(booking, deps.now()) ? payView(booking) : statusView(booking, verifying));
}

// ---------- la session de paiement ----------

const checkoutUrl = (session: StripeSession): string => {
  if (!session.url) throw new Error("session sans adresse de paiement");
  return session.url;
};

/** Envoie le client vers la session ouverte, ou en ouvre une. */
async function checkout(deps: Deps, b: Booking, now: Date): Promise<Response> {
  const existing = b.stripe_session ? await deps.stripe.retrieveSession(b.stripe_session) : null;
  if (existing?.paymentStatus === "paid") {
    // Payée, mais le webhook n'est pas encore là : le client n'a rien à payer de plus.
    await recordPayment(deps, existing);
    return redirect(`${acomptePath(b.token)}?paid=1`);
  }
  if (existing?.status === "open") return redirect(checkoutUrl(existing));

  const created = await deps.stripe.createSession({
    bookingId: b.id,
    token: b.token,
    email: b.client_email,
    amountCents: b.deposit_cents ?? 0,
    label: `Acompte pour le ${formatDay(b.event_date)}`,
    expiresAt: Math.floor(now.getTime() / 1000) + SESSION_SECONDS,
  });
  const attached = await attachSession(deps, b.id, created);
  if (!attached.ok) {
    // La date a changé d'état pendant l'appel : la session ne sert à rien. Si elle ne se ferme pas, elle expire seule.
    await deps.stripe.expireSession(created.id).catch(() => {});
    return redirect(acomptePath(b.token));
  }
  return redirect(checkoutUrl(created));
}

/** `POST /acompte/<jeton>` : renvoie le client vers sa session de paiement, ouverte au besoin. */
export async function startPayment(_req: Request, deps: Deps, token: string): Promise<Response> {
  const booking = await getBookingByToken(deps.env.DB, token);
  if (!booking || booking.status === "blocked") return notFoundPage();
  const now = deps.now();
  if (!payable(booking, now)) return redirect(acomptePath(token)); // la page dit pourquoi
  try {
    return await checkout(deps, booking, now);
  } catch (error) {
    // Stripe ou la base en panne : la date reste tenue, rien n'a été écrit.
    logFailure("Session de paiement", error);
    return unavailablePage(booking);
  }
}

// ---------- le paiement reçu ----------

const LATE_CHANNELS = ["telegram", "email"] as const;

/** Une alerte par canal et par session : le même webhook rejoué n'en ajoute aucune. */
const lateAlerts = (bookingId: string, sessionId: string, now: Date): NotificationSpec[] =>
  LATE_CHANNELS.map((channel) => ({
    booking_id: bookingId,
    dedupe_key: `late:${sessionId}:${channel}`,
    channel,
    recipient: "owner",
    template: "owner_late_payment",
    due_at: now.toISOString(),
  }));

/**
 * Le client a payé `session`. La réservation passe à `confirmed` si elle attend cet acompte, et rejouer
 * l'appel ne change rien. Si elle ne l'attend plus (date libérée, annulée, déjà payée par une autre session),
 * rien n'est écrasé : le propriétaire est alerté, pour rembourser depuis Stripe.
 */
export async function recordPayment(deps: Deps, session: StripeSession): Promise<void> {
  if (!session.bookingId) return;
  const confirmed = await confirmDeposit(deps, session.bookingId, "stripe");
  if (confirmed.ok || confirmed.reason !== "stale") return;

  // Relue après l'échec : la confirmation d'un rejeu, ou du retour du client arrivé en même temps, est déjà faite.
  const booking = await getBooking(deps.env.DB, session.bookingId);
  if (!booking || (booking.deposit_paid_at !== null && booking.stripe_session === session.id)) return;
  await enqueue(deps.env.DB, lateAlerts(booking.id, session.id, deps.now()));
}

/** `POST /api/stripe/webhook` : 400 si la signature ne se vérifie pas, 200 sinon, y compris pour un événement ignoré. */
export const stripeWebhook: Handler = async (req, deps) => {
  const body = await readText(req, MAX_WEBHOOK_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);

  let event: Awaited<ReturnType<Deps["stripe"]["verifyWebhook"]>>;
  try {
    event = await deps.stripe.verifyWebhook(body.value, req.headers.get("Stripe-Signature") ?? "");
  } catch {
    // Sans trace, un secret de webhook erroné ferait refuser tous les paiements en silence.
    console.error("Webhook Stripe refusé : signature non vérifiée");
    return json({ error: "invalid_signature" }, 400);
  }
  if (event.type === "checkout.session.completed" && event.session?.paymentStatus === "paid") {
    await recordPayment(deps, event.session);
  }
  return json({ received: true });
};
