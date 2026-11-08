import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { makeDeps, type Deps } from "../../worker/deps";
import type { Env } from "../../worker/env";
import { getBooking, getHistory, getState, setState, type Booking } from "../../worker/repository";
import { handle } from "../../worker/router";
import { simulatedGateway } from "../../worker/simulated-payment";
import { T0, fakeDeps, resetDb, validatedBooking, type FakeDeps } from "../support";

const BASE = "https://brotobooth.fr";

type SimDeps = Deps & Pick<FakeDeps, "setNow" | "emails" | "telegrams">;

/** Des dépendances de test dont Stripe est le paiement simulé, avec l'horloge des tests. */
function simulatedDeps(vars: Pick<Env, "PAYMENT_MODE"> = { PAYMENT_MODE: "simulated" }): SimDeps {
  const e: Env = { ...env, ...vars };
  const base = fakeDeps({ env: e });
  const deps: SimDeps = { ...base, stripe: simulatedGateway(e, () => deps.now()) };
  return deps;
}

let deps: SimDeps;
let v: Booking;
let logged: MockInstance<Console["error"]>;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = simulatedDeps();
  v = await validatedBooking(deps);
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

/** Une requête au Worker. Les messages d'un paiement partent après la réponse : le test attend leur fin. */
async function send(path: string, init?: RequestInit, d: Deps = deps): Promise<Response> {
  const background = createExecutionContext();
  const response = await handle(new Request(`${BASE}${path}`, init), d, background);
  await waitOnExecutionContext(background);
  return response;
}

const form = (outcome: string) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ outcome }),
});

const current = async () => (await getBooking(env.DB, v.id))!;
const simulationPath = (token: string, session: string) => `/acompte/${token}/simulation?session=${session}`;

/** Le client clique « Payer » : renvoie l'adresse de la page de paiement factice et l'identifiant de session. */
async function start(booking: Booking = v): Promise<{ path: string; session: string }> {
  const r = await send(`/acompte/${booking.token}`, { method: "POST" });
  expect(r.status).toBe(303);
  const session = (await getBooking(env.DB, booking.id))!.stripe_session!;
  return { path: simulationPath(booking.token, session), session };
}

const stored = async (session: string) => JSON.parse((await getState(env.DB, `sim_session:${session}`))!);

describe("le parcours complet, sans Stripe", () => {
  it("le parcours complet fonctionne sans Stripe", async () => {
    const opened = await send(`/acompte/${v.token}`, { method: "POST" });
    expect(opened.status).toBe(303);
    const { stripe_session: session } = await current();
    expect(opened.headers.get("location")).toBe(`${BASE}${simulationPath(v.token, session!)}`);

    const page = await send(simulationPath(v.token, session!));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1>Simulation</h1>");
    expect(html).toContain("Aucun paiement réel");
    expect(html).toContain("450,00 €");
    expect(html).toContain("Simuler un paiement réussi");
    expect(html).toContain("Abandonner");

    const paid = await send(simulationPath(v.token, session!), form("paid"));
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toBe(`/acompte/${v.token}?paid=1`);
    expect((await current()).status).toBe("confirmed");
    expect((await getHistory(env.DB, v.id)).at(-1)).toMatchObject({ actor: "stripe", event: "paid" });

    const done = await (await send(`/acompte/${v.token}?paid=1`)).text();
    expect(done).toContain("date est confirmée");
  });

  it("le paiement simulé envoie la confirmation au client et l'alerte au propriétaire, une seule fois", async () => {
    const { path } = await start();
    await send(path, form("abandon"));
    expect(deps.emails).toHaveLength(0);

    await send(path, form("paid"));
    expect(deps.emails.map((m) => m.subject).sort()).toEqual([
      "Acompte reçu pour le samedi 19 décembre",
      "C'est confirmé pour le samedi 19 décembre",
    ]);
    expect(deps.emails.find((m) => m.subject.startsWith("C'est confirmé"))!.to).toBe(v.client_email);
    await send(`/acompte/${v.token}?paid=1`);
    expect(deps.emails).toHaveLength(2);
  });

  it("la page de simulation se distingue d'un vrai paiement et n'a qu'un bouton plein", async () => {
    const { path } = await start();
    const html = await (await send(path)).text();
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html.match(/class="btn primary"/g)).toHaveLength(1);
    expect(html).toContain('name="outcome" value="paid"');
    expect(html).toContain('name="outcome" value="abandon"');
    expect(html).not.toContain("<script");
  });

  it("abandonner laisse la date tenue et le lien réutilisable", async () => {
    const { path, session } = await start();
    const before = await current();
    const left = await send(path, form("abandon"));
    expect(left.status).toBe(303);
    expect(left.headers.get("location")).toBe(`/acompte/${v.token}`);

    const after = await current();
    expect(after.status).toBe("awaiting_deposit");
    expect(after.hold_until).toBe(before.hold_until);
    expect((await stored(session)).status).toBe("open");

    // Nouvelle tentative : la même session est rouverte, pas une seconde.
    const again = await send(`/acompte/${v.token}`, { method: "POST" });
    expect(again.headers.get("location")).toBe(`${BASE}${path}`);
    expect((await current()).stripe_session).toBe(session);
  });

  it("une session payée ne se paie pas deux fois, un second clic revient à la page", async () => {
    const { path } = await start();
    await send(path, form("paid"));
    const again = await send(path, form("paid"));
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`/acompte/${v.token}`);
    expect((await getHistory(env.DB, v.id)).filter((h) => h.event === "paid")).toHaveLength(1);
    const page = await send(path);
    expect(page.status).toBe(303); // plus rien à payer sur cette session
  });

  it("une session expirée par la tâche automatique ne se paie plus", async () => {
    const { path, session } = await start();
    await deps.stripe.expireSession(session);
    const paid = await send(path, form("paid"));
    expect(paid.headers.get("location")).toBe(`/acompte/${v.token}`);
    expect((await current()).status).toBe("awaiting_deposit");
    expect((await stored(session)).status).toBe("expired");
  });

  it("une session arrivée à son terme ne se paie plus, comme chez Stripe", async () => {
    const { path } = await start();
    deps.setNow("2026-11-07T10:30:00.000Z"); // 30 minutes après l'ouverture
    const paid = await send(path, form("paid"));
    expect(paid.headers.get("location")).toBe(`/acompte/${v.token}`);
    expect((await current()).status).toBe("awaiting_deposit");
  });

  it("répond 400 à une issue inconnue ou absente, sans rien changer", async () => {
    const { path, session } = await start();
    expect((await send(path, form("rembourser"))).status).toBe(400);
    expect((await send(path, { method: "POST" })).status).toBe(400);
    expect((await current()).status).toBe("awaiting_deposit");
    expect((await stored(session)).status).toBe("open");
  });

  it("refuse un envoi venu d'un autre site", async () => {
    const { path, session } = await start();
    const r = await send(path, { ...form("paid"), headers: { ...form("paid").headers, Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect((await current()).status).toBe("awaiting_deposit");
    expect((await stored(session)).status).toBe("open");
  });

  it("le webhook n'existe pas en simulation : il répond 400 et ne confirme rien", async () => {
    const { session } = await start();
    const r = await send("/api/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": "valid" },
      body: JSON.stringify({ type: "checkout.session.completed", sessionId: session }),
    });
    expect(r.status).toBe(400);
    expect((await current()).status).toBe("awaiting_deposit");
  });
});

describe("simulatedGateway", () => {
  const args = (booking: Booking, minutes = 30) => ({
    bookingId: booking.id,
    token: booking.token,
    email: booking.client_email,
    amountCents: booking.deposit_cents!,
    label: "Acompte",
    expiresAt: Date.parse(T0) / 1000 + minutes * 60,
  });

  it("createSession renvoie une session ouverte qui pointe vers la page de simulation", async () => {
    const s = await deps.stripe.createSession(args(v));
    expect(s).toEqual({
      id: s.id,
      url: `${BASE}${simulationPath(v.token, s.id)}`,
      status: "open",
      paymentStatus: "unpaid",
      expiresAt: Date.parse(T0) / 1000 + 1800,
      bookingId: v.id,
    });
    expect(s.id).toMatch(/^cs_sim_[0-9a-f]{32}$/);
  });

  it("retrieveSession et expireSession gardent leur état entre deux requêtes", async () => {
    const first = simulatedGateway(env as Env, () => deps.now());
    const second = simulatedGateway(env as Env, () => deps.now()); // une autre requête, un autre objet
    const s = await first.createSession(args(v));
    expect(await second.retrieveSession(s.id)).toEqual(s);
    expect(await stored(s.id)).toMatchObject({ status: "open" });

    await second.expireSession(s.id);
    expect(await first.retrieveSession(s.id)).toMatchObject({ status: "expired", url: null, paymentStatus: "unpaid" });
    expect(await stored(s.id)).toMatchObject({ status: "expired", url: null });
  });

  it("une session payée par la page reste payée à la relecture", async () => {
    const { path, session } = await start();
    await send(path, form("paid"));
    expect(await deps.stripe.retrieveSession(session)).toMatchObject({
      status: "complete",
      paymentStatus: "paid",
      url: null,
      bookingId: v.id,
    });
    expect(await stored(session)).toMatchObject({ status: "complete", paymentStatus: "paid" });
  });

  it("une session ouverte devient expirée à son terme, sans que personne ne l'ait fermée", async () => {
    const s = await deps.stripe.createSession(args(v));
    deps.setNow("2026-11-07T10:29:59.000Z");
    expect(await deps.stripe.retrieveSession(s.id)).toMatchObject({ status: "open" });
    deps.setNow("2026-11-07T10:30:00.000Z");
    expect(await deps.stripe.retrieveSession(s.id)).toMatchObject({ status: "expired", url: null });
  });

  it("expireSession lève une erreur sur une session déjà payée, comme Stripe", async () => {
    const { path, session } = await start();
    await send(path, form("paid"));
    await expect(deps.stripe.expireSession(session)).rejects.toThrow();
    expect(await stored(session)).toMatchObject({ status: "complete", paymentStatus: "paid" });
  });

  it("expireSession lève aussi sur une session déjà expirée ou inconnue", async () => {
    const s = await deps.stripe.createSession(args(v));
    await deps.stripe.expireSession(s.id);
    await expect(deps.stripe.expireSession(s.id)).rejects.toThrow();
    await expect(deps.stripe.expireSession("cs_sim_absente")).rejects.toThrow();
    await expect(deps.stripe.retrieveSession("cs_sim_absente")).rejects.toThrow();
  });

  it("verifyWebhook lève toujours : il n'y a pas de webhook en simulation", async () => {
    await expect(deps.stripe.verifyWebhook("{}", "valid")).rejects.toThrow();
  });

  it("makeDeps ne branche le paiement simulé que si PAYMENT_MODE vaut simulated", async () => {
    const simulated = makeDeps({ ...env, PAYMENT_MODE: "simulated" });
    expect(await simulated.stripe.createSession(args(v))).toMatchObject({ status: "open" });

    for (const mode of [undefined, "", "live", "Simulated"]) {
      const real = makeDeps({ ...env, PAYMENT_MODE: mode });
      await expect(real.stripe.createSession(args(v))).rejects.toThrow("pas encore branchée");
    }
  });
});

describe("/acompte/<jeton>/simulation : accès", () => {
  it("la page de simulation répond 404 si PAYMENT_MODE n'est pas simulated", async () => {
    const { path, session } = await start();
    for (const vars of [{}, { PAYMENT_MODE: "" }, { PAYMENT_MODE: "live" }]) {
      const closed = simulatedDeps(vars);
      expect((await send(path, undefined, closed)).status).toBe(404);
      expect((await send(path, form("paid"), closed)).status).toBe(404);
    }
    expect((await current()).status).toBe("awaiting_deposit");
    expect((await stored(session)).status).toBe("open");
  });

  it("une session d'une autre réservation est refusée", async () => {
    const other = await validatedBooking(deps, { event_date: "2026-12-20" });
    const mine = await start(v);
    const theirs = await start(other);

    expect((await send(simulationPath(v.token, theirs.session))).status).toBe(404);
    const r = await send(simulationPath(v.token, theirs.session), form("paid"));
    expect(r.status).toBe(404);
    expect((await current()).status).toBe("awaiting_deposit");
    expect((await getBooking(env.DB, other.id))!.status).toBe("awaiting_deposit");
    expect((await stored(theirs.session)).status).toBe("open");
    expect((await stored(mine.session)).status).toBe("open");
  });

  it("une session inconnue, absente ou une réservation inconnue donnent 404", async () => {
    const { session } = await start();
    expect((await send(simulationPath(v.token, "cs_sim_absente"))).status).toBe(404);
    expect((await send(`/acompte/${v.token}/simulation`)).status).toBe(404);
    expect((await send(simulationPath("jeton-inconnu", session))).status).toBe(404);
  });

  it("une session sans réservation liée est refusée", async () => {
    await setState(
      env.DB,
      "sim_session:cs_sim_orpheline",
      JSON.stringify({ id: "cs_sim_orpheline", url: null, status: "open", paymentStatus: "unpaid", expiresAt: 9e9, bookingId: null }),
    );
    expect((await send(simulationPath(v.token, "cs_sim_orpheline"))).status).toBe(404);
  });
});
