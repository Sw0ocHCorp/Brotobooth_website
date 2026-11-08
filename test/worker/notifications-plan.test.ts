import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeps } from "../../worker/deps";
import { ALL_TEMPLATES, type PlanEvent, isRelevant, plan } from "../../worker/notifications";
import type { Booking, NotificationSpec } from "../../worker/repository";
import { T0, fakeDeps, newBooking } from "../support";

const b: Booking = { ...newBooking(), created_at: T0, updated_at: T0 };
const noEmail: Booking = { ...b, client_email: null };

const keys = (s: NotificationSpec[]) => s.map((n) => `${n.template}|${n.channel}|${n.due_at}`).sort();
const templates = (s: NotificationSpec[]) => s.map((n) => n.template).sort();

const EVENTS = Object.keys({
  requested: 0,
  validated: 0,
  refused: 0,
  paid: 0,
  manual_confirmed: 0,
  released: 0,
  cancelled: 0,
} satisfies Record<PlanEvent, 0>) as PlanEvent[];

describe("liste des modèles", () => {
  it("nomme les dix-sept modèles de la spec", () => {
    expect([...ALL_TEMPLATES].sort()).toEqual([
      "client_cancelled", "client_confirmed", "client_d7", "client_deposit_link", "client_deposit_reminder",
      "client_received", "client_refused", "client_released",
      "owner_d1", "owner_d7", "owner_deposit_paid", "owner_digest", "owner_email_failed", "owner_late_payment",
      "owner_new_request", "owner_released", "owner_review_reminder",
    ]);
  });
});

describe("plan", () => {
  it("nouvelle demande : alertes immédiates, deux rappels au propriétaire, accusé au client", () => {
    expect(keys(plan("requested", b, new Date(T0)))).toEqual([
      `client_received|email|${T0}`, `owner_new_request|email|${T0}`, `owner_new_request|telegram|${T0}`,
      "owner_review_reminder|telegram|2026-11-08T10:00:00.000Z", "owner_review_reminder|telegram|2026-11-09T10:00:00.000Z",
    ].sort());
  });

  it("validation : lien de paiement tout de suite, rappel 24 h avant l'échéance", () => {
    const v = { ...b, status: "awaiting_deposit" as const, hold_until: "2026-11-10T10:00:00.000Z" };
    expect(keys(plan("validated", v, new Date(T0)))).toEqual(
      [`client_deposit_link|email|${T0}`, "client_deposit_reminder|email|2026-11-09T10:00:00.000Z"].sort(),
    );
  });

  it("validation : pas de rappel dont l'heure est déjà passée", () => {
    const v = { ...b, status: "awaiting_deposit" as const, hold_until: "2026-11-08T09:00:00.000Z" };
    expect(templates(plan("validated", v, new Date(T0)))).toEqual(["client_deposit_link"]);
  });

  it("paiement : alerte, confirmation, puis J-7 et J-1 à 9 h de Paris", () => {
    const p = plan("paid", { ...b, event_date: "2026-12-19", status: "confirmed" }, new Date(T0));
    expect(keys(p)).toEqual(expect.arrayContaining([
      "owner_d7|telegram|2026-12-12T08:00:00.000Z", "owner_d7|email|2026-12-12T08:00:00.000Z",
      "owner_d1|telegram|2026-12-18T08:00:00.000Z", "owner_d1|email|2026-12-18T08:00:00.000Z",
      "client_d7|email|2026-12-12T08:00:00.000Z", `client_confirmed|email|${T0}`,
      `owner_deposit_paid|telegram|${T0}`, `owner_deposit_paid|email|${T0}`,
    ]));
    expect(p).toHaveLength(8);
  });

  it("les rappels suivent l'heure d'été : 9 h à Paris, 7 h UTC", () => {
    const p = plan("paid", { ...b, event_date: "2027-07-10", status: "confirmed" }, new Date(T0));
    expect(keys(p)).toEqual(expect.arrayContaining([
      "owner_d7|telegram|2027-07-03T07:00:00.000Z", "owner_d1|email|2027-07-09T07:00:00.000Z",
      "client_d7|email|2027-07-03T07:00:00.000Z",
    ]));
  });

  it("ne crée pas un rappel dont l'heure est déjà passée", () => {
    const p = plan("paid", { ...b, event_date: "2026-11-10", status: "confirmed" }, new Date(T0));
    expect(p.map((n) => n.template)).not.toContain("owner_d7");
    expect(p.map((n) => n.template)).not.toContain("client_d7");
    expect(p.map((n) => n.template)).toContain("owner_d1");
  });

  it("une confirmation à la main prévient comme un paiement, sans les messages de paiement", () => {
    const p = plan("manual_confirmed", { ...b, event_date: "2026-12-19", status: "confirmed" }, new Date(T0));
    expect(keys(p)).toEqual([
      "owner_d7|telegram|2026-12-12T08:00:00.000Z", "owner_d7|email|2026-12-12T08:00:00.000Z",
      "owner_d1|telegram|2026-12-18T08:00:00.000Z", "owner_d1|email|2026-12-18T08:00:00.000Z",
      "client_d7|email|2026-12-12T08:00:00.000Z",
    ].sort());
  });

  it("sans e-mail client, seul le propriétaire est prévenu", () => {
    const p = plan("manual_confirmed", { ...noEmail, status: "confirmed" }, new Date(T0));
    expect(p.length).toBeGreaterThan(0);
    expect(p.every((n) => n.recipient === "owner")).toBe(true);
    const paid = plan("paid", { ...noEmail, status: "confirmed" }, new Date(T0));
    expect(templates(paid)).toEqual(["owner_d1", "owner_d1", "owner_d7", "owner_d7", "owner_deposit_paid", "owner_deposit_paid"]);
  });

  it("une nouvelle demande sans e-mail client ne prévient que le propriétaire", () => {
    const p = plan("requested", noEmail, new Date(T0));
    expect(templates(p)).toEqual(["owner_new_request", "owner_new_request", "owner_review_reminder", "owner_review_reminder"]);
  });

  it.each(["validated", "refused", "cancelled"] as const)("%s sans e-mail client ne planifie rien", (event) => {
    expect(plan(event, { ...noEmail, status: "awaiting_deposit", hold_until: "2026-11-10T10:00:00.000Z" }, new Date(T0))).toEqual([]);
  });

  it("le refus ne prévient que le client", () => {
    expect(keys(plan("refused", { ...b, status: "refused" }, new Date(T0)))).toEqual([`client_refused|email|${T0}`]);
  });

  it("l'annulation ne prévient que le client", () => {
    expect(keys(plan("cancelled", { ...b, status: "confirmed" }, new Date(T0)))).toEqual([`client_cancelled|email|${T0}`]);
  });

  it("la libération prévient les deux parties", () => {
    expect(plan("released", b, new Date(T0)).map((n) => n.template).sort()).toEqual(["client_released", "owner_released", "owner_released"]);
  });

  it.each(EVENTS)("%s : une date bloquée ne planifie rien", (event) => {
    const blocked = { ...b, status: "blocked" as const };
    expect(plan(event, blocked, new Date(T0))).toEqual([]);
  });

  it.each(EVENTS)("%s : modèles connus, clés uniques, destinataire selon le modèle", (event) => {
    const p = plan(event, { ...b, status: "awaiting_deposit", hold_until: "2026-11-10T10:00:00.000Z" }, new Date(T0));
    expect(p.length).toBeGreaterThan(0);
    expect(new Set(p.map((n) => n.dedupe_key)).size).toBe(p.length);
    for (const n of p) {
      expect(ALL_TEMPLATES).toContain(n.template);
      expect(n.booking_id).toBe(b.id);
      expect(n.recipient).toBe(n.template.startsWith("client_") ? "client" : "owner");
      expect(n.dedupe_key).toMatch(new RegExp(`^b${b.id}:${n.template}(:[a-z0-9]+)?:${n.channel}$`));
    }
  });

  it("les deux rappels de validation se distinguent par leur repère", () => {
    const k = plan("requested", b, new Date(T0)).map((n) => n.dedupe_key);
    expect(k).toContain(`b${b.id}:owner_review_reminder:24h:telegram`);
    expect(k).toContain(`b${b.id}:owner_review_reminder:48h:telegram`);
    expect(k).toContain(`b${b.id}:owner_new_request:email`);
  });

  it("est pure : deux appels identiques donnent le même plan", () => {
    expect(plan("paid", { ...b, status: "confirmed" }, new Date(T0))).toEqual(plan("paid", { ...b, status: "confirmed" }, new Date(T0)));
  });
});

describe("isRelevant", () => {
  it.each([
    ["owner_review_reminder", "pending_review", true], ["owner_review_reminder", "awaiting_deposit", false],
    ["client_deposit_reminder", "awaiting_deposit", true], ["client_deposit_reminder", "confirmed", false],
    ["owner_d7", "confirmed", true], ["owner_d1", "cancelled", false], ["client_d7", "cancelled", false],
  ] as const)("%s en état %s : pertinent = %s", (t, status, e) => expect(isRelevant(t, { ...b, status })).toBe(e));

  it.each(["owner_d1", "owner_d7", "client_d7"])("%s n'est pertinent qu'en état confirmed", (t) => {
    for (const status of ["pending_review", "awaiting_deposit", "blocked", "refused", "expired", "cancelled"] as const) {
      expect(isRelevant(t, { ...b, status })).toBe(false);
    }
  });

  it.each(["client_received", "client_cancelled", "owner_released", "owner_late_payment", "owner_email_failed"])(
    "%s reste pertinent quel que soit l'état",
    (t) => {
      for (const status of ["pending_review", "awaiting_deposit", "confirmed", "refused", "expired", "cancelled"] as const) {
        expect(isRelevant(t, { ...b, status })).toBe(true);
      }
    },
  );

  it.each(ALL_TEMPLATES)("%s est pertinent sans réservation (point du lundi)", (t) => {
    expect(isRelevant(t, null)).toBe(true);
  });

  it("un nom hérité de Object.prototype n'est pas un modèle restreint", () => {
    expect(isRelevant("constructor", { ...b, status: "cancelled" })).toBe(true);
  });
});

describe("makeDeps", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("se crée sans lever et garde l'environnement tel quel", () => {
    expect(() => makeDeps(env)).not.toThrow();
    expect(makeDeps(env).env).toBe(env);
  });

  it("branche les vraies passerelles d'e-mail et de Telegram, et celles de Stripe restent à venir", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return Response.json({ ok: true });
    });
    const d = makeDeps(env);
    await d.email.send({ to: "a@example.test", subject: "s", text: "t", html: "h" });
    await d.telegram.send("1", "x");
    await d.telegram.edit("1", 2, "x");
    await d.telegram.answer("cb");
    expect(fetched.map((url) => new URL(url).pathname.split("/").at(-1))).toEqual([
      "emails",
      "sendMessage",
      "editMessageText",
      "answerCallbackQuery",
    ]);
    await expect(d.stripe.createSession({
      bookingId: "i", token: "t", email: null, amountCents: 100, label: "l", expiresAt: 1,
    })).rejects.toThrow();
    await expect(d.stripe.retrieveSession("cs_1")).rejects.toThrow();
    await expect(d.stripe.expireSession("cs_1")).rejects.toThrow();
    await expect(d.stripe.verifyWebhook("{}", "sig")).rejects.toThrow();
  });

  it("n'accepte aucun propriétaire en attendant la tâche suivante, et interroge le vrai Turnstile", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return Response.json({ success: true });
    });
    const d = makeDeps(env);
    expect(d.isOwner({} as ExecutionContext)).toBe(false);
    expect(await d.verifyTurnstile("t", null)).toBe("pass");
    expect(fetched).toEqual(["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  });

  it("donne l'horloge réelle", () => {
    const before = Date.now();
    const t = makeDeps(env).now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe("fakeDeps", () => {
  const sessionArgs = { bookingId: "b1", token: "tok", email: null, amountCents: 45_000, label: "Acompte", expiresAt: 1_800_000_000 };

  it("part de T0, avance avec setNow, rend des copies", () => {
    const d = fakeDeps();
    expect(d.now().toISOString()).toBe(T0);
    d.setNow("2026-11-10T09:50:00.000Z");
    expect(d.now().toISOString()).toBe("2026-11-10T09:50:00.000Z");
    d.now().setFullYear(1999);
    expect(d.now().toISOString()).toBe("2026-11-10T09:50:00.000Z");
  });

  it("utilise l'environnement réel, propriétaire et Turnstile passants par défaut", async () => {
    const d = fakeDeps();
    expect(d.env.DB).toBe(env.DB);
    expect(d.isOwner({} as ExecutionContext)).toBe(true);
    expect(await d.verifyTurnstile("t", "203.0.113.5")).toBe("pass");
  });

  it("accepte des remplacements", async () => {
    const d = fakeDeps({ isOwner: () => false, verifyTurnstile: async () => "fail" });
    expect(d.isOwner({} as ExecutionContext)).toBe(false);
    expect(await d.verifyTurnstile("t", null)).toBe("fail");
    expect(d.now().toISOString()).toBe(T0);
  });

  it("enregistre les e-mails et les messages Telegram", async () => {
    const d = fakeDeps();
    const mail = { to: "a@example.test", subject: "s", text: "t", html: "<p>t</p>" };
    const buttons = [[{ text: "Valider", data: "v:1" }]];
    await d.email.send(mail);
    await d.telegram.send("10", "<b>Nouvelle demande</b>", buttons);
    await d.telegram.send("11", "sans bouton");
    await d.telegram.edit("10", 7, "<b>Validée</b>", buttons);
    await d.telegram.answer("cb1", "C'est fait");
    await d.telegram.answer("cb2");
    expect(d.emails).toEqual([mail]);
    expect(d.telegrams).toEqual([
      { chatId: "10", html: "<b>Nouvelle demande</b>", buttons },
      { chatId: "11", html: "sans bouton", buttons: undefined },
    ]);
    expect(d.edits).toEqual([{ chatId: "10", messageId: 7, html: "<b>Validée</b>", buttons }]);
    expect(d.answers).toEqual(["cb1", "cb2"]);
    expect(d.answerTexts).toEqual(["C'est fait", undefined]);
  });

  it("Stripe : crée des sessions cs_1, cs_2, ouvertes et impayées", async () => {
    const d = fakeDeps();
    const a = await d.stripe.createSession(sessionArgs);
    const c = await d.stripe.createSession({ ...sessionArgs, bookingId: "b2" });
    expect([a.id, c.id]).toEqual(["cs_1", "cs_2"]);
    expect(a).toMatchObject({ status: "open", paymentStatus: "unpaid", expiresAt: 1_800_000_000, bookingId: "b1" });
    expect(a.url).toMatch(/^https:\/\/.+cs_1/);
    expect([...d.stripe.sessions.keys()]).toEqual(["cs_1", "cs_2"]);
    expect(await d.stripe.retrieveSession("cs_1")).toEqual(a);
  });

  it("Stripe : completeSession marque la session payée, expireSession la ferme", async () => {
    const d = fakeDeps();
    await d.stripe.createSession(sessionArgs);
    await d.stripe.createSession(sessionArgs);
    d.stripe.completeSession("cs_1");
    await d.stripe.expireSession("cs_2");
    expect(await d.stripe.retrieveSession("cs_1")).toMatchObject({ status: "complete", paymentStatus: "paid", url: null });
    expect(d.stripe.sessions.get("cs_2")).toMatchObject({ status: "expired", paymentStatus: "unpaid", url: null });
    d.stripe.completeSession("cs_2");
    await d.stripe.expireSession("cs_1");
    expect(d.stripe.sessions.get("cs_1")!.status).toBe("complete");
  });

  it("Stripe : une session inconnue lève", async () => {
    const d = fakeDeps();
    await expect(d.stripe.retrieveSession("cs_9")).rejects.toThrow();
    await expect(d.stripe.expireSession("cs_9")).rejects.toThrow();
    expect(() => d.stripe.completeSession("cs_9")).toThrow();
  });

  it("Stripe : failNext fait échouer le prochain appel de cette méthode, une seule fois", async () => {
    const d = fakeDeps();
    d.stripe.failNext("createSession");
    await expect(d.stripe.createSession(sessionArgs)).rejects.toThrow();
    expect(d.stripe.sessions.size).toBe(0);
    expect((await d.stripe.createSession(sessionArgs)).id).toBe("cs_1");
    d.stripe.failNext("retrieveSession");
    await expect(d.stripe.expireSession("cs_1")).resolves.toBeUndefined();
    await expect(d.stripe.retrieveSession("cs_1")).rejects.toThrow();
    await expect(d.stripe.retrieveSession("cs_1")).resolves.toMatchObject({ id: "cs_1" });
  });

  it("Stripe : verifyWebhook relit { type, sessionId } et rend la session", async () => {
    const d = fakeDeps();
    await d.stripe.createSession(sessionArgs);
    d.stripe.completeSession("cs_1");
    const body = JSON.stringify({ type: "checkout.session.completed", sessionId: "cs_1" });
    const event = await d.stripe.verifyWebhook(body, "valid");
    expect(event.type).toBe("checkout.session.completed");
    expect(event.session).toMatchObject({ id: "cs_1", paymentStatus: "paid" });
    expect(await d.stripe.verifyWebhook(JSON.stringify({ type: "ping", sessionId: "cs_9" }), "valid")).toEqual({ type: "ping", session: null });
    expect(await d.stripe.verifyWebhook(JSON.stringify({ type: "ping" }), "valid")).toEqual({ type: "ping", session: null });
  });

  it("Stripe : une signature « invalid » ou un corps illisible lèvent", async () => {
    const d = fakeDeps();
    await expect(d.stripe.verifyWebhook("{}", "invalid")).rejects.toThrow();
    await expect(d.stripe.verifyWebhook("pas du JSON", "valid")).rejects.toThrow();
  });
});
