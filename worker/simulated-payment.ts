import type { Deps, StripeGateway, StripeSession } from "./deps";
import type { Env } from "./env";
import { escapeHtml, formatDay, formatEuros, page } from "./html";
import { html, json, readText, redirect } from "./http";
import { acomptePath, recordPayment } from "./payments";
import { getBookingByToken, getState, setState, type Booking } from "./repository";

/** Chaque session vit dans `system_state` : un autre appel du Worker la retrouve, comme chez Stripe. */
const stateKey = (id: string): string => `sim_session:${id}`;

function store(env: Env, now: () => Date) {
  return {
    /** La session telle que Stripe la montrerait : ouverte jusqu'à son terme, expirée ensuite. */
    async get(id: string): Promise<StripeSession | null> {
      const raw = await getState(env.DB, stateKey(id));
      if (raw === null) return null;
      const session = JSON.parse(raw) as StripeSession;
      const over = session.status === "open" && now().getTime() >= session.expiresAt * 1000;
      return over ? { ...session, status: "expired", url: null } : session;
    },
    put: (session: StripeSession): Promise<void> => setState(env.DB, stateKey(session.id), JSON.stringify(session)),
  };
}

/**
 * Un Stripe pour essayer le site : mêmes méthodes, mêmes états, aucun paiement. `now` donne l'heure à laquelle
 * une session ouverte arrive à son terme, comme l'horloge de Stripe pour la vraie.
 */
export function simulatedGateway(env: Env, now: () => Date = () => new Date()): StripeGateway {
  const sessions = store(env, now);
  const read = async (id: string): Promise<StripeSession> => {
    const session = await sessions.get(id);
    if (!session) throw new Error(`simulation : session inconnue ${id}`);
    return session;
  };
  return {
    async createSession(a) {
      const id = `cs_sim_${crypto.randomUUID().replaceAll("-", "")}`;
      const session: StripeSession = {
        id,
        url: new URL(`${acomptePath(a.token)}/simulation?session=${id}`, env.BASE_URL).toString(),
        status: "open",
        paymentStatus: "unpaid",
        expiresAt: a.expiresAt,
        bookingId: a.bookingId,
      };
      await sessions.put(session);
      return session;
    },
    retrieveSession: read,
    async expireSession(id) {
      const session = await read(id);
      // Comme Stripe : une session payée ou déjà fermée ne s'expire pas.
      if (session.status !== "open") throw new Error("simulation : la session n'est plus ouverte");
      await sessions.put({ ...session, status: "expired", url: null });
    },
    async verifyWebhook() {
      throw new Error("simulation : pas de webhook, le paiement passe par la page de simulation");
    },
  };
}

const notFound = (): Response => json({ error: "not_found" }, 404);

/** La réservation du jeton et sa session, si le paiement simulé est actif et que la session est bien la sienne. */
async function target(req: Request, deps: Deps, token: string): Promise<{ booking: Booking; session: StripeSession } | null> {
  if (deps.env.PAYMENT_MODE !== "simulated") return null;
  const id = new URL(req.url).searchParams.get("session");
  const booking = await getBookingByToken(deps.env.DB, token);
  const session = booking && id ? await store(deps.env, () => deps.now()).get(id) : null;
  return booking && session?.bookingId === booking.id ? { booking, session } : null;
}

/** `GET /acompte/<jeton>/simulation?session=<id>` : la page de paiement factice. */
export async function simulationPage(req: Request, deps: Deps, token: string): Promise<Response> {
  const found = await target(req, deps, token);
  if (!found) return notFound();
  const { booking, session } = found;
  if (session.status !== "open") return redirect(acomptePath(token)); // rien à payer sur cette session

  const action = `${acomptePath(token)}/simulation?session=${encodeURIComponent(session.id)}`;
  return html(
    page(
      "Simulation du paiement – Brotobooth",
      `<section class="sim">
<h1>Simulation</h1>
<p class="notice"><strong>Aucun paiement réel.</strong> Cette page remplace la page de paiement pour essayer le site : aucune carte n'est demandée et aucun argent ne bouge.</p>
<div class="card"><dl class="recap"><dt>Acompte</dt><dd class="amount">${formatEuros(booking.deposit_cents ?? 0)}</dd><dt>Date</dt><dd>${escapeHtml(formatDay(booking.event_date))}</dd></dl></div>
<form class="stack" method="post" action="${escapeHtml(action)}">
<button class="btn primary" type="submit" name="outcome" value="paid">Simuler un paiement réussi</button>
<button class="btn ghost" type="submit" name="outcome" value="abandon">Abandonner</button>
</form>
</section>`,
    ),
  );
}

/** Le bouton pressé, ou `null` si le corps n'en nomme aucun. */
async function outcomeOf(req: Request): Promise<"paid" | "abandon" | null> {
  const body = await readText(req, 1024);
  const outcome = body.ok ? new URLSearchParams(body.value).get("outcome") : null;
  return outcome === "paid" || outcome === "abandon" ? outcome : null;
}

/**
 * `POST /acompte/<jeton>/simulation?session=<id>`. « Paiement réussi » fait ce que Stripe ferait : la session
 * est payée, la réservation confirmée comme par le webhook, puis le client revient sur sa page. « Abandonner »
 * revient sans payer, la session reste ouverte et se rouvre par le même lien.
 */
export async function simulationAction(req: Request, deps: Deps, token: string): Promise<Response> {
  const found = await target(req, deps, token);
  if (!found) return notFound();
  const outcome = await outcomeOf(req);
  if (!outcome) return json({ error: "invalid_outcome" }, 400);
  if (outcome === "abandon" || found.session.status !== "open") return redirect(acomptePath(token));

  const paid: StripeSession = { ...found.session, status: "complete", paymentStatus: "paid", url: null };
  await store(deps.env, () => deps.now()).put(paid);
  await recordPayment(deps, paid);
  return redirect(`${acomptePath(token)}?paid=1`);
}
