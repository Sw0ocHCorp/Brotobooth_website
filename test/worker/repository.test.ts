import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_STATUSES, type BookingStatus } from "../../worker/bookings";
import {
  type NewBooking,
  anonymizeOld,
  applyTransition,
  cancelNotification as cancelPending,
  claimNotification,
  countActiveByEmail,
  countTakenByTier,
  countRecentByIp,
  enqueue,
  findActiveByDateAndEmail,
  getBooking,
  getBookingByToken,
  getHistory,
  getState,
  insertBooking,
  listDueHolds,
  listDueNotifications,
  listFailedNotifications,
  listRange,
  listTodo,
  listUnavailableDates,
  listUpcoming,
  markFailed,
  markSent,
  patchBooking,
  setState,
} from "../../worker/repository";
import { T0, insert, newBooking, resetDb, spec } from "../support";

// Compile-time exhaustive: adding a status to BookingStatus breaks this literal.
const ALL_STATUSES = Object.keys({
  pending_review: 0,
  awaiting_deposit: 0,
  confirmed: 0,
  blocked: 0,
  refused: 0,
  expired: 0,
  cancelled: 0,
} satisfies Record<BookingStatus, 0>) as BookingStatus[];

const dueKeys = async (): Promise<string[]> =>
  (await listDueNotifications(env.DB, T0, 100)).map((n) => n.dedupe_key);

const notificationId = async (key: string): Promise<number> => {
  const stmt = env.DB.prepare("SELECT id FROM notifications WHERE dedupe_key = ?");
  return (await stmt.bind(key).first<{ id: number }>())!.id;
};

const LEASE_END = "2026-11-07T10:02:00.000Z";

/** Un essai qui échoue : l'envoi est réservé (ce qui compte l'essai), puis libéré avec son erreur. */
const fail = async (key: string) => {
  const id = await notificationId(key);
  await claimNotification(env.DB, id, T0, LEASE_END);
  await markFailed(env.DB, id, "boom");
};

const cancelNotification = (key: string) =>
  env.DB.prepare("UPDATE notifications SET cancelled_at = ? WHERE dedupe_key = ?").bind(T0, key).run();

/** Une réservation d'une date donnée, dans un état et avec une échéance donnés. */
const hold = (event_date: string, status: BookingStatus, hold_until: string | null) =>
  insert(newBooking({ event_date, status, hold_until }));

beforeEach(() => resetDb(env.DB));

describe("une date, une réservation active", () => {
  it("refuse une deuxième réservation active sur la même date", async () => {
    expect((await insertBooking(env.DB, newBooking(), [], T0)).ok).toBe(true);
    expect(await insertBooking(env.DB, newBooking(), [], T0)).toEqual({
      ok: false,
      reason: "date_taken",
    });
  });

  it("ne laisse passer qu'une demande sur deux envoyées en même temps", async () => {
    const r = await Promise.all([
      insertBooking(env.DB, newBooking(), [], T0),
      insertBooking(env.DB, newBooking(), [], T0),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok)).toEqual([{ ok: false, reason: "date_taken" }]);
  });

  it.each<BookingStatus>(["refused", "expired", "cancelled"])(
    "une réservation %s libère la date",
    async (status) => {
      await insertBooking(env.DB, newBooking({ status }), [], T0);
      expect((await insertBooking(env.DB, newBooking(), [], T0)).ok).toBe(true);
    },
  );

  it.each<BookingStatus>(["pending_review", "awaiting_deposit", "confirmed", "blocked"])(
    "une réservation %s tient la date",
    async (status) => {
      await insertBooking(env.DB, newBooking({ status }), [], T0);
      expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual(["2026-12-19"]);
    },
  );

  // L'index de migrations/0001_init.sql écrit ses quatre états en SQL, alors que le reste du code
  // lit ACTIVE_STATUSES : ce test les garde d'accord pour chacun des sept états.
  it.each(ALL_STATUSES)("l'index unique et la liste des dates suivent ACTIVE_STATUSES pour %s", async (status) => {
    const held = ACTIVE_STATUSES.includes(status);
    await insertBooking(env.DB, newBooking({ status }), [], T0);
    const unavailable = await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31");
    expect(unavailable).toEqual(held ? ["2026-12-19"] : []);
    expect((await insertBooking(env.DB, newBooking(), [], T0)).ok).toBe(!held);
  });

  it("une date prise n'enregistre aucune notification", async () => {
    await insertBooking(env.DB, newBooking(), [], T0);
    const loser = newBooking();
    const r = await insertBooking(env.DB, loser, [spec("perdue", loser.id)], T0);
    expect(r).toEqual({ ok: false, reason: "date_taken" });
    expect(await getBooking(env.DB, loser.id)).toBeNull();
    expect(await dueKeys()).toEqual([]);
  });

  it("relance toute autre erreur que la date prise", async () => {
    const first = newBooking();
    await insertBooking(env.DB, first, [], T0);
    const sameToken = newBooking({ token: first.token, event_date: "2026-12-20" });
    await expect(insertBooking(env.DB, sameToken, [], T0)).rejects.toThrow(/token/);
  });
});

describe("insertBooking", () => {
  it("enregistre chaque colonne et renvoie la ligne relue", async () => {
    const nb = newBooking({
      stripe_session: "cs_test_1",
      stripe_session_expires: "2026-11-07T10:30:00.000Z",
      deposit_paid_at: "2026-11-07T10:05:00.000Z",
      balance_paid_at: "2026-12-19T22:00:00.000Z",
    });
    const r = await insertBooking(env.DB, nb, [], T0);
    const expected = { ...nb, created_at: T0, updated_at: T0 };
    expect(r).toEqual({ ok: true, booking: expected });
    expect(await getBooking(env.DB, nb.id)).toEqual(expected);
    expect(await getBookingByToken(env.DB, nb.token)).toEqual(expected);
  });

  it("met en file les notifications avec la réservation", async () => {
    const nb = newBooking();
    await insertBooking(env.DB, nb, [spec("a", nb.id), spec("b", nb.id)], T0);
    expect(await dueKeys()).toEqual(["a", "b"]);
  });

  it("ne garde qu'une notification par clé", async () => {
    const nb = newBooking();
    await insertBooking(env.DB, nb, [spec("a", nb.id), spec("a", nb.id)], T0);
    expect(await dueKeys()).toEqual(["a"]);
  });

  it("renvoie null pour une réservation ou un jeton inconnus", async () => {
    expect(await getBooking(env.DB, "inconnue")).toBeNull();
    expect(await getBookingByToken(env.DB, "inconnu")).toBeNull();
  });
});

describe("applyTransition", () => {
  // Deux états périmés : la ligne a changé avant, ou elle est déjà dans l'état visé et datée de l'instant de
  // l'appel (le cas qui trompait une condition fondée sur `status = to AND updated_at = nowIso`).
  it.each([
    ["la ligne a changé avant", { from: "pending_review", to: "refused", nowIso: "2026-11-08T10:00:00.000Z" }],
    ["la ligne est déjà dans l'état visé, au même instant", { from: "awaiting_deposit", to: "confirmed", nowIso: T0 }],
  ] as const)("une transition sur un état périmé ne change rien et n'écrit rien (%s)", async (_case, step) => {
    const nb = newBooking({ status: "confirmed" });
    await insertBooking(env.DB, nb, [spec("en-attente", nb.id)], T0);
    const before = await getBooking(env.DB, nb.id);

    const r = await applyTransition(env.DB, {
      id: nb.id,
      ...step,
      patch: { notes: "ne doit pas être écrit" },
      actor: "owner",
      event: "refused",
      cancelPending: true,
      notifications: [spec("k1", nb.id)],
    });

    expect(r).toBeNull();
    expect(await getBooking(env.DB, nb.id)).toEqual(before);
    expect(await getHistory(env.DB, nb.id)).toHaveLength(0);
    // L'envoi en attente reste dû, non annulé ; la notification de la transition n'est pas écrite.
    expect(await dueKeys()).toEqual(["en-attente"]);
    const stored = await env.DB.prepare("SELECT dedupe_key, cancelled_at FROM notifications").all();
    expect(stored.results).toEqual([{ dedupe_key: "en-attente", cancelled_at: null }]);
  });

  it("une transition sur une réservation inconnue renvoie null", async () => {
    const r = await applyTransition(env.DB, {
      id: "inconnue",
      from: "pending_review",
      to: "refused",
      actor: "owner",
      event: "refused",
      nowIso: T0,
    });
    expect(r).toBeNull();
  });

  it("une transition valide écrit l'historique, annule les envois en attente et planifie les suivants", async () => {
    const nb = newBooking();
    await insertBooking(env.DB, nb, [spec("avant", nb.id)], T0);
    const r = await applyTransition(env.DB, {
      id: nb.id,
      from: "pending_review",
      to: "awaiting_deposit",
      actor: "owner",
      event: "validated",
      cancelPending: true,
      notifications: [spec("apres", nb.id)],
      nowIso: T0,
    });
    expect(r!.status).toBe("awaiting_deposit");
    expect(await getHistory(env.DB, nb.id)).toHaveLength(1);
    expect((await listDueNotifications(env.DB, T0, 10)).map((n) => n.dedupe_key)).toEqual(["apres"]);
  });

  it("applique le correctif, date la mise à jour et détaille l'historique", async () => {
    const { booking } = await insert(newBooking());
    const later = "2026-11-08T09:00:00.000Z";
    const r = await applyTransition(env.DB, {
      id: booking.id,
      from: "pending_review",
      to: "awaiting_deposit",
      patch: { hold_until: "2026-11-11T09:00:00.000Z", price_cents: 140_000 },
      actor: "owner",
      event: "validated",
      detail: "prix ajusté",
      nowIso: later,
    });
    expect(r).toEqual({
      ...booking,
      status: "awaiting_deposit",
      hold_until: "2026-11-11T09:00:00.000Z",
      price_cents: 140_000,
      updated_at: later,
    });
    expect(await getBooking(env.DB, booking.id)).toEqual(r);
    expect(await getHistory(env.DB, booking.id)).toEqual([
      {
        id: expect.any(Number),
        booking_id: booking.id,
        at: later,
        actor: "owner",
        event: "validated",
        detail: "prix ajusté",
      },
    ]);
  });

  it("sans cancelPending, les envois en attente restent", async () => {
    const nb = newBooking();
    await insertBooking(env.DB, nb, [spec("avant", nb.id)], T0);
    await applyTransition(env.DB, {
      id: nb.id,
      from: "pending_review",
      to: "awaiting_deposit",
      actor: "owner",
      event: "validated",
      notifications: [spec("apres", nb.id)],
      nowIso: T0,
    });
    expect(await dueKeys()).toEqual(["avant", "apres"]);
  });

  it("n'annule pas les envois déjà partis ni ceux d'une autre réservation", async () => {
    const a = newBooking({ event_date: "2026-12-19" });
    const b = newBooking({ event_date: "2026-12-20" });
    await insertBooking(env.DB, a, [spec("a-envoye", a.id), spec("a-attente", a.id)], T0);
    await insertBooking(env.DB, b, [spec("b-attente", b.id)], T0);
    await markSent(env.DB, await notificationId("a-envoye"), T0);

    await applyTransition(env.DB, {
      id: a.id,
      from: "pending_review",
      to: "refused",
      actor: "owner",
      event: "refused",
      cancelPending: true,
      nowIso: T0,
    });

    expect(await dueKeys()).toEqual(["b-attente"]);
    const stored = await env.DB
      .prepare("SELECT dedupe_key, sent_at, cancelled_at FROM notifications ORDER BY id")
      .all();
    expect(stored.results).toEqual([
      { dedupe_key: "a-envoye", sent_at: T0, cancelled_at: null },
      { dedupe_key: "a-attente", sent_at: null, cancelled_at: T0 },
      { dedupe_key: "b-attente", sent_at: null, cancelled_at: null },
    ]);
  });

  it("deux décisions simultanées sur la même demande : une seule passe", async () => {
    const { booking } = await insert(newBooking());
    const decide = (to: BookingStatus, nowIso: string) =>
      applyTransition(env.DB, {
        id: booking.id,
        from: "pending_review",
        to,
        actor: "owner",
        event: to,
        notifications: [spec(`k-${to}`)],
        nowIso,
      });
    const r = await Promise.all([
      decide("awaiting_deposit", "2026-11-07T10:00:01.000Z"),
      decide("refused", "2026-11-07T10:00:02.000Z"),
    ]);
    expect(r.filter((x) => x !== null)).toHaveLength(1);
    expect(await getHistory(env.DB, booking.id)).toHaveLength(1);
    expect(await dueKeys()).toHaveLength(1);
  });

  it("deux décisions identiques au même instant : une seule passe", async () => {
    const { booking } = await insert(newBooking());
    const refuse = () =>
      applyTransition(env.DB, {
        id: booking.id,
        from: "pending_review",
        to: "refused",
        actor: "owner",
        event: "refused",
        notifications: [spec("k-refused", booking.id)],
        nowIso: T0,
      });
    const r = await Promise.all([refuse(), refuse()]);
    expect(r.filter((x) => x !== null)).toHaveLength(1);
    expect(await getHistory(env.DB, booking.id)).toHaveLength(1);
  });

  it.each(["id", "token", "status", "created_at", "updated_at"] as const)(
    "refuse un correctif qui touche %s",
    async (column) => {
      const { booking } = await insert(newBooking());
      await expect(
        applyTransition(env.DB, {
          id: booking.id,
          from: "pending_review",
          to: "refused",
          patch: { [column]: "x" },
          actor: "owner",
          event: "refused",
          nowIso: T0,
        }),
      ).rejects.toThrow(column);
      expect(await getBooking(env.DB, booking.id)).toEqual(booking);
    },
  );
});

describe("patchBooking", () => {
  it("modifie les champs, date la mise à jour et écrit l'historique", async () => {
    const { booking } = await insert(newBooking({ status: "awaiting_deposit" }));
    const later = "2026-11-08T09:00:00.000Z";
    const r = await patchBooking(
      env.DB,
      booking.id,
      { stripe_session: "cs_test_2", stripe_session_expires: "2026-11-08T09:30:00.000Z" },
      "client",
      "session_created",
      later,
    );
    expect(r).toEqual({
      ...booking,
      stripe_session: "cs_test_2",
      stripe_session_expires: "2026-11-08T09:30:00.000Z",
      updated_at: later,
    });
    expect(r!.status).toBe("awaiting_deposit");
    expect(await getHistory(env.DB, booking.id)).toEqual([
      {
        id: expect.any(Number),
        booking_id: booking.id,
        at: later,
        actor: "client",
        event: "session_created",
        detail: null,
      },
    ]);
  });

  it("renvoie null et n'écrit rien pour une réservation inconnue", async () => {
    expect(await patchBooking(env.DB, "inconnue", { notes: "x" }, "owner", "noted", T0)).toBeNull();
    const history = await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_history").first<{ n: number }>();
    expect(history!.n).toBe(0);
  });

  it("refuse de changer l'état, qui ne passe que par une transition", async () => {
    const { booking } = await insert(newBooking());
    await expect(
      patchBooking(env.DB, booking.id, { status: "confirmed" }, "owner", "hack", T0),
    ).rejects.toThrow("status");
    expect((await getBooking(env.DB, booking.id))!.status).toBe("pending_review");
  });
});

describe("lectures des réservations", () => {
  it("findActiveByDateAndEmail ne trouve que les demandes à traiter, quelle que soit la casse", async () => {
    const { booking } = await insert(newBooking());
    expect(await findActiveByDateAndEmail(env.DB, "2026-12-19", "camille@example.test")).toEqual(booking);
    expect(await findActiveByDateAndEmail(env.DB, "2026-12-19", "CAMILLE@Example.test")).toEqual(booking);
    expect(await findActiveByDateAndEmail(env.DB, "2026-12-19", "autre@example.test")).toBeNull();
    expect(await findActiveByDateAndEmail(env.DB, "2026-12-20", "camille@example.test")).toBeNull();

    await applyTransition(env.DB, {
      id: booking.id,
      from: "pending_review",
      to: "awaiting_deposit",
      actor: "owner",
      event: "validated",
      nowIso: T0,
    });
    const found = await findActiveByDateAndEmail(env.DB, "2026-12-19", "camille@example.test");
    expect(found!.id).toBe(booking.id);

    await applyTransition(env.DB, {
      id: booking.id,
      from: "awaiting_deposit",
      to: "confirmed",
      actor: "stripe",
      event: "paid",
      nowIso: T0,
    });
    expect(await findActiveByDateAndEmail(env.DB, "2026-12-19", "camille@example.test")).toBeNull();
  });

  it("listUnavailableDates borne la période, dates incluses, par ordre de date", async () => {
    for (const day of ["2026-11-30", "2026-12-24", "2026-12-01", "2026-12-31", "2027-01-01"]) {
      await insert(newBooking({ event_date: day, status: "confirmed" }));
    }
    await insert(newBooking({ event_date: "2026-12-10", status: "refused" }));
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual([
      "2026-12-01",
      "2026-12-24",
      "2026-12-31",
    ]);
  });

  it("countActiveByEmail ne compte que les demandes à traiter, quelle que soit la casse", async () => {
    for (const [i, status] of ALL_STATUSES.entries()) {
      await insert(newBooking({ status, event_date: `2026-12-${String(i + 1).padStart(2, "0")}` }));
    }
    await insert(newBooking({ client_email: "autre@example.test", event_date: "2026-12-20" }));
    expect(await countActiveByEmail(env.DB, "camille@example.test")).toBe(2);
    expect(await countActiveByEmail(env.DB, "Camille@EXAMPLE.test")).toBe(2);
    expect(await countActiveByEmail(env.DB, "inconnu@example.test")).toBe(0);
  });

  it("countRecentByIp compte toutes les demandes depuis l'instant donné, bornes incluses", async () => {
    const at = (iso: string, day: string, over: Partial<NewBooking> = {}) =>
      insertBooking(env.DB, newBooking({ event_date: day, ...over }), [], iso);
    await at("2026-11-06T09:59:59.000Z", "2026-12-01");
    await at("2026-11-06T10:00:00.000Z", "2026-12-02");
    await at(T0, "2026-12-03", { status: "refused" });
    await at(T0, "2026-12-04", { ip_hash: "ip-hash-2" });
    expect(await countRecentByIp(env.DB, "ip-hash-1", "2026-11-06T10:00:00.000Z")).toBe(2);
    expect(await countRecentByIp(env.DB, "ip-hash-2", "2026-11-06T10:00:00.000Z")).toBe(1);
    expect(await countRecentByIp(env.DB, "ip-hash-3", "2026-11-06T10:00:00.000Z")).toBe(0);
  });

  it("listDueHolds renvoie les demandes en cours dont l'échéance est atteinte, par échéance", async () => {
    await hold("2026-12-01", "pending_review", "2026-11-09T10:00:00.000Z");
    await hold("2026-12-02", "awaiting_deposit", "2026-11-08T10:00:00.000Z");
    await hold("2026-12-03", "pending_review", "2026-11-10T10:00:00.000Z");
    await hold("2026-12-04", "confirmed", "2026-11-01T10:00:00.000Z");
    await hold("2026-12-05", "blocked", null);

    const due = await listDueHolds(env.DB, "2026-11-09T10:00:00.000Z");
    expect(due.map((b) => b.event_date)).toEqual(["2026-12-02", "2026-12-01"]);
    expect(await listDueHolds(env.DB, "2026-11-09T09:59:59.000Z")).toHaveLength(1);
  });

  it("listUpcoming filtre par état à partir de la date, par date d'événement", async () => {
    await insert(newBooking({ event_date: "2026-12-24", status: "confirmed" }));
    await insert(newBooking({ event_date: "2026-12-05", status: "awaiting_deposit" }));
    await insert(newBooking({ event_date: "2026-12-12", status: "blocked" }));
    await insert(newBooking({ event_date: "2026-11-20", status: "confirmed" }));
    await insert(newBooking({ event_date: "2026-12-30", status: "refused" }));
    const from = (statuses: BookingStatus[]) =>
      listUpcoming(env.DB, "2026-12-05", statuses).then((rows) => rows.map((b) => b.event_date));

    expect(await from(["confirmed", "awaiting_deposit", "blocked"])).toEqual([
      "2026-12-05",
      "2026-12-12",
      "2026-12-24",
    ]);
    expect(await from(["confirmed"])).toEqual(["2026-12-24"]);
    expect(await from([])).toEqual([]);
  });

  it("listRange renvoie tous les états de la période, bornes incluses, par date", async () => {
    await insert(newBooking({ event_date: "2026-12-31", status: "confirmed" }));
    await insert(newBooking({ event_date: "2026-12-01", status: "pending_review" }));
    await insert(newBooking({ event_date: "2026-12-15", status: "refused" }));
    await insert(newBooking({ event_date: "2027-01-01", status: "confirmed" }));
    await insert(newBooking({ event_date: "2026-11-30", status: "confirmed" }));
    const rows = await listRange(env.DB, "2026-12-01", "2026-12-31");
    expect(rows.map((b) => [b.event_date, b.status])).toEqual([
      ["2026-12-01", "pending_review"],
      ["2026-12-15", "refused"],
      ["2026-12-31", "confirmed"],
    ]);
  });

  it("listTodo renvoie les demandes en cours par échéance croissante", async () => {
    await hold("2026-12-01", "pending_review", "2026-11-10T10:00:00.000Z");
    await hold("2026-12-02", "awaiting_deposit", "2026-11-09T10:00:00.000Z");
    await hold("2026-12-03", "pending_review", "2026-11-08T10:00:00.000Z");
    await hold("2026-12-04", "confirmed", "2026-11-01T10:00:00.000Z");
    await hold("2026-12-05", "expired", "2026-11-01T10:00:00.000Z");
    const todo = await listTodo(env.DB);
    expect(todo.map((b) => b.event_date)).toEqual(["2026-12-03", "2026-12-02", "2026-12-01"]);
  });
});

describe("file de notifications", () => {
  it("une même clé de notification n'est enregistrée qu'une fois", async () => {
    await enqueue(env.DB, [spec("x"), spec("x")]);
    expect(await listDueNotifications(env.DB, T0, 10)).toHaveLength(1);
    await enqueue(env.DB, [spec("x")]);
    expect(await listDueNotifications(env.DB, T0, 10)).toHaveLength(1);
  });

  it("enqueue accepte une liste vide", async () => {
    await enqueue(env.DB, []);
    expect(await dueKeys()).toEqual([]);
  });

  it("enregistre le contenu de la notification et ses compteurs à zéro", async () => {
    const { booking } = await insert(newBooking());
    await enqueue(env.DB, [
      { ...spec("k", booking.id), channel: "telegram", recipient: "client", template: "t" },
    ]);
    expect(await listDueNotifications(env.DB, T0, 10)).toEqual([
      {
        id: expect.any(Number),
        booking_id: booking.id,
        dedupe_key: "k",
        channel: "telegram",
        recipient: "client",
        template: "t",
        due_at: T0,
        sent_at: null,
        cancelled_at: null,
        attempts: 0,
        last_error: null,
        claimed_until: null,
      },
    ]);
  });

  it("listDueNotifications ne renvoie que les envois échus, par échéance, dans la limite", async () => {
    await enqueue(env.DB, [
      { ...spec("tard"), due_at: "2026-11-07T09:00:00.000Z" },
      { ...spec("tot"), due_at: "2026-11-07T08:00:00.000Z" },
      { ...spec("futur"), due_at: "2026-11-07T10:00:00.001Z" },
      { ...spec("pile"), due_at: T0 },
    ]);
    expect(await dueKeys()).toEqual(["tot", "tard", "pile"]);
    expect((await listDueNotifications(env.DB, T0, 2)).map((n) => n.dedupe_key)).toEqual(["tot", "tard"]);
  });

  it("listDueNotifications exclut les envois faits, annulés ou arrivés à 288 tentatives", async () => {
    await enqueue(env.DB, ["ok", "fait", "annule", "287", "288"].map((k) => spec(k)));
    await markSent(env.DB, await notificationId("fait"), T0);
    await cancelNotification("annule");
    await env.DB.prepare("UPDATE notifications SET attempts = 287 WHERE dedupe_key = '287'").run();
    await env.DB.prepare("UPDATE notifications SET attempts = 288 WHERE dedupe_key = '288'").run();
    expect(await dueKeys()).toEqual(["ok", "287"]);
  });

  it("markSent date l'envoi", async () => {
    await enqueue(env.DB, [spec("x")]);
    const [n] = await listDueNotifications(env.DB, T0, 10);
    await markSent(env.DB, n!.id, "2026-11-07T10:05:00.000Z");
    expect(await dueKeys()).toEqual([]);
    const row = await env.DB.prepare("SELECT sent_at FROM notifications WHERE id = ?").bind(n!.id).first();
    expect(row).toEqual({ sent_at: "2026-11-07T10:05:00.000Z" });
  });

  it("cancelNotification retire un envoi de la file, une seule fois, sans toucher à un envoi déjà fait", async () => {
    await enqueue(env.DB, ["a-annuler", "fait", "deja-annule"].map((k) => spec(k)));
    await markSent(env.DB, await notificationId("fait"), T0);
    await cancelNotification("deja-annule");

    for (const key of ["a-annuler", "fait", "deja-annule"]) {
      await cancelPending(env.DB, await notificationId(key), "2026-11-07T11:00:00.000Z");
    }
    const rows = await env.DB.prepare("SELECT dedupe_key, sent_at, cancelled_at FROM notifications ORDER BY id").all();
    expect(rows.results).toEqual([
      { dedupe_key: "a-annuler", sent_at: null, cancelled_at: "2026-11-07T11:00:00.000Z" },
      { dedupe_key: "fait", sent_at: T0, cancelled_at: null },
      { dedupe_key: "deja-annule", sent_at: null, cancelled_at: T0 },
    ]);
    expect(await dueKeys()).toEqual([]);
  });

  it("markFailed garde la dernière erreur sans compter d'essai : c'est la réservation qui le compte", async () => {
    await enqueue(env.DB, [spec("x")]);
    const [n] = await listDueNotifications(env.DB, T0, 10);
    await claimNotification(env.DB, n!.id, T0, LEASE_END);
    await markFailed(env.DB, n!.id, "resend 500");
    await claimNotification(env.DB, n!.id, T0, LEASE_END);
    await markFailed(env.DB, n!.id, "resend 503");
    const [again] = await listDueNotifications(env.DB, T0, 10);
    expect(again).toMatchObject({ id: n!.id, attempts: 2, last_error: "resend 503", sent_at: null, claimed_until: null });
    await markFailed(env.DB, n!.id, "resend 504");
    expect((await listDueNotifications(env.DB, T0, 10))[0]).toMatchObject({ attempts: 2, last_error: "resend 504" });
  });

  it("listFailedNotifications renvoie les envois à 3 essais ou plus, ni faits ni annulés", async () => {
    await enqueue(env.DB, ["deux", "trois", "quatre", "fait", "annule"].map((k) => spec(k)));
    const tries = { deux: 2, trois: 3, quatre: 4, fait: 3, annule: 3 };
    for (const [key, times] of Object.entries(tries)) {
      for (let i = 0; i < times; i++) await fail(key);
    }
    await markSent(env.DB, await notificationId("fait"), T0);
    await cancelNotification("annule");

    const failed = await listFailedNotifications(env.DB, T0);
    expect(failed.map((n) => [n.dedupe_key, n.attempts])).toEqual([["trois", 3], ["quatre", 4]]);
  });

  it("listFailedNotifications ne compte pas l'envoi réservé par un passage en cours, avant la fin de sa réservation", async () => {
    await enqueue(env.DB, [spec("en-vol"), spec("libere")]);
    for (const key of ["en-vol", "libere"]) {
      await fail(key);
      await fail(key);
    }
    // La troisième tentative de « en-vol » est partie : l'envoi reste réservé jusqu'à LEASE_END, sans échec connu.
    await claimNotification(env.DB, await notificationId("en-vol"), T0, LEASE_END);
    await fail("libere");

    expect((await listFailedNotifications(env.DB, T0)).map((n) => n.dedupe_key)).toEqual(["libere"]);
    expect((await listFailedNotifications(env.DB, LEASE_END)).map((n) => n.dedupe_key)).toEqual(["en-vol", "libere"]);
  });
});

describe("réservation d'un envoi", () => {
  const LATER = "2026-11-07T10:02:00.000Z";
  const row = async (key: string) =>
    (await env.DB.prepare("SELECT attempts, claimed_until, sent_at FROM notifications WHERE dedupe_key = ?").bind(key).first())!;

  it("rend le nombre d'essais, compte l'essai et date la fin de la réservation", async () => {
    await enqueue(env.DB, [spec("x")]);
    const id = await notificationId("x");
    expect(await claimNotification(env.DB, id, T0, LATER)).toBe(1);
    expect(await row("x")).toEqual({ attempts: 1, claimed_until: LATER, sent_at: null });
  });

  it("n'est obtenue que par un seul passage, y compris quand deux demandes se croisent", async () => {
    await enqueue(env.DB, [spec("x")]);
    const id = await notificationId("x");
    const wins = await Promise.all([1, 2, 3, 4].map(() => claimNotification(env.DB, id, T0, LATER)));
    expect(wins.filter((attempts) => attempts !== null)).toEqual([1]);
    expect((await row("x")).attempts).toBe(1);
  });

  it("n'est pas obtenue tant que la réservation d'un autre passage dure, et l'est à son échéance", async () => {
    await enqueue(env.DB, [spec("x")]);
    const id = await notificationId("x");
    await claimNotification(env.DB, id, T0, LATER);
    expect(await claimNotification(env.DB, id, "2026-11-07T10:01:59.999Z", "2026-11-07T10:04:00.000Z")).toBeNull();
    expect(await claimNotification(env.DB, id, LATER, "2026-11-07T10:04:00.000Z")).toBe(2);
    expect(await row("x")).toEqual({ attempts: 2, claimed_until: "2026-11-07T10:04:00.000Z", sent_at: null });
  });

  it("n'est pas obtenue pour un envoi fait, annulé ou inconnu", async () => {
    await enqueue(env.DB, ["fait", "annule"].map((k) => spec(k)));
    await markSent(env.DB, await notificationId("fait"), T0);
    await cancelNotification("annule");
    expect(await claimNotification(env.DB, await notificationId("fait"), T0, LATER)).toBeNull();
    expect(await claimNotification(env.DB, await notificationId("annule"), T0, LATER)).toBeNull();
    expect(await claimNotification(env.DB, 999_999, T0, LATER)).toBeNull();
    expect((await row("fait")).attempts).toBe(0);
  });

  it("retire l'envoi de la liste des envois dus jusqu'à la fin de la réservation", async () => {
    await enqueue(env.DB, [spec("x"), spec("y")]);
    await claimNotification(env.DB, await notificationId("x"), T0, LATER);
    expect(await dueKeys()).toEqual(["y"]);
    expect((await listDueNotifications(env.DB, "2026-11-07T10:01:59.999Z", 10)).map((n) => n.dedupe_key)).toEqual(["y"]);
    expect((await listDueNotifications(env.DB, LATER, 10)).map((n) => n.dedupe_key)).toEqual(["x", "y"]);
  });

  it("markFailed libère la réservation, markSent laisse l'envoi fait", async () => {
    await enqueue(env.DB, [spec("x"), spec("y")]);
    for (const key of ["x", "y"]) await claimNotification(env.DB, await notificationId(key), T0, LATER);
    await markFailed(env.DB, await notificationId("x"), "boom");
    await markSent(env.DB, await notificationId("y"), T0);
    expect(await dueKeys()).toEqual(["x"]);
    expect((await row("y")).sent_at).toBe(T0);
  });
});

describe("état du système", () => {
  it("getState renvoie null tant que la clé n'existe pas", async () => {
    expect(await getState(env.DB, "last_cron_run")).toBeNull();
  });

  it("setState crée puis remplace la valeur", async () => {
    await setState(env.DB, "last_cron_run", T0);
    expect(await getState(env.DB, "last_cron_run")).toBe(T0);
    await setState(env.DB, "last_cron_run", "2026-11-07T10:05:00.000Z");
    expect(await getState(env.DB, "last_cron_run")).toBe("2026-11-07T10:05:00.000Z");
  });
});

describe("anonymizeOld", () => {
  const THIRTEEN_MONTHS_AGO = "2025-10-07T10:00:00.000Z";
  const CUTOFF = "2025-11-07T10:00:00.000Z";
  const seed = async (status: BookingStatus, day: string, createdAt = THIRTEEN_MONTHS_AGO, over: Partial<NewBooking> = {}) => {
    const nb = newBooking({ status, event_date: day, ...over });
    const r = await insertBooking(env.DB, nb, [], createdAt);
    if (!r.ok) throw new Error("seed");
    return r.booking;
  };
  const PERSONAL = {
    client_name: null,
    client_email: null,
    client_phone: null,
    venue: null,
    event_hours: null,
    message: null,
    ip_hash: null,
    notes: null,
  };

  it("anonymise les refus et expirations anciens, pas les prestations", async () => {
    const refused = await seed("refused", "2026-12-01");
    const expired = await seed("expired", "2026-12-02");
    const confirmed = await seed("confirmed", "2026-12-03");

    expect(await anonymizeOld(env.DB, CUTOFF, T0)).toBe(2);

    for (const before of [refused, expired]) {
      const after = (await getBooking(env.DB, before.id))!;
      expect(after).toMatchObject({ ...PERSONAL, anonymized_at: T0 });
      // Le reste de la ligne, dont updated_at, ne bouge pas.
      expect(after).toEqual({ ...before, ...PERSONAL, anonymized_at: T0 });
    }
    expect(await getBooking(env.DB, confirmed.id)).toEqual(confirmed);
  });

  // La politique de confidentialité promet l'effacement d'une demande « restée sans suite faute de réponse ou d'acompte ».
  it("anonymise aussi une demande annulée avant tout acompte, pas une annulation après paiement", async () => {
    const unpaid = await seed("cancelled", "2026-12-02");
    const paid = await seed("cancelled", "2026-12-04", THIRTEEN_MONTHS_AGO, { deposit_paid_at: THIRTEEN_MONTHS_AGO });

    expect(await anonymizeOld(env.DB, CUTOFF, T0)).toBe(1);

    expect(await getBooking(env.DB, unpaid.id)).toEqual({ ...unpaid, ...PERSONAL, anonymized_at: T0 });
    expect(await getBooking(env.DB, paid.id)).toEqual(paid);
  });

  it("laisse les demandes récentes, celles en cours et les annulations récentes", async () => {
    const recent = await seed("refused", "2026-12-01", "2026-06-01T10:00:00.000Z");
    const recentCancelled = await seed("cancelled", "2026-12-02", "2026-06-01T10:00:00.000Z");
    const pending = await seed("pending_review", "2026-12-03");
    const awaiting = await seed("awaiting_deposit", "2026-12-05");
    const edge = await seed("expired", "2026-12-04", CUTOFF);

    expect(await anonymizeOld(env.DB, CUTOFF, T0)).toBe(0);

    for (const before of [recent, recentCancelled, pending, awaiting, edge]) {
      expect(await getBooking(env.DB, before.id)).toEqual(before);
    }
  });

  it("compte les 12 mois depuis la création : modifier une demande ne prolonge pas la conservation", async () => {
    const refused = await seed("refused", "2026-12-01");
    await patchBooking(env.DB, refused.id, { notes: "Rappelée." }, "owner", "noted", T0);
    expect((await getBooking(env.DB, refused.id))!.updated_at).toBe(T0);

    expect(await anonymizeOld(env.DB, CUTOFF, T0)).toBe(1);

    expect(await getBooking(env.DB, refused.id)).toMatchObject({ ...PERSONAL, anonymized_at: T0, updated_at: T0 });
  });

  it("ne repasse pas sur une ligne déjà anonymisée", async () => {
    const refused = await seed("refused", "2026-12-01");
    expect(await anonymizeOld(env.DB, CUTOFF, T0)).toBe(1);
    expect(await anonymizeOld(env.DB, CUTOFF, "2026-11-08T10:00:00.000Z")).toBe(0);
    expect((await getBooking(env.DB, refused.id))!.anonymized_at).toBe(T0);
  });
});

describe("le palier d'une réservation", () => {
  const dayOf = (i: number) => `2026-12-${String(i + 1).padStart(2, "0")}`;
  const cap = { tier: "t1", places: 1 };
  const count = async (table: "bookings" | "notifications") =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

  it("countTakenByTier counts every status", async () => {
    const statuses: BookingStatus[] = ["pending_review", "awaiting_deposit", "confirmed", "refused", "expired", "cancelled"];
    for (const [i, status] of statuses.entries()) {
      await insert(newBooking({ status, event_date: dayOf(i), price_tier: "t1", refill_cents: 100 }));
    }
    await insert(newBooking({ status: "blocked", event_date: dayOf(10), source: "manual", price_tier: null }));
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 6 });
  });

  it("insertBooking with a cap refuses a full tier", async () => {
    const first = await insertBooking(env.DB, newBooking({ event_date: dayOf(0), price_tier: "t1" }), [spec("a")], T0, cap);
    expect(first.ok).toBe(true);
    const second = newBooking({ event_date: dayOf(1), price_tier: "t1" });
    const refused = await insertBooking(env.DB, second, [spec("b", second.id)], T0, cap);
    expect(refused).toEqual({ ok: false, reason: "tier_full" });
    expect(await getBooking(env.DB, second.id)).toBeNull();
    expect(await count("bookings")).toBe(1);
    expect(await count("notifications")).toBe(1);
  });

  it("insertBooking with a cap lets only one of two simultaneous inserts through", async () => {
    const r = await Promise.all([
      insertBooking(env.DB, newBooking({ event_date: dayOf(0), price_tier: "t1" }), [], T0, cap),
      insertBooking(env.DB, newBooking({ event_date: dayOf(1), price_tier: "t1" }), [], T0, cap),
    ]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok)).toEqual([{ ok: false, reason: "tier_full" }]);
  });

  it("insertBooking still reports a taken date with a cap", async () => {
    await insert(newBooking({ price_tier: "t1" }));
    const r = await insertBooking(env.DB, newBooking({ price_tier: "t1" }), [], T0, { tier: "t1", places: 5 });
    expect(r).toEqual({ ok: false, reason: "date_taken" });
  });

  it("anonymizeOld keeps the tier and the refill price", async () => {
    const nb = newBooking({ status: "refused", price_tier: "t1", refill_cents: 700 });
    await insertBooking(env.DB, nb, [], "2025-10-07T10:00:00.000Z");
    expect(await anonymizeOld(env.DB, "2025-11-07T10:00:00.000Z", T0)).toBe(1);
    expect(await getBooking(env.DB, nb.id)).toMatchObject({ price_tier: "t1", refill_cents: 700 });
    expect(await countTakenByTier(env.DB)).toEqual({ t1: 1 });
  });

  it("patchBooking cannot move a booking to another tier", async () => {
    const { booking } = await insert(newBooking({ price_tier: "t1" }));
    await expect(
      patchBooking(env.DB, booking.id, { price_tier: "t2" }, "owner", "hack", T0),
    ).rejects.toThrow("price_tier");
    expect((await getBooking(env.DB, booking.id))!.price_tier).toBe("t1");
  });
});
