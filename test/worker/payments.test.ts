import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BookingStatus } from "../../worker/bookings";
import type { StripeGateway } from "../../worker/deps";
import { offer } from "../../worker/offer";
import { cancelBooking, expireHold } from "../../worker/operations";
import { getBooking, getHistory, listDueNotifications, type Booking } from "../../worker/repository";
import { handle } from "../../worker/router";
import tokens from "../../public/styles/tokens.css?raw";
import { T0, fakeDeps, insert, newBooking, resetDb, validatedBooking, type FakeDeps } from "../support";

const ctx = createExecutionContext();
const PHONE = "06 12 34 56 78";
const DEADLINE = "2026-11-10T10:00:00.000Z";

let deps: FakeDeps;
let v: Booking;
let logged: MockInstance<Console["error"]>;
const savedContact = { ...offer.contact };
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
  v = await validatedBooking(deps);
  Object.assign(offer.contact, { phone: PHONE, email: "contact@example.test" });
  // Les pannes que les tests provoquent sont consignées : on les capte pour garder la sortie nette.
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(offer.contact, savedContact);
  logged.mockRestore();
});

const open = (t: string, init?: RequestInit) =>
  handle(new Request(`https://brotobooth.fr/acompte/${t}`, init), deps, ctx);

const post = (t: string, headers: Record<string, string> = {}) => open(t, { method: "POST", headers });

/** Le client ouvre une session de paiement ; renvoie son identifiant. */
async function start(): Promise<string> {
  expect((await post(v.token)).status).toBe(303);
  return (await getBooking(env.DB, v.id))!.stripe_session!;
}

/** Le faux Stripe appelle le webhook ; la signature « invalid » est refusée. */
const hook = (sessionId: string, over: { type?: string; signature?: string; body?: string } = {}) =>
  handle(
    new Request("https://brotobooth.fr/api/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": over.signature ?? "valid" },
      body: over.body ?? JSON.stringify({ type: over.type ?? "checkout.session.completed", sessionId }),
    }),
    deps,
    ctx,
  );

const current = async () => (await getBooking(env.DB, v.id))!;
const events = async () => (await getHistory(env.DB, v.id)).map((h) => h.event);
const lateAlerts = async () =>
  (await listDueNotifications(env.DB, T0, 50)).filter((n) => n.template === "owner_late_payment");

/** Une autre réservation, sur une autre date, dans l'état voulu : `v` tient déjà le 19 décembre. */
const withStatus = async (status: BookingStatus) =>
  (
    await insert(
      newBooking({
        status,
        event_date: "2026-12-26",
        hold_until: null,
        deposit_paid_at: status === "confirmed" ? T0 : null,
      }),
    )
  ).booking;

describe("GET /acompte/<jeton> : récapitulatif", () => {
  it("affiche le récapitulatif avec le montant de l'acompte", async () => {
    const html = await (await open(v.token)).text();
    expect(html).toContain("450,00 €");
    expect(html).toContain("19 décembre");
  });

  it("annonce la date limite à l'heure de Paris et propose de payer", async () => {
    const html = await (await open(v.token)).text();
    expect(html).toContain("mardi 10 novembre à 11 h");
    expect(html).toContain(`method="post" action="/acompte/${v.token}"`);
  });

  it("répond en HTML, sans cache, sans référent hors du site et sans script", async () => {
    const r = await open(v.token);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    // Pas `no-referrer` : un navigateur enverrait alors `Origin: null` pour les formulaires de la page, que le site refuse.
    expect(r.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
    const html = await r.text();
    expect(html).toContain('lang="fr"');
    expect(html).toContain('href="/styles/tokens.css"');
    expect(html).not.toContain("<script");
  });

  it("donne le téléphone et l'e-mail de contact, et omet ceux que l'offre ne renseigne pas encore", async () => {
    const html = await (await open(v.token)).text();
    expect(html).toContain(`href="tel:0612345678"`);
    expect(html).toContain(`href="mailto:contact@example.test"`);

    Object.assign(offer.contact, { phone: "", email: "" });
    const bare = await (await open(v.token)).text();
    expect(bare).not.toContain("tel:");
    expect(bare).not.toContain("mailto:");
    expect(bare).not.toContain("Appelez-nous");
  });

  it("échappe le nom et le lieu", async () => {
    const hostile = await validatedBooking(deps, {
      event_date: "2026-12-20",
      venue: "<img src=x onerror=alert(1)> & Co",
      client_name: "<script>alert(2)</script>",
    });
    const html = await (await open(hostile.token)).text();
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&amp; Co");
    expect(html).toContain("&lt;script&gt;alert(2)");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script");
  });

  it.each([
    ["pending_review", "bientôt"],
    ["confirmed", "date est confirmée"],
    ["expired", "plus réservée"],
    ["cancelled", "annulée"],
    ["refused", "pas pu"],
  ] as const)("en état %s, la page l'explique et ne propose pas de payer", async (status, text) => {
    const html = await (await open((await withStatus(status)).token)).text();
    expect(html).toContain(text);
    expect(html).not.toContain('method="post"');
  });

  it("une date non payée à l'échéance n'est plus proposée, même avant le passage de la tâche automatique", async () => {
    deps.setNow("2026-11-10T10:00:01.000Z");
    const html = await (await open(v.token)).text();
    expect(html).toContain("plus réservée");
    expect(html).not.toContain('method="post"');
  });

  it("un jeton inconnu donne une page 404 lisible, avec le téléphone de contact", async () => {
    const r = await open("jeton-inconnu");
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await r.text();
    expect(html).toContain("introuvable");
    expect(html).toContain(PHONE);
  });

  it("une date bloquée par le propriétaire n'a pas de page", async () => {
    const blocked = await withStatus("blocked");
    expect((await open(blocked.token)).status).toBe(404);
  });
});

describe("POST /acompte/<jeton> : session de paiement", () => {
  it("crée une session de 30 minutes et tient la date jusqu'à sa fin plus 5 minutes", async () => {
    deps.setNow("2026-11-10T09:50:00.000Z"); // 10 minutes avant l'échéance
    const r = await open(v.token, { method: "POST" });
    expect(r.status).toBe(303);
    const b = await current();
    expect(b.stripe_session_expires).toBe("2026-11-10T10:20:00.000Z");
    expect(b.hold_until).toBe("2026-11-10T10:25:00.000Z");
    expect(r.headers.get("location")).toBe(`https://checkout.stripe.test/c/pay/${b.stripe_session}`);
  });

  it("transmet à Stripe le montant, le jeton et l'e-mail, sans rien d'interne dans le libellé", async () => {
    const created: Parameters<StripeGateway["createSession"]>[0][] = [];
    const create = deps.stripe.createSession;
    deps.stripe.createSession = (a) => {
      created.push(a);
      return create(a);
    };
    await post(v.token);
    expect(created).toEqual([
      {
        bookingId: v.id,
        token: v.token,
        email: "camille@example.test",
        amountCents: 45_000,
        label: "Acompte pour le samedi 19 décembre",
        expiresAt: Date.parse(T0) / 1000 + 1800,
      },
    ]);
  });

  it("ne raccourcit jamais l'échéance : une session qui finit avant elle la laisse telle quelle", async () => {
    await post(v.token); // à T0, la session finit 3 jours avant l'échéance
    const b = await current();
    expect(b.stripe_session_expires).toBe("2026-11-07T10:30:00.000Z");
    expect(b.hold_until).toBe(DEADLINE);
  });

  it("note l'ouverture dans l'historique, au nom du client", async () => {
    await post(v.token);
    expect((await getHistory(env.DB, v.id)).at(-1)).toMatchObject({ actor: "client", event: "payment_session_opened" });
  });

  it("réutilise une session encore ouverte", async () => {
    const a = await post(v.token);
    const b = await post(v.token);
    expect(a.headers.get("location")).toBe(b.headers.get("location"));
    expect(deps.stripe.sessions.size).toBe(1);
  });

  it("ouvre une nouvelle session quand la précédente est terminée sans paiement", async () => {
    const first = await start();
    await deps.stripe.expireSession(first);
    const r = await post(v.token);
    expect(r.status).toBe(303);
    expect(deps.stripe.sessions.size).toBe(2);
    expect((await current()).stripe_session).not.toBe(first);
  });

  it("si la session a déjà été payée, le client est renvoyé vers sa confirmation", async () => {
    const s = await start();
    deps.stripe.completeSession(s); // le webhook n'est pas encore arrivé
    const r = await post(v.token);
    expect(r.headers.get("location")).toBe(`/acompte/${v.token}?paid=1`);
    expect((await current()).status).toBe("confirmed");
    expect(deps.stripe.sessions.size).toBe(1);
  });

  it("si Stripe est indisponible, la date reste tenue et un message s'affiche", async () => {
    deps.stripe.failNext("createSession");
    const r = await post(v.token);
    expect(r.status).toBe(503);
    const html = await r.text();
    expect(html).toContain("momentanément indisponible");
    expect(html).toContain(PHONE);
    const b = await current();
    expect(b.status).toBe("awaiting_deposit");
    expect(b.stripe_session).toBeNull();
    expect(b.hold_until).toBe(DEADLINE);
  });

  it("si Stripe est indisponible pour relire la session, rien n'est créé de plus", async () => {
    await start();
    deps.stripe.failNext("retrieveSession");
    expect((await post(v.token)).status).toBe(503);
    expect(deps.stripe.sessions.size).toBe(1);
  });

  it("ne consigne ni nom ni adresse quand Stripe échoue", async () => {
    deps.stripe.createSession = async () => {
      throw new Error("Invalid email address: camille@example.test");
    };
    await post(v.token);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0])).not.toContain("camille@example.test");
  });

  it("si la date est libérée pendant la création, la session est fermée et rien n'est retenu", async () => {
    const create = deps.stripe.createSession;
    deps.stripe.createSession = async (a) => {
      const session = await create(a);
      await expireHold(deps, v); // la tâche automatique passe entre-temps
      return session;
    };
    const r = await post(v.token);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/acompte/${v.token}`);
    const b = await current();
    expect(b.status).toBe("expired");
    expect(b.stripe_session).toBeNull();
    expect(b.stripe_session_expires).toBeNull();
    expect(deps.stripe.sessions.get("cs_1")?.status).toBe("expired");
  });

  it.each(["pending_review", "confirmed", "expired", "cancelled", "refused"] as const)(
    "en état %s, ne crée aucune session et renvoie vers la page qui explique",
    async (status) => {
      const b = await withStatus(status);
      const r = await post(b.token);
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe(`/acompte/${b.token}`);
      expect(deps.stripe.sessions.size).toBe(0);
    },
  );

  it("après l'échéance, ne crée aucune session", async () => {
    deps.setNow("2026-11-10T10:00:00.000Z");
    const r = await post(v.token);
    expect(r.headers.get("location")).toBe(`/acompte/${v.token}`);
    expect(deps.stripe.sessions.size).toBe(0);
    expect((await current()).hold_until).toBe(DEADLINE);
  });

  it("un jeton inconnu donne la page 404", async () => {
    expect((await post("jeton-inconnu")).status).toBe(404);
  });

  it.each(["https://evil.example", "null", "http://brotobooth.fr", "https://brotobooth.fr.evil.example"])(
    "refuse un envoi dont l'origine est %s",
    async (origin) => {
      const r = await post(v.token, { Origin: origin });
      expect(r.status).toBe(403);
      expect(deps.stripe.sessions.size).toBe(0);
      expect((await current()).stripe_session).toBeNull();
    },
  );

  it("accepte l'origine du site", async () => {
    expect((await post(v.token, { Origin: "https://brotobooth.fr" })).status).toBe(303);
  });
});

describe("GET /acompte/<jeton>?paid=1 : retour de Stripe", () => {
  it("confirme même si le webhook n'est pas encore arrivé", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    const html = await (await open(`${v.token}?paid=1`)).text();
    expect((await current()).status).toBe("confirmed");
    expect(html).toContain("date est confirmée");
    expect(html).toContain("450,00 €");
  });

  it("recharger la page ne change rien", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    await open(`${v.token}?paid=1`);
    await open(`${v.token}?paid=1`);
    expect((await events()).filter((e) => e === "paid")).toHaveLength(1);
    expect(await lateAlerts()).toEqual([]);
  });

  it("sans paiement reçu, dit que le paiement est en cours de vérification et ne propose pas de payer à nouveau", async () => {
    await start();
    const html = await (await open(`${v.token}?paid=1`)).text();
    expect((await current()).status).toBe("awaiting_deposit");
    expect(html).toContain("Nous vérifions votre paiement");
    expect(html).not.toContain('method="post"');
  });

  it("si Stripe ne répond pas, la page s'affiche quand même", async () => {
    await start();
    deps.stripe.failNext("retrieveSession");
    const r = await open(`${v.token}?paid=1`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Nous vérifions votre paiement");
  });

  it("ne consulte pas Stripe sans le paramètre", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    await open(v.token);
    expect((await current()).status).toBe("awaiting_deposit");
  });
});

describe("POST /api/stripe/webhook", () => {
  it("confirme, et le rejouer ne change rien", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    expect((await hook(s)).status).toBe(200);
    expect((await hook(s)).status).toBe(200);
    expect((await current()).status).toBe("confirmed");
    expect((await events()).filter((e) => e === "paid")).toHaveLength(1);
    expect(await lateAlerts()).toEqual([]);
  });

  it("note le paiement au nom de Stripe et planifie la confirmation du client", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    await hook(s);
    expect((await getHistory(env.DB, v.id)).at(-1)).toMatchObject({ actor: "stripe", event: "paid" });
    const templates = (await listDueNotifications(env.DB, T0, 50)).map((n) => n.template);
    expect(templates).toContain("client_confirmed");
    expect(templates).toContain("owner_deposit_paid");
  });

  it("confirme un paiement dont le webhook arrive après l'échéance, tant que la tâche automatique n'est pas passée", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    deps.setNow("2026-11-10T10:10:00.000Z");
    await hook(s);
    expect((await current()).status).toBe("confirmed");
  });

  it("le webhook et le retour du client arrivés ensemble ne confirment qu'une fois, sans alerte", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    await Promise.all([hook(s), open(`${v.token}?paid=1`)]);
    expect((await current()).status).toBe("confirmed");
    expect((await events()).filter((e) => e === "paid")).toHaveLength(1);
    expect(await lateAlerts()).toEqual([]);
  });

  it("refuse un webhook mal signé", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    const r = await hook(s, { signature: "invalid" });
    expect(r.status).toBe(400);
    expect((await current()).status).toBe("awaiting_deposit");
    expect(await events()).not.toContain("paid");
  });

  it("refuse un webhook sans signature : la vérification reçoit une chaîne vide", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    const verify = deps.stripe.verifyWebhook;
    deps.stripe.verifyWebhook = async (body, signature) => {
      if (signature === "") throw new Error("pas de signature");
      return verify(body, signature);
    };
    const r = await handle(
      new Request("https://brotobooth.fr/api/stripe/webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed", sessionId: s }),
      }),
      deps,
      ctx,
    );
    expect(r.status).toBe(400);
    expect((await current()).status).toBe("awaiting_deposit");
  });

  it("répond 400 quand le corps n'est pas un événement lisible", async () => {
    expect((await hook("", { body: "pas du json" })).status).toBe(400);
  });

  it("refuse un corps démesuré sans le lire", async () => {
    const r = await handle(
      new Request("https://brotobooth.fr/api/stripe/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": "valid", "Content-Length": String(2 * 1024 * 1024) },
        body: "{}",
      }),
      deps,
      ctx,
    );
    expect(r.status).toBe(413);
  });

  it("un paiement sur une réservation expirée n'écrase rien et alerte le propriétaire", async () => {
    const s = await start();
    await expireHold(deps, await current());
    deps.stripe.completeSession(s);
    expect((await hook(s)).status).toBe(200);
    expect((await current()).status).toBe("expired");
    expect((await listDueNotifications(env.DB, T0, 20)).map((n) => n.template)).toContain("owner_late_payment");
  });

  it("l'alerte part sur Telegram et par e-mail, une seule fois par session, même rejouée", async () => {
    const s = await start();
    await expireHold(deps, await current());
    deps.stripe.completeSession(s);
    await hook(s);
    await hook(s);
    const alerts = await lateAlerts();
    expect(alerts.map((n) => [n.channel, n.dedupe_key]).sort()).toEqual([
      ["email", `late:${s}:email`],
      ["telegram", `late:${s}:telegram`],
    ]);
    expect(alerts.every((n) => n.booking_id === v.id && n.recipient === "owner" && n.due_at === T0)).toBe(true);
  });

  it("un paiement sur une réservation annulée alerte aussi, sans la rouvrir", async () => {
    const s = await start();
    await cancelBooking(deps, v.id, "owner");
    deps.stripe.completeSession(s);
    await hook(s);
    expect((await current()).status).toBe("cancelled");
    expect(await lateAlerts()).toHaveLength(2);
  });

  it("un second paiement sur une réservation déjà confirmée par une autre session alerte", async () => {
    const first = await start();
    deps.stripe.completeSession(first);
    await hook(first);
    const second = (
      await deps.stripe.createSession({
        bookingId: v.id,
        token: v.token,
        email: null,
        amountCents: 45_000,
        label: "Acompte",
        expiresAt: Date.parse(T0) / 1000 + 1800,
      })
    ).id;
    deps.stripe.completeSession(second);
    await hook(second);
    expect((await current()).status).toBe("confirmed");
    expect((await lateAlerts()).map((n) => n.dedupe_key).sort()).toEqual([
      `late:${second}:email`,
      `late:${second}:telegram`,
    ]);
  });

  it("une réservation confirmée puis annulée ne déclenche pas d'alerte quand le même webhook est rejoué", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    await hook(s);
    await cancelBooking(deps, v.id, "owner");
    await hook(s);
    expect((await current()).status).toBe("cancelled");
    expect(await lateAlerts()).toEqual([]);
  });

  it("ignore les événements qui ne sont pas un paiement abouti", async () => {
    const s = await start();
    expect((await hook(s, { type: "checkout.session.expired" })).status).toBe(200);
    deps.stripe.completeSession(s);
    expect((await hook(s, { type: "charge.refunded" })).status).toBe(200);
    expect((await current()).status).toBe("awaiting_deposit");
    expect(await lateAlerts()).toEqual([]);
  });

  it("ignore une session non payée", async () => {
    const s = await start();
    expect((await hook(s)).status).toBe(200);
    expect((await current()).status).toBe("awaiting_deposit");
  });

  it("ignore une session sans réservation connue", async () => {
    const stray = (
      await deps.stripe.createSession({
        bookingId: "inconnue",
        token: "x",
        email: null,
        amountCents: 100,
        label: "Acompte",
        expiresAt: Date.parse(T0) / 1000 + 1800,
      })
    ).id;
    deps.stripe.completeSession(stray);
    expect((await hook(stray)).status).toBe(200);
    expect((await hook("cs_absente")).status).toBe(200);
    expect(await lateAlerts()).toEqual([]);
  });

  it("une panne de la base fait répondre 500, pour que Stripe réessaie", async () => {
    const s = await start();
    deps.stripe.completeSession(s);
    const unavailable = { prepare: () => { throw new Error("D1 indisponible"); } };
    deps.env = { ...deps.env, DB: unavailable as unknown as D1Database };
    expect((await hook(s)).status).toBe(500);
  });

  it("répond 405 à un autre verbe", async () => {
    const r = await handle(new Request("https://brotobooth.fr/api/stripe/webhook"), deps, ctx);
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe("POST");
  });
});

describe("public/styles/tokens.css : la charte des pages", () => {
  it("est sombre seulement : aucune palette claire pour un téléphone réglé en clair", () => {
    expect(tokens).not.toContain("prefers-color-scheme");
    expect(tokens).toMatch(/--bg-a: #0b0b0f;/);
    expect(tokens).toMatch(/--text: #ffffff;/);
  });

  it("ne déclare aucune police : elles viennent du site", () => {
    expect(tokens).not.toContain("@font-face");
  });
});
