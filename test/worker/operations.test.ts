import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "../../worker/notifications";
import { currentTier, offer, priceOf } from "../../worker/offer";
import {
  adjustPrice,
  blockDate,
  cancelBooking,
  confirmDeposit,
  createManual,
  createRequest,
  expireHold,
  markBalancePaid,
  refuseBooking,
  resendPaymentLink,
  validateBooking,
  type CreateRequestResult,
  type OpResult,
} from "../../worker/operations";
import {
  countTakenByTier,
  getBooking,
  getHistory,
  insertBooking,
  listDueNotifications,
  listRange,
  listUnavailableDates,
  patchBooking,
  type Booking,
  type NewBooking,
} from "../../worker/repository";
import {
  FIRST_PLAN,
  SECOND_PLAN,
  T0,
  depositFor,
  fakeDeps,
  insert,
  newBooking,
  racingDeps,
  requestBody,
  resetDb,
  strictStripe,
  takePlace,
  testTier,
  useTiers,
  type FakeDeps,
} from "../support";

const STALE = { ok: false, reason: "stale" };

let deps: FakeDeps;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
});

/** La réservation d'un succès ; un échec fait échouer le test en nommant sa raison. */
const ok = (r: OpResult): Booking => {
  if (!r.ok) throw new Error(`opération refusée : ${r.reason}`);
  return r.booking;
};

/** La demande enregistrée ; un autre résultat fait échouer le test en le nommant. */
const created = (r: CreateRequestResult): Booking => {
  if (r.kind !== "created") throw new Error(`demande non enregistrée : ${r.kind}`);
  return r.booking;
};

/** Une demande du site telle que `createRequest` la laisse à `T0` : à valider, avec ses alertes en file. */
async function request(over: Partial<NewBooking> = {}): Promise<Booking> {
  const nb = newBooking(over);
  const specs = plan("requested", { ...nb, created_at: T0, updated_at: T0 }, new Date(T0));
  const inserted = await insertBooking(env.DB, nb, specs, T0);
  if (!inserted.ok) throw new Error(`request : ${inserted.reason}`);
  return inserted.booking;
}

const validated = async (over: Partial<NewBooking> = {}) =>
  ok(await validateBooking(deps, (await request(over)).id, "owner"));

const confirmed = async (over: Partial<NewBooking> = {}) =>
  ok(await confirmDeposit(deps, (await validated(over)).id, "stripe"));

/** Une réservation validée dont le client a ouvert une session Stripe (`cs_1`). */
async function validatedWithSession(): Promise<Booking> {
  const v = await validated();
  const session = await deps.stripe.createSession({
    bookingId: v.id,
    token: v.token,
    email: v.client_email,
    amountCents: v.deposit_cents!,
    label: "Acompte",
    expiresAt: Date.parse(T0) / 1000 + 1800,
  });
  const expires = new Date(session.expiresAt * 1000).toISOString();
  return (await patchBooking(env.DB, v.id, { stripe_session: session.id, stripe_session_expires: expires }, "system", "session_opened", T0))!;
}

type Queued = { template: string; channel: string; due_at: string; cancelled_at: string | null; dedupe_key: string };

const queued = async (id: string): Promise<Queued[]> =>
  (
    await env.DB.prepare(
      "SELECT template, channel, due_at, cancelled_at, dedupe_key FROM notifications WHERE booking_id = ? ORDER BY id",
    )
      .bind(id)
      .all<Queued>()
  ).results;

/** Ce qui partira encore : les notifications non annulées, `modèle|canal|échéance`. */
const stillDue = async (id: string): Promise<string[]> =>
  (await queued(id))
    .filter((n) => n.cancelled_at === null)
    .map((n) => `${n.template}|${n.channel}|${n.due_at}`)
    .sort();

const cancelledAt = async (id: string, template: string): Promise<(string | null)[]> =>
  (await queued(id)).filter((n) => n.template === template).map((n) => n.cancelled_at);

const decemberDates = () => listUnavailableDates(env.DB, "2026-12-01", "2026-12-31");

describe("validateBooking", () => {
  it("valider fixe l'échéance à 72 h après la validation et prépare le lien de paiement", async () => {
    const p = await request();
    deps.setNow("2026-11-08T12:00:00.000Z");
    const r = await validateBooking(deps, p.id, "owner");
    expect(r.ok && r.booking.status).toBe("awaiting_deposit");
    expect(r.ok && r.booking.hold_until).toBe("2026-11-11T12:00:00.000Z");
    const due = await listDueNotifications(env.DB, "2026-11-08T12:00:00.000Z", 20);
    expect(due.map((n) => n.template)).toContain("client_deposit_link");
    expect(await stillDue(p.id)).toEqual([
      "client_deposit_link|email|2026-11-08T12:00:00.000Z",
      "client_deposit_reminder|email|2026-11-10T12:00:00.000Z",
    ]);
  });

  it("valider annule les rappels de validation", async () => {
    const p = await request();
    expect(await cancelledAt(p.id, "owner_review_reminder")).toEqual([null, null]);
    await validateBooking(deps, p.id, "owner");
    expect(await cancelledAt(p.id, "owner_review_reminder")).toEqual([T0, T0]);
  });

  it("valider consigne l'auteur et l'événement", async () => {
    const p = await request();
    await validateBooking(deps, p.id, "owner");
    expect(await getHistory(env.DB, p.id)).toMatchObject([{ actor: "owner", event: "validated", at: T0 }]);
  });

  it("valider deux fois ne change rien la seconde fois", async () => {
    const p = await request();
    await validateBooking(deps, p.id, "owner");
    expect(await validateBooking(deps, p.id, "owner")).toEqual(STALE);
    expect(await getHistory(env.DB, p.id)).toHaveLength(1);
  });

  it("valider une réservation inconnue ne trouve rien", async () => {
    expect(await validateBooking(deps, "inconnue", "owner")).toEqual({ ok: false, reason: "not_found" });
  });

  it("valider garde la session Stripe déjà ouverte", async () => {
    const v = await validatedWithSession();
    expect((await getBooking(env.DB, v.id))!.stripe_session).toBe("cs_1");
  });
});

describe("refuseBooking", () => {
  it("refuser libère la date", async () => {
    const p = await request();
    expect(await decemberDates()).toEqual(["2026-12-19"]);
    const r = await refuseBooking(deps, p.id, "owner");
    expect(r.ok && r.booking.status).toBe("refused");
    expect(r.ok && r.booking.hold_until).toBeNull();
    expect(await decemberDates()).toEqual([]);
  });

  it("refuser prévient le client et n'envoie plus rien d'autre", async () => {
    const p = await request();
    await refuseBooking(deps, p.id, "owner");
    expect(await stillDue(p.id)).toEqual([`client_refused|email|${T0}`]);
  });

  it("refuser une réservation déjà validée ne change rien", async () => {
    const v = await validated();
    expect(await refuseBooking(deps, v.id, "owner")).toEqual(STALE);
    expect((await getBooking(env.DB, v.id))!.status).toBe("awaiting_deposit");
  });
});

describe("cancelBooking", () => {
  it("annuler une prestation confirmée annule ses rappels et prévient le client", async () => {
    const c = await confirmed();
    expect(await cancelledAt(c.id, "owner_d7")).toEqual([null, null]);
    const r = await cancelBooking(deps, c.id, "owner");
    expect(r.ok && r.booking.status).toBe("cancelled");
    expect(r.ok && r.booking.hold_until).toBeNull();
    expect(await cancelledAt(c.id, "owner_d7")).toEqual([T0, T0]);
    expect(await stillDue(c.id)).toEqual([`client_cancelled|email|${T0}`]);
    expect(await decemberDates()).toEqual([]);
  });

  it("annuler une demande en attente d'acompte libère la date, annule le rappel et prévient le client", async () => {
    const v = await validated();
    const r = await cancelBooking(deps, v.id, "owner");
    expect(r.ok && r.booking.status).toBe("cancelled");
    expect(await cancelledAt(v.id, "client_deposit_reminder")).toEqual([T0]);
    expect(await stillDue(v.id)).toEqual([`client_cancelled|email|${T0}`]);
    expect(await decemberDates()).toEqual([]);
  });

  it("annuler garde la session Stripe consignée", async () => {
    const v = await validatedWithSession();
    expect(ok(await cancelBooking(deps, v.id, "owner")).stripe_session).toBe("cs_1");
  });

  it("annuler une demande à valider est refusé", async () => {
    const p = await request();
    expect(await cancelBooking(deps, p.id, "owner")).toEqual(STALE);
    expect((await getBooking(env.DB, p.id))!.status).toBe("pending_review");
  });

  it("annuler deux fois ne prévient le client qu'une fois", async () => {
    const c = await confirmed();
    await cancelBooking(deps, c.id, "owner");
    expect(await cancelBooking(deps, c.id, "owner")).toEqual(STALE);
    expect((await queued(c.id)).filter((n) => n.template === "client_cancelled")).toHaveLength(1);
  });
});

describe("confirmDeposit", () => {
  it("confirmer l'acompte enregistre le paiement et supprime l'échéance", async () => {
    const v = await validated();
    const r = await confirmDeposit(deps, v.id, "stripe");
    expect(r.ok && r.booking.status).toBe("confirmed");
    expect(r.ok && r.booking.hold_until).toBeNull();
    expect(r.ok && r.booking.deposit_paid_at).toBe(T0);
    expect(await getHistory(env.DB, v.id)).toMatchObject([
      { actor: "owner", event: "validated" },
      { actor: "stripe", event: "paid" },
    ]);
  });

  it("confirmer l'acompte annule le rappel de paiement et planifie confirmation et rappels", async () => {
    const v = await validated();
    await confirmDeposit(deps, v.id, "stripe");
    expect(await cancelledAt(v.id, "client_deposit_reminder")).toEqual([T0]);
    expect(await stillDue(v.id)).toEqual(
      [
        `client_confirmed|email|${T0}`,
        `owner_deposit_paid|email|${T0}`,
        `owner_deposit_paid|telegram|${T0}`,
        "client_d7|email|2026-12-12T08:00:00.000Z",
        "owner_d7|email|2026-12-12T08:00:00.000Z",
        "owner_d7|telegram|2026-12-12T08:00:00.000Z",
        "owner_d1|email|2026-12-18T08:00:00.000Z",
        "owner_d1|telegram|2026-12-18T08:00:00.000Z",
      ].sort(),
    );
  });

  it("un paiement rejoué ne change rien", async () => {
    const c = await confirmed();
    expect(await confirmDeposit(deps, c.id, "stripe")).toEqual(STALE);
    expect(await getBooking(env.DB, c.id)).toEqual(c);
  });

  it("un paiement sur une demande jamais validée est refusé", async () => {
    const p = await request();
    expect(await confirmDeposit(deps, p.id, "stripe")).toEqual(STALE);
    expect((await getBooking(env.DB, p.id))!.deposit_paid_at).toBeNull();
  });

  it("un paiement sur une réservation expirée ne la ressuscite pas", async () => {
    const v = await validated();
    ok(await expireHold(deps, v));
    expect(await confirmDeposit(deps, v.id, "stripe")).toEqual(STALE);
    expect((await getBooking(env.DB, v.id))!.status).toBe("expired");
  });
});

describe("expireHold", () => {
  it("expirer une demande sans réponse libère la date, s'excuse auprès du client et prévient le propriétaire", async () => {
    const p = await request();
    deps.setNow("2026-11-10T10:00:00.000Z");
    const r = await expireHold(deps, p);
    expect(r.ok && r.booking.status).toBe("expired");
    expect(r.ok && r.booking.hold_until).toBeNull();
    expect(await decemberDates()).toEqual([]);
    expect(await cancelledAt(p.id, "owner_review_reminder")).toEqual(["2026-11-10T10:00:00.000Z", "2026-11-10T10:00:00.000Z"]);
    expect(await stillDue(p.id)).toEqual(
      [
        "client_unanswered|email|2026-11-10T10:00:00.000Z",
        "owner_released|email|2026-11-10T10:00:00.000Z",
        "owner_released|telegram|2026-11-10T10:00:00.000Z",
      ].sort(),
    );
    expect(await getHistory(env.DB, p.id)).toMatchObject([{ actor: "system", event: "released" }]);
  });

  it("expirer un acompte non payé libère la date et rappelle au client que le délai est passé", async () => {
    const v = await validated();
    deps.setNow("2026-11-10T10:00:00.000Z");
    const r = await expireHold(deps, v);
    expect(r.ok && r.booking.status).toBe("expired");
    expect(await cancelledAt(v.id, "client_deposit_reminder")).toEqual(["2026-11-10T10:00:00.000Z"]);
    expect((await stillDue(v.id)).filter((n) => n.startsWith("client_"))).toEqual(["client_released|email|2026-11-10T10:00:00.000Z"]);
  });

  it("expirer une demande en attente d'acompte garde la session Stripe sans la toucher", async () => {
    const v = await validatedWithSession();
    const r = await expireHold(deps, v);
    expect(r.ok && r.booking.status).toBe("expired");
    expect(r.ok && r.booking.stripe_session).toBe("cs_1");
    expect(deps.stripe.sessions.get("cs_1")!.status).toBe("open");
  });

  it("expirer d'après une lecture périmée ne touche pas une réservation payée entre-temps", async () => {
    const v = await validated();
    await confirmDeposit(deps, v.id, "stripe");
    expect(await expireHold(deps, v)).toEqual(STALE);
    expect((await getBooking(env.DB, v.id))!.status).toBe("confirmed");
  });

  it("expirer une prestation confirmée est refusé", async () => {
    const c = await confirmed();
    expect(await expireHold(deps, c)).toEqual(STALE);
  });
});

describe("adjustPrice", () => {
  beforeEach(() => strictStripe(deps));

  it("ajuster le prix recalcule l'acompte et ferme une session ouverte", async () => {
    const v = await validatedWithSession();
    const r = await adjustPrice(deps, v.id, { priceCents: 150_000 });
    expect(r.ok && r.booking.price_cents).toBe(150_000);
    expect(r.ok && r.booking.deposit_cents).toBe(depositFor(150_000));
    expect(r.ok && r.booking.stripe_session).toBeNull();
    expect(r.ok && r.booking.stripe_session_expires).toBeNull();
    expect(r.ok && r.booking.status).toBe("awaiting_deposit");
    expect(r.ok && r.booking.hold_until).toBe(v.hold_until);
    expect(deps.stripe.sessions.get("cs_1")!.status).toBe("expired");
    expect((await getHistory(env.DB, v.id)).at(-1)).toMatchObject({ actor: "owner", event: "price_adjusted" });
  });

  it("ajuster le prix d'une demande à valider ne demande rien à Stripe", async () => {
    const p = await request();
    const retrieve = vi.spyOn(deps.stripe, "retrieveSession");
    const r = await adjustPrice(deps, p.id, { priceCents: 100_000 });
    expect(r.ok && r.booking.price_cents).toBe(100_000);
    expect(r.ok && r.booking.deposit_cents).toBe(depositFor(100_000));
    expect(r.ok && r.booking.status).toBe("pending_review");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("garde un acompte saisi à la main", async () => {
    const v = await validated();
    const r = await adjustPrice(deps, v.id, { priceCents: 150_000, depositCents: 20_000 });
    expect(r.ok && r.booking.deposit_cents).toBe(20_000);
  });

  it("garde un acompte saisi à la main même nul", async () => {
    const v = await validated();
    const r = await adjustPrice(deps, v.id, { priceCents: 150_000, depositCents: 0 });
    expect(r.ok && r.booking.deposit_cents).toBe(0);
  });

  it("n'ajuste plus le prix après le paiement", async () => {
    const c = await confirmed();
    expect(await adjustPrice(deps, c.id, { priceCents: 10_000 })).toEqual(STALE);
    expect(await getBooking(env.DB, c.id)).toEqual(c);
  });

  it("n'ajuste pas le prix d'une réservation libérée", async () => {
    const p = await request();
    await refuseBooking(deps, p.id, "owner");
    expect(await adjustPrice(deps, p.id, { priceCents: 10_000 })).toEqual(STALE);
  });

  it("ajuster le prix d'une réservation inconnue ne trouve rien", async () => {
    expect(await adjustPrice(deps, "inconnue", { priceCents: 10_000 })).toEqual({ ok: false, reason: "not_found" });
  });

  it("une session déjà expirée est oubliée sans être expirée une seconde fois", async () => {
    const v = await validatedWithSession();
    await deps.stripe.expireSession("cs_1");
    const expire = vi.spyOn(deps.stripe, "expireSession");
    const r = await adjustPrice(deps, v.id, { priceCents: 150_000 });
    expect(r.ok && r.booking.stripe_session).toBeNull();
    expect(r.ok && r.booking.deposit_cents).toBe(depositFor(150_000));
    expect(expire).not.toHaveBeenCalled();
  });

  it("une session déjà payée bloque l'ajustement et ne change rien", async () => {
    const v = await validatedWithSession();
    deps.stripe.completeSession("cs_1");
    const expire = vi.spyOn(deps.stripe, "expireSession");
    expect(await adjustPrice(deps, v.id, { priceCents: 150_000 })).toEqual(STALE);
    expect(await getBooking(env.DB, v.id)).toEqual(v);
    expect(expire).not.toHaveBeenCalled();
  });

  it("un paiement qui arrive pendant l'ajustement bloque l'ajustement et ne change rien", async () => {
    const v = await validatedWithSession();
    deps.stripe.expireSession = async (id) => {
      deps.stripe.completeSession(id);
      throw new Error("Stripe : la session n'est plus ouverte");
    };
    expect(await adjustPrice(deps, v.id, { priceCents: 150_000 })).toEqual(STALE);
    expect(await getBooking(env.DB, v.id)).toEqual(v);
  });

  it("une panne de Stripe laisse la réservation intacte et remonte l'erreur", async () => {
    const v = await validatedWithSession();
    deps.stripe.failNext("expireSession");
    await expect(adjustPrice(deps, v.id, { priceCents: 150_000 })).rejects.toThrow("panne simulée");
    expect(await getBooking(env.DB, v.id)).toEqual(v);
    expect(deps.stripe.sessions.get("cs_1")!.status).toBe("open");
  });
});

describe("resendPaymentLink", () => {
  it("renvoyer le lien ajoute un message au client sans prolonger l'échéance", async () => {
    const v = await validated();
    deps.setNow("2026-11-08T08:00:00.000Z");
    const r = await resendPaymentLink(deps, v.id);
    expect(r.ok && r.booking.status).toBe("awaiting_deposit");
    expect(r.ok && r.booking.hold_until).toBe(v.hold_until);
    const links = (await queued(v.id)).filter((n) => n.template === "client_deposit_link");
    expect(links.map((n) => `${n.due_at}|${n.cancelled_at}`)).toEqual([
      `${T0}|null`,
      "2026-11-08T08:00:00.000Z|null",
    ]);
    expect(new Set(links.map((n) => n.dedupe_key)).size).toBe(2);
    expect(await getHistory(env.DB, v.id)).toMatchObject([{ event: "validated" }, { actor: "owner", event: "payment_link_resent" }]);
  });

  it("renvoyer le lien garde le rappel de paiement prévu", async () => {
    const v = await validated();
    deps.setNow("2026-11-08T08:00:00.000Z");
    await resendPaymentLink(deps, v.id);
    expect(await cancelledAt(v.id, "client_deposit_reminder")).toEqual([null]);
  });

  it("renvoyer le lien deux fois à des instants différents envoie deux messages", async () => {
    const v = await validated();
    deps.setNow("2026-11-08T08:00:00.000Z");
    await resendPaymentLink(deps, v.id);
    deps.setNow("2026-11-08T09:00:00.000Z");
    await resendPaymentLink(deps, v.id);
    expect((await queued(v.id)).filter((n) => n.template === "client_deposit_link")).toHaveLength(3);
  });

  it("renvoyer le lien à la même milliseconde ne crée pas de doublon", async () => {
    const v = await validated();
    deps.setNow("2026-11-08T08:00:00.000Z");
    await resendPaymentLink(deps, v.id);
    await resendPaymentLink(deps, v.id);
    expect((await queued(v.id)).filter((n) => n.template === "client_deposit_link")).toHaveLength(2);
  });

  it.each([
    ["à valider", () => request()],
    ["confirmée", () => confirmed()],
  ])("renvoyer le lien d'une réservation %s est refusé", async (_, make) => {
    const b = await make();
    const before = await queued(b.id);
    expect(await resendPaymentLink(deps, b.id)).toEqual(STALE);
    expect(await queued(b.id)).toEqual(before);
  });

  it("renvoyer le lien d'une réservation inconnue ne trouve rien", async () => {
    expect(await resendPaymentLink(deps, "inconnue")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("markBalancePaid", () => {
  it("marque le solde réglé sur une prestation confirmée", async () => {
    const c = await confirmed();
    deps.setNow("2026-12-19T22:00:00.000Z");
    const r = await markBalancePaid(deps, c.id);
    expect(r.ok && r.booking.balance_paid_at).toBe("2026-12-19T22:00:00.000Z");
    expect(r.ok && r.booking.status).toBe("confirmed");
    expect(await getHistory(env.DB, c.id)).toMatchObject([
      { event: "validated" },
      { event: "paid" },
      { actor: "owner", event: "balance_paid" },
    ]);
  });

  it("marquer le solde ne touche pas aux rappels", async () => {
    const c = await confirmed();
    const before = await stillDue(c.id);
    await markBalancePaid(deps, c.id);
    expect(await stillDue(c.id)).toEqual(before);
  });

  it.each([
    ["à valider", () => request()],
    ["en attente d'acompte", () => validated()],
  ])("marquer le solde d'une réservation %s est refusé", async (_, make) => {
    const b = await make();
    expect(await markBalancePaid(deps, b.id)).toEqual(STALE);
    expect((await getBooking(env.DB, b.id))!.balance_paid_at).toBeNull();
  });

  it("marquer le solde d'une réservation inconnue ne trouve rien", async () => {
    expect(await markBalancePaid(deps, "inconnue")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("createManual", () => {
  it("une réservation manuelle est confirmée sans délai minimum, et sans e-mail client", async () => {
    const r = await createManual(deps, { date: "2026-11-09", name: "Camille", priceCents: 50_000, depositCents: 0 });
    expect(r.ok && r.booking).toMatchObject({
      status: "confirmed",
      source: "manual",
      client_name: "Camille",
      client_email: null,
      price_cents: 50_000,
      deposit_cents: 0,
      deposit_paid_at: null,
      hold_until: null,
      plan: null,
    });
    const due = await listDueNotifications(env.DB, "2030-01-01T00:00:00Z", 20);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((n) => n.recipient === "owner")).toBe(true);
  });

  it("une réservation manuelle enregistre les coordonnées saisies et ne prévient le client que par son rappel à J-7", async () => {
    const r = await createManual(deps, {
      date: "2026-12-19",
      name: "Camille",
      phone: "06 01 02 03 04",
      email: "camille@example.test",
      eventType: "Mariage",
      venue: "Lyon",
      hours: "18h-02h",
      priceCents: 50_000,
      depositCents: 10_000,
      notes: "Paiement par virement",
    });
    const b = ok(r);
    expect(b).toMatchObject({
      client_phone: "06 01 02 03 04",
      client_email: "camille@example.test",
      event_type: "Mariage",
      venue: "Lyon",
      event_hours: "18h-02h",
      deposit_cents: 10_000,
      notes: "Paiement par virement",
    });
    expect(await stillDue(b.id)).toEqual(
      [
        "client_d7|email|2026-12-12T08:00:00.000Z",
        "owner_d7|email|2026-12-12T08:00:00.000Z",
        "owner_d7|telegram|2026-12-12T08:00:00.000Z",
        "owner_d1|email|2026-12-18T08:00:00.000Z",
        "owner_d1|telegram|2026-12-18T08:00:00.000Z",
      ].sort(),
    );
  });

  it("deux réservations manuelles ont chacune leur identifiant et leur jeton", async () => {
    const a = ok(await createManual(deps, { date: "2026-12-19", name: "A", priceCents: 0, depositCents: 0 }));
    const b = ok(await createManual(deps, { date: "2026-12-20", name: "B", priceCents: 0, depositCents: 0 }));
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("une réservation manuelle sur une date prise est refusée", async () => {
    await request();
    expect(await createManual(deps, { date: "2026-12-19", name: "Camille", priceCents: 0, depositCents: 0 })).toEqual({
      ok: false,
      reason: "date_taken",
    });
    expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toHaveLength(1);
  });

  it("une réservation manuelle sur une date libérée est acceptée", async () => {
    const p = await request();
    await refuseBooking(deps, p.id, "owner");
    const r = await createManual(deps, { date: "2026-12-19", name: "Camille", priceCents: 0, depositCents: 0 });
    expect(r.ok && r.booking.status).toBe("confirmed");
  });

  it.each(["2026-02-30", "19/12/2026", "", "2026-12-19T10:00:00Z", "2026-1-5"])(
    "une réservation manuelle à la date mal formée %j est refusée",
    async (date) => {
      expect(await createManual(deps, { date, name: "Camille", priceCents: 0, depositCents: 0 })).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(await listRange(env.DB, "0000-01-01", "9999-12-31")).toEqual([]);
    },
  );
});

describe("blockDate", () => {
  it("bloquer une date la rend indisponible sans rien notifier", async () => {
    const r = await blockDate(deps, "2026-12-24", "Congés");
    expect(r.ok && r.booking).toMatchObject({
      status: "blocked",
      source: "manual",
      event_date: "2026-12-24",
      notes: "Congés",
      client_name: null,
      hold_until: null,
    });
    expect(await decemberDates()).toEqual(["2026-12-24"]);
    expect(await listDueNotifications(env.DB, "2030-01-01T00:00:00Z", 20)).toEqual([]);
  });

  it("bloquer sans note laisse la note vide", async () => {
    const r = await blockDate(deps, "2026-12-24");
    expect(r.ok && r.booking.notes).toBeNull();
  });

  it("bloquer une date prise est refusé", async () => {
    await request();
    expect(await blockDate(deps, "2026-12-19")).toEqual({ ok: false, reason: "date_taken" });
  });

  it("bloquer deux fois la même date est refusé", async () => {
    await blockDate(deps, "2026-12-24");
    expect(await blockDate(deps, "2026-12-24")).toEqual({ ok: false, reason: "date_taken" });
  });

  it("bloquer une date mal formée est refusé", async () => {
    expect(await blockDate(deps, "2026-02-30")).toEqual({ ok: false, reason: "invalid" });
    expect(await listRange(env.DB, "0000-01-01", "9999-12-31")).toEqual([]);
  });

  it("bloquer puis retirer une date la libère sans prévenir personne", async () => {
    const blocked = ok(await blockDate(deps, "2026-12-24"));
    const r = await cancelBooking(deps, blocked.id, "owner");
    expect(r.ok && r.booking.status).toBe("cancelled");
    expect(await decemberDates()).toEqual([]);
    expect(await queued(blocked.id)).toEqual([]);
    expect(await getHistory(env.DB, blocked.id)).toMatchObject([{ actor: "owner", event: "cancelled" }]);
  });

  it("retirer une date bloquée ne prévient personne, même si une adresse y est consignée", async () => {
    const { booking } = await insert(newBooking({ status: "blocked", source: "manual", hold_until: null }));
    expect(booking.client_email).not.toBeNull();
    expect(ok(await cancelBooking(deps, booking.id, "owner")).status).toBe("cancelled");
    expect(await queued(booking.id)).toEqual([]);
  });
});

describe("le palier d'une réservation", () => {
  const allBookings = () => listRange(env.DB, "0000-01-01", "9999-12-31");

  it("createRequest stores the tier, its price, deposit and refill", async () => {
    const { tier } = currentTier(offer, {});
    const price = priceOf(tier, SECOND_PLAN.id);
    const b = created(await createRequest(deps, await requestBody({ plan: SECOND_PLAN.id }), null));
    expect(b).toMatchObject({
      plan: SECOND_PLAN.id,
      price_tier: tier.id,
      price_cents: price,
      deposit_cents: depositFor(price),
      refill_cents: tier.refillCents,
    });
  });

  it("createRequest answers price_changed before Turnstile", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    const input = await requestBody();
    const price = input.price_cents as number;
    expect(await createRequest(fakeDeps({ verifyTurnstile }), { ...input, price_cents: price + 100 }, null)).toEqual({
      kind: "price_changed",
      priceCents: price,
    });
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(await allBookings()).toEqual([]);
  });

  it("createRequest moves to the next tier once a tier is full", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000, 1), testTier("t3", 30_000));
    await takePlace("t1");
    const [, next] = offer.tiers;
    const b = created(await createRequest(deps, await requestBody(), null));
    expect(b).toMatchObject({ price_tier: next.id, price_cents: priceOf(next, FIRST_PLAN.id), refill_cents: next.refillCents });
  });

  it("createRequest answers price_changed when the tier fills during the request", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000, 1), testTier("t3", 30_000));
    const input = await requestBody();
    const [, next] = offer.tiers;
    expect(await createRequest(racingDeps(() => takePlace("t1")), input, null)).toEqual({
      kind: "price_changed",
      priceCents: priceOf(next, FIRST_PLAN.id),
    });
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 1 });
    expect(await allBookings()).toHaveLength(1);
  });

  it("retries the next tier when its price is the same", async () => {
    useTiers(testTier("t1", 10_000, 1), { ...testTier("t2", 10_000, 1), refillCents: 2_000 }, testTier("t3", 30_000));
    const input = await requestBody();
    const b = created(await createRequest(racingDeps(() => takePlace("t1")), input, null));
    expect(b).toMatchObject({ price_tier: "t2", price_cents: input.price_cents, refill_cents: 2_000 });
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 1, t2: 1 });
  });

  it("createRequest answers date_taken when the date is taken while the tier fills", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000));
    const input = await requestBody();
    expect(await createRequest(racingDeps(() => takePlace("t1", input.date as string)), input, null)).toEqual({ kind: "date_taken" });
    expect(await allBookings()).toHaveLength(1);
  });

  it("treats an identical send that took the last place as already requested", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000));
    const input = await requestBody();
    const twin = newBooking({ event_date: input.date as string, client_email: input.email as string, price_tier: "t1" });
    const r = await createRequest(racingDeps(() => insert(twin)), input, null);
    expect(r).toMatchObject({ kind: "already_requested", booking: { id: twin.id } });
    expect(await allBookings()).toHaveLength(1);
  });

  it("a refused request keeps its place", async () => {
    useTiers(testTier("t1", 10_000, 3), testTier("t2", 20_000));
    const remaining = async () => currentTier(offer, await countTakenByTier(env.DB)).remaining;
    const first = created(await createRequest(deps, await requestBody(), null));
    expect(await remaining()).toBe(2);
    ok(await refuseBooking(deps, first.id, "owner"));
    expect(await remaining()).toBe(2);
    created(await createRequest(deps, await requestBody(), null));
    expect(await remaining()).toBe(1);
  });

  it("createManual takes a place of the current tier", async () => {
    const { tier } = currentTier(offer, {});
    const b = ok(
      await createManual(deps, { date: "2026-12-19", name: "Camille", plan: SECOND_PLAN.id, priceCents: 12_345, depositCents: 1_000 }),
    );
    expect(b).toMatchObject({
      plan: SECOND_PLAN.id,
      price_tier: tier.id,
      refill_cents: tier.refillCents,
      price_cents: 12_345,
      deposit_cents: 1_000,
    });
    expect(await countTakenByTier(env.DB)).toEqual({ [tier.id]: 1 });
  });

  it("createManual answers tier_changed when the tier fills", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000));
    const r = await createManual(racingDeps(() => takePlace("t1")), { date: "2026-12-19", name: "Camille", priceCents: 0, depositCents: 0 });
    expect(r).toEqual({ ok: false, reason: "tier_changed" });
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 1 });
    expect(await allBookings()).toHaveLength(1);
  });

  it("createManual answers date_taken when the date is taken while the tier fills", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000));
    const r = await createManual(racingDeps(() => takePlace("t1", "2026-12-19")), { date: "2026-12-19", name: "Camille", priceCents: 0, depositCents: 0 });
    expect(r).toEqual({ ok: false, reason: "date_taken" });
    expect(await allBookings()).toHaveLength(1);
  });

  it("createManual takes the tier the form showed", async () => {
    const { tier } = currentTier(offer, {});
    const b = ok(await createManual(deps, { date: "2026-12-19", name: "Camille", tier: tier.id, priceCents: 0, depositCents: 0 }));
    expect(b).toMatchObject({ price_tier: tier.id, refill_cents: tier.refillCents });
  });

  it("createManual answers tier_changed when the tier the form showed is full", async () => {
    useTiers(testTier("t1", 10_000, 1), testTier("t2", 20_000));
    await takePlace("t1");
    const r = await createManual(deps, { date: "2026-12-19", name: "Camille", tier: "t1", priceCents: 0, depositCents: 0 });
    expect(r).toEqual({ ok: false, reason: "tier_changed" });
    expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toEqual([]);
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 1 });
  });

  it("blockDate takes no place", async () => {
    const b = ok(await blockDate(deps, "2026-12-24"));
    expect(b).toMatchObject({ price_tier: null, refill_cents: null });
    expect(await countTakenByTier(env.DB)).toEqual({});
  });
});
