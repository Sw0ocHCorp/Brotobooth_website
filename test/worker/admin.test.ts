import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDeps, type Deps } from "../../worker/deps";
import { processDue } from "../../worker/notifications";
import { confirmDeposit } from "../../worker/operations";
import {
  claimNotification,
  enqueue,
  getBooking,
  getHistory,
  listRange,
  markFailed,
  patchBooking,
  setState,
  type Booking,
} from "../../worker/repository";
import { handle } from "../../worker/router";
import { T0, fakeDeps, insert, newBooking, notificationRows, request, resetDb, spec, validatedBooking, type FakeDeps } from "../support";

const BASE = "https://brotobooth.fr";
const LEASE_END = "2026-11-07T10:02:00.000Z";

let deps: FakeDeps;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
});

/**
 * Un appel à l'API d'administration, comme le ferait la page `/admin` : même origine que le site et corps JSON,
 * sauf si le test en décide autrement (`origin: null` : aucun en-tête). L'envoi immédiat des messages se fait
 * après la réponse : le test l'attend, pour qu'aucun envoi ne déborde sur le test suivant.
 */
const api = async (
  method: string,
  path: string,
  body?: unknown,
  d: Deps = deps,
  origin: string | null = BASE,
  headers: Record<string, string> = {},
) => {
  const background = createExecutionContext();
  const response = await handle(
    new Request(BASE + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(origin === null ? {} : { Origin: origin }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
    }),
    d,
    background,
  );
  await waitOnExecutionContext(background);
  return response;
};

type Reply = {
  error?: string;
  fields?: string[];
  booking?: Booking;
  bookings?: Booking[];
  todo?: Booking[];
  health?: { lastCronRun: string | null; failedNotifications: number };
  history?: { at: string; actor: string; event: string; detail?: string | null }[];
};
const reply = (r: Response) => r.json<Reply>();

const bookingPath = (id: string, action = "") => `/api/admin/bookings/${id}${action && `/${action}`}`;
const act = (id: string, action: string, d: Deps = deps) => api("POST", bookingPath(id, action), {}, d);
const patch = (id: string, body: unknown, d: Deps = deps) => api("PATCH", bookingPath(id), body, d);
const create = (body: unknown, d: Deps = deps) => api("POST", "/api/admin/bookings", body, d);

const statusOf = async (id: string) => (await getBooking(env.DB, id))!.status;

/** Un échec d'envoi : l'envoi est réservé (ce qui compte l'essai), puis libéré avec son erreur. */
async function failOnce(key: string) {
  const row = await env.DB.prepare("SELECT id FROM notifications WHERE dedupe_key = ?").bind(key).first<{ id: number }>();
  await claimNotification(env.DB, row!.id, T0, LEASE_END);
  await markFailed(env.DB, row!.id, "boom");
}

/** Une demande validée dont le client a ouvert une session Stripe (`cs_1`). */
async function validatedWithSession(): Promise<Booking> {
  const v = await validatedBooking(deps);
  const session = await deps.stripe.createSession({
    bookingId: v.id,
    token: v.token,
    email: v.client_email,
    amountCents: v.deposit_cents!,
    label: "Acompte",
    expiresAt: Date.parse(T0) / 1000 + 1800,
  });
  const expires = new Date(session.expiresAt * 1000).toISOString();
  return (await patchBooking(env.DB, v.id, { stripe_session: session.id, stripe_session_expires: expires }, "client", "payment_session_opened", T0))!;
}

describe("accès", () => {
  it("répond 403 sans authentification Access", async () => {
    const d = fakeDeps({ isOwner: () => false });
    const r = await api("GET", "/api/admin/overview", undefined, d);
    expect(r.status).toBe(403);
    expect(await reply(r)).toEqual({ error: "forbidden" });
  });

  it("répond 403 avant toute autre réponse : ni route inconnue, ni écriture, ni lecture", async () => {
    const b = await request();
    const d = fakeDeps({ isOwner: () => false });
    const calls = [
      api("GET", "/api/admin/overview", undefined, d),
      api("GET", "/api/admin/inconnue", undefined, d),
      api("GET", `/api/admin/bookings?from=2026-12-01&to=2026-12-31`, undefined, d),
      api("GET", bookingPath(b.id), undefined, d),
      act(b.id, "validate", d),
      patch(b.id, { notes: "x" }, d),
      create({ kind: "blocked", date: "2027-01-05" }, d),
    ];
    for (const r of await Promise.all(calls)) expect(r.status).toBe(403);
    expect(await statusOf(b.id)).toBe("pending_review");
    expect(await listRange(env.DB, "2027-01-01", "2027-01-31")).toEqual([]);
  });

  it("le Worker réel refuse l'administration sans Access", async () => {
    const r = await exports.default.fetch(`${BASE}/api/admin/overview`);
    expect(r.status).toBe(403);
  });

  it("isOwner exige le bon public", () => {
    const d = makeDeps({ ...env, ACCESS_AUD: "aud" });
    expect(d.isOwner({ access: { aud: "aud" } } as any)).toBe(true);
    expect(d.isOwner({ access: { aud: "autre" } } as any)).toBe(false);
    expect(d.isOwner({} as any)).toBe(false);
  });

  it("isOwner refuse tout le monde tant que le public attendu n'est pas configuré", () => {
    for (const aud of ["", undefined]) {
      const d = makeDeps({ ...env, ACCESS_AUD: aud as string });
      expect(d.isOwner({ access: { aud: "" } } as any)).toBe(false);
      expect(d.isOwner({ access: { aud: undefined } } as any)).toBe(false);
      expect(d.isOwner({} as any)).toBe(false);
    }
  });

  it("répond 404 en JSON sur une route inconnue et 405 sur une méthode inconnue, sans mise en cache", async () => {
    const unknown = await api("GET", "/api/admin/inconnue");
    expect(unknown.status).toBe(404);
    expect(await reply(unknown)).toEqual({ error: "not_found" });

    const wrong = await api("DELETE", "/api/admin/overview");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("GET");
    expect(await reply(wrong)).toEqual({ error: "method_not_allowed" });

    const b = await request();
    const wrongAction = await api("GET", bookingPath(b.id, "validate"));
    expect(wrongAction.status).toBe(405);
    expect(wrongAction.headers.get("Allow")).toBe("POST");

    const unknownAction = await act(b.id, "supprimer");
    expect(unknownAction.status).toBe(404);

    for (const r of [unknown, wrong, wrongAction, unknownAction]) expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("ne garde aucune réponse en cache", async () => {
    const b = await request();
    const replies = [
      await api("GET", "/api/admin/overview"),
      await api("GET", bookingPath(b.id)),
      await act(b.id, "validate"),
      await act(b.id, "validate"),
      await api("GET", bookingPath("inconnue")),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 409, 404]);
    for (const r of replies) {
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("Content-Type")).toContain("application/json");
    }
  });
});

describe("écritures : origine et type de contenu", () => {
  let b: Booking;
  beforeEach(async () => {
    b = await request();
  });

  const writes = (origin: string | null, headers: Record<string, string> = {}) => [
    api("POST", bookingPath(b.id, "refuse"), {}, deps, origin, headers),
    api("PATCH", bookingPath(b.id), { notes: "pirate" }, deps, origin, headers),
    api("POST", "/api/admin/bookings", { kind: "blocked", date: "2027-01-05" }, deps, origin, headers),
  ];

  const untouched = async () => {
    expect((await getBooking(env.DB, b.id))!).toMatchObject({ status: "pending_review", notes: b.notes });
    expect(await listRange(env.DB, "2027-01-01", "2027-01-31")).toEqual([]);
  };

  it("refuse une modification venant d'une autre origine", async () => {
    expect((await api("POST", `/api/admin/bookings/${b.id}/refuse`, {}, deps, "https://ailleurs.test")).status).toBe(403);
    for (const r of await Promise.all(writes("https://ailleurs.test"))) expect(r.status).toBe(403);
    await untouched();
  });

  it("refuse une modification sans en-tête Origin", async () => {
    for (const r of await Promise.all(writes(null))) {
      expect(r.status).toBe(403);
      expect(await reply(r)).toEqual({ error: "forbidden" });
    }
    await untouched();
  });

  it("refuse l'origine « null » et une origine qui ne fait que ressembler à celle du site", async () => {
    for (const origin of ["null", "https://brotobooth.fr.ailleurs.test", "http://brotobooth.fr"]) {
      expect((await api("POST", bookingPath(b.id, "refuse"), {}, deps, origin)).status, origin).toBe(403);
    }
  });

  it("refuse un corps qui n'est pas déclaré en JSON", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      for (const r of await Promise.all(writes(BASE, { "Content-Type": type }))) {
        expect(r.status).toBe(415);
        expect(await reply(r)).toEqual({ error: "unsupported_media_type" });
      }
    }
    const withoutType = await api("POST", bookingPath(b.id, "refuse"));
    expect(withoutType.status).toBe(415);
    await untouched();
  });

  it("accepte le type JSON avec un jeu de caractères", async () => {
    const r = await api("POST", bookingPath(b.id, "refuse"), {}, deps, BASE, { "Content-Type": "application/json; charset=utf-8" });
    expect(r.status).toBe(200);
  });

  it("ne demande ni origine ni type de contenu à une lecture", async () => {
    const r = await api("GET", "/api/admin/overview", undefined, deps, null);
    expect(r.status).toBe(200);
  });
});

describe("GET /api/admin/overview", () => {
  it("À traiter liste les demandes et les acomptes attendus, par échéance", async () => {
    const late = await insert(newBooking({ event_date: "2026-12-20", hold_until: "2026-11-10T12:00:00.000Z" }));
    const soon = await insert(
      newBooking({ event_date: "2026-12-21", status: "awaiting_deposit", hold_until: "2026-11-09T08:00:00.000Z" }),
    );
    await insert(newBooking({ event_date: "2026-12-22", status: "confirmed", hold_until: null }));
    await insert(newBooking({ event_date: "2026-12-23", status: "blocked", hold_until: null }));
    await insert(newBooking({ event_date: "2026-12-24", status: "refused", hold_until: null }));
    await insert(newBooking({ event_date: "2026-12-25", status: "cancelled", hold_until: null }));

    const r = await api("GET", "/api/admin/overview");
    expect(r.status).toBe(200);
    const { todo } = await reply(r);
    expect(todo!.map((b) => b.id)).toEqual([soon.booking.id, late.booking.id]);
    expect(todo![0]).toMatchObject({ status: "awaiting_deposit", client_name: "Camille Martin", hold_until: "2026-11-09T08:00:00.000Z" });
  });

  it("la santé est vide tant que la tâche n'a pas tourné", async () => {
    expect((await reply(await api("GET", "/api/admin/overview"))).health).toEqual({
      lastCronRun: null,
      failedNotifications: 0,
    });
  });

  it("la santé donne le dernier passage et les envois en échec", async () => {
    await setState(env.DB, "last_cron_run", "2026-11-07T09:55:00.000Z");
    const keys = ["deux", "trois", "quatre", "fait", "annule", "en-cours"];
    await enqueue(env.DB, keys.map((key) => spec(key)));
    const tries: Record<string, number> = { deux: 2, trois: 3, quatre: 4, fait: 3, annule: 3, "en-cours": 2 };
    for (const [key, times] of Object.entries(tries)) {
      for (let i = 0; i < times; i++) await failOnce(key);
    }
    await env.DB.prepare("UPDATE notifications SET sent_at = ? WHERE dedupe_key = 'fait'").bind(T0).run();
    await env.DB.prepare("UPDATE notifications SET cancelled_at = ? WHERE dedupe_key = 'annule'").bind(T0).run();
    // La troisième tentative de « en-cours » est partie et n'est pas revenue : elle n'est pas encore un échec.
    const inFlight = await env.DB.prepare("SELECT id FROM notifications WHERE dedupe_key = 'en-cours'").first<{ id: number }>();
    expect(await claimNotification(env.DB, inFlight!.id, T0, LEASE_END)).toBe(3);

    expect((await reply(await api("GET", "/api/admin/overview"))).health).toEqual({
      lastCronRun: "2026-11-07T09:55:00.000Z",
      failedNotifications: 2,
    });

    // Sa réservation échue sans réponse, l'envoi redevient un échec à compter.
    deps.setNow("2026-11-07T10:03:00.000Z");
    expect((await reply(await api("GET", "/api/admin/overview"))).health!.failedNotifications).toBe(3);
  });
});

describe("GET /api/admin/bookings", () => {
  it("donne les réservations de la période, par date, quel que soit leur état", async () => {
    await insert(newBooking({ event_date: "2026-11-30", status: "confirmed", hold_until: null }));
    const dec2 = await insert(newBooking({ event_date: "2026-12-02", status: "confirmed", hold_until: null }));
    const dec1 = await insert(newBooking({ event_date: "2026-12-01" }));
    const dec31 = await insert(newBooking({ event_date: "2026-12-31", status: "blocked", hold_until: null }));
    const dec15 = await insert(newBooking({ event_date: "2026-12-15", status: "refused", hold_until: null }));
    await insert(newBooking({ event_date: "2027-01-01" }));

    const r = await api("GET", "/api/admin/bookings?from=2026-12-01&to=2026-12-31");
    expect(r.status).toBe(200);
    expect((await reply(r)).bookings!.map((b) => b.id)).toEqual([
      dec1.booking.id,
      dec2.booking.id,
      dec15.booking.id,
      dec31.booking.id,
    ]);
  });

  it("répond 400 à une période absente, invalide, inversée ou trop longue", async () => {
    for (const query of [
      "",
      "?from=2026-12-01",
      "?to=2026-12-31",
      "?from=demain&to=2026-12-31",
      "?from=2026-02-30&to=2026-03-31",
      "?from=2026-12-31&to=2026-12-01",
      "?from=2026-01-01&to=2028-01-01",
    ]) {
      const r = await api("GET", `/api/admin/bookings${query}`);
      expect(r.status, query).toBe(400);
      expect(await reply(r)).toEqual({ error: "invalid_range" });
    }
  });
});

describe("GET /api/admin/bookings/:id", () => {
  it("donne la réservation et son historique, qui commence par la demande reçue", async () => {
    const b = await request();
    const r = await api("GET", bookingPath(b.id));
    expect(r.status).toBe(200);
    expect(await reply(r)).toEqual({
      booking: b,
      history: [{ at: T0, actor: "client", event: "received" }],
    });
  });

  it("une réservation du propriétaire a été reçue par le propriétaire", async () => {
    const created = (await reply(await create({ kind: "manual", date: "2026-12-19", name: "Camille" }))).booking!;
    expect((await reply(await api("GET", bookingPath(created.id)))).history).toEqual([
      { at: T0, actor: "owner", event: "received" },
    ]);
  });

  it("donne l'historique de chaque changement", async () => {
    const b = await request();
    expect((await act(b.id, "validate")).status).toBe(200);
    deps.setNow("2026-11-08T09:30:00.000Z");
    await confirmDeposit(deps, b.id, "stripe");
    deps.setNow("2026-11-09T08:00:00.000Z");
    expect((await act(b.id, "balance-paid")).status).toBe(200);

    const { history } = await reply(await api("GET", bookingPath(b.id)));
    expect(history).toEqual([
      { at: T0, actor: "client", event: "received" },
      { at: T0, actor: "owner", event: "validated", detail: null },
      { at: "2026-11-08T09:30:00.000Z", actor: "stripe", event: "paid", detail: null },
      { at: "2026-11-09T08:00:00.000Z", actor: "owner", event: "balance_paid", detail: null },
    ]);
  });

  it("répond 404 pour une réservation inconnue", async () => {
    const r = await api("GET", bookingPath("inconnue"));
    expect(r.status).toBe(404);
    expect(await reply(r)).toEqual({ error: "not_found" });
  });
});

describe("POST /api/admin/bookings/:id/:action", () => {
  it("valide : la date est tenue 72 h et le client reçoit son lien de paiement tout de suite", async () => {
    const b = await request();
    const r = await act(b.id, "validate");
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ id: b.id, status: "awaiting_deposit", hold_until: "2026-11-10T10:00:00.000Z" });
    expect(deps.emails.some((e) => e.to === b.client_email && e.text.includes(`/acompte/${b.token}`))).toBe(true);
  });

  it("refuse : la date est libérée et le client est prévenu", async () => {
    const b = await request();
    const r = await act(b.id, "refuse");
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ status: "refused", hold_until: null });
    const sent = (await notificationRows()).filter((n) => n.booking_id === b.id && n.sent_at !== null);
    expect(sent.map((n) => n.template)).toContain("client_refused");
    expect((await getHistory(env.DB, b.id)).map((h) => [h.actor, h.event])).toEqual([["owner", "refused"]]);
  });

  it("annule une prestation confirmée : la date est libérée et le client est prévenu", async () => {
    const v = await validatedBooking(deps);
    await confirmDeposit(deps, v.id, "stripe");
    const r = await act(v.id, "cancel");
    expect(r.status).toBe(200);
    expect((await reply(r)).booking!.status).toBe("cancelled");
    const sent = (await notificationRows()).filter((n) => n.booking_id === v.id && n.sent_at !== null);
    expect(sent.map((n) => n.template)).toContain("client_cancelled");
    expect(await listRange(env.DB, v.event_date, v.event_date)).toMatchObject([{ status: "cancelled" }]);
  });

  it("marque le solde réglé sur une prestation confirmée", async () => {
    const v = await validatedBooking(deps);
    await confirmDeposit(deps, v.id, "stripe");
    deps.setNow("2026-11-20T08:00:00.000Z");
    const r = await act(v.id, "balance-paid");
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ status: "confirmed", balance_paid_at: "2026-11-20T08:00:00.000Z" });
    expect((await getBooking(env.DB, v.id))!.balance_paid_at).toBe("2026-11-20T08:00:00.000Z");
  });

  it("renvoie le lien de paiement sans prolonger l'échéance", async () => {
    const v = await validatedBooking(deps);
    await processDue(deps);
    const linksBefore = deps.emails.filter((e) => e.text.includes(`/acompte/${v.token}`)).length;
    expect(linksBefore).toBeGreaterThan(0);

    deps.setNow("2026-11-08T10:00:00.000Z");
    const r = await act(v.id, "resend-link");
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ status: "awaiting_deposit", hold_until: v.hold_until });
    expect(deps.emails.filter((e) => e.text.includes(`/acompte/${v.token}`))).toHaveLength(linksBefore + 1);
  });

  it("répond 409 sur une action périmée", async () => {
    const b = await request();
    expect((await act(b.id, "validate")).status).toBe(200);
    const again = await act(b.id, "validate");
    expect(again.status).toBe(409);
    expect(await reply(again)).toEqual({ error: "stale" });
    expect((await getHistory(env.DB, b.id)).map((h) => h.event)).toEqual(["validated"]);

    // Une action que l'état de la réservation n'autorise pas est périmée aussi.
    const pending = await request({ event_date: "2026-12-20" });
    for (const action of ["balance-paid", "resend-link", "cancel"]) {
      const r = await act(pending.id, action);
      expect(r.status, action).toBe(409);
      expect(await reply(r)).toEqual({ error: "stale" });
    }
    expect(await statusOf(pending.id)).toBe("pending_review");
  });

  it("répond 404 pour une réservation inconnue", async () => {
    for (const action of ["validate", "refuse", "cancel", "resend-link", "balance-paid"]) {
      const r = await act("inconnue", action);
      expect(r.status, action).toBe(404);
      expect(await reply(r)).toEqual({ error: "not_found" });
    }
  });

  it("envoie sans attendre la tâche automatique ce que chaque action met en file", async () => {
    const actions: [string, () => Promise<Response>][] = [
      ["valider", async () => act((await request({ event_date: "2026-12-01" })).id, "validate")],
      ["refuser", async () => act((await request({ event_date: "2026-12-02" })).id, "refuse")],
      ["annuler", async () => act((await validatedBooking(deps, { event_date: "2026-12-03" })).id, "cancel")],
      ["renvoyer le lien", async () => act((await validatedBooking(deps, { event_date: "2026-12-04" })).id, "resend-link")],
      ["ajuster le prix", async () => patch((await request({ event_date: "2026-12-05" })).id, { price_cents: 90_000 })],
      ["ajouter une réservation", async () => create({ kind: "manual", date: "2026-12-06", name: "Camille" })],
    ];
    for (const [i, [name, run]] of actions.entries()) {
      // Une demande d'une autre date, dont les messages sont dus et ne sont partis nulle part : seul l'envoi immédiat les lit.
      const waiting = await request({ event_date: `2027-02-0${i + 1}` });
      expect((await run()).status, name).toBeLessThan(300);
      const due = (await notificationRows()).filter((n) => n.booking_id === waiting.id && n.due_at <= T0);
      expect(due.length, name).toBeGreaterThan(0);
      expect(due.every((n) => n.sent_at !== null), name).toBe(true);
    }
  });
});

describe("POST /api/admin/bookings : réservation manuelle", () => {
  const manual = {
    kind: "manual",
    date: "2026-12-19",
    name: "Camille Martin",
    phone: "06 12 34 56 78",
    email: "camille@example.test",
    event_type: "Mariage",
    venue: "Domaine des Pins, Lyon",
    event_hours: "18h-02h",
    price_cents: 120_000,
    deposit_cents: 30_000,
    notes: "Appel du 3 novembre",
  };

  it("ajoute une réservation manuelle, confirmée et sans paiement en ligne", async () => {
    const r = await create(manual);
    expect(r.status).toBe(201);
    const { booking } = await reply(r);
    expect(booking).toMatchObject({
      status: "confirmed",
      source: "manual",
      event_date: "2026-12-19",
      client_name: "Camille Martin",
      client_phone: "06 12 34 56 78",
      client_email: "camille@example.test",
      event_type: "Mariage",
      venue: "Domaine des Pins, Lyon",
      event_hours: "18h-02h",
      price_cents: 120_000,
      deposit_cents: 30_000,
      notes: "Appel du 3 novembre",
      hold_until: null,
    });
    expect(await getBooking(env.DB, booking!.id)).toEqual(booking);
    const reminders = (await notificationRows()).filter((n) => n.booking_id === booking!.id).map((n) => n.template);
    expect(reminders).toContain("client_d7");
    expect(reminders).toContain("owner_d1");
  });

  it("ne demande que le nom et la date : sans e-mail, seul le propriétaire sera prévenu", async () => {
    const r = await create({ kind: "manual", date: "2026-12-19", name: "  Camille  " });
    expect(r.status).toBe(201);
    const { booking } = await reply(r);
    expect(booking).toMatchObject({
      status: "confirmed",
      client_name: "Camille",
      client_email: null,
      client_phone: null,
      venue: null,
      price_cents: 0,
      deposit_cents: 0,
      notes: null,
    });
    const templates = (await notificationRows()).filter((n) => n.booking_id === booking!.id).map((n) => n.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.filter((t) => t.startsWith("client_"))).toEqual([]);
  });

  it("traite un champ vide ou nul comme absent, et passe l'adresse en minuscules", async () => {
    const r = await create({
      kind: "manual", date: "2026-12-19", name: "Camille", email: "Camille@Example.TEST", phone: "", venue: null, notes: "",
    });
    expect((await reply(r)).booking).toMatchObject({ client_email: "camille@example.test", client_phone: null, venue: null, notes: null });
  });

  it("répond 409 si la date est prise, sans rien créer d'autre", async () => {
    const taken = await request({ event_date: "2026-12-19" });
    const r = await create(manual);
    expect(r.status).toBe(409);
    expect(await reply(r)).toEqual({ error: "date_taken" });
    expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toMatchObject([{ id: taken.id }]);
  });

  it("ne bloque pas une date au délai minimum : le propriétaire peut ajouter une prestation proche ou passée", async () => {
    for (const date of ["2026-11-09", "2026-10-01"]) {
      expect((await create({ kind: "manual", date, name: "Camille" })).status, date).toBe(201);
    }
  });

  it.each([
    ["sans nom", { name: undefined }, ["name"]],
    ["sans date", { date: undefined }, ["date"]],
    ["sans nom ni date", { name: "", date: "" }, ["date", "name"]],
    ["avec une date qui n'existe pas", { date: "2026-02-30" }, ["date"]],
    ["avec une date au mauvais format", { date: "19/12/2026" }, ["date"]],
    ["avec une date qui n'est pas un texte", { date: 20261219 }, ["date"]],
    ["avec un nom de 121 caractères", { name: "x".repeat(121) }, ["name"]],
    ["avec un nom qui n'est pas un texte", { name: 42 }, ["name"]],
    ["avec une adresse invalide", { email: "camille" }, ["email"]],
    ["avec un téléphone invalide", { phone: "appelez-moi" }, ["phone"]],
    ["avec un lieu de 301 caractères", { venue: "x".repeat(301) }, ["venue"]],
    ["avec des horaires de 61 caractères", { event_hours: "x".repeat(61) }, ["event_hours"]],
    ["avec des notes de 2001 caractères", { notes: "x".repeat(2001) }, ["notes"]],
    ["avec un type d'événement inconnu", { event_type: "Baptême" }, ["event_type"]],
    ["avec un champ inconnu", { eventType: "Mariage" }, ["eventType"]],
  ])("répond 422 %s", async (_name, change, fields) => {
    const r = await create({ ...manual, ...change });
    expect(r.status).toBe(422);
    expect(await reply(r)).toEqual({ error: "invalid", fields });
    expect(await listRange(env.DB, "2026-01-01", "2030-12-31")).toEqual([]);
  });

  it("accepte les limites de longueur", async () => {
    const r = await create({
      ...manual,
      name: "x".repeat(120),
      venue: "x".repeat(300),
      event_hours: "x".repeat(60),
      notes: "x".repeat(2000),
    });
    expect(r.status).toBe(201);
  });

  it("rejette un prix négatif ou non entier", async () => {
    for (const price_cents of [-1, 1.5, "1000", 10_000_001, Number.MAX_SAFE_INTEGER, true, [], {}]) {
      const r = await create({ ...manual, price_cents, deposit_cents: 0 });
      expect(r.status, JSON.stringify(price_cents)).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["price_cents"] });
    }
    expect(await listRange(env.DB, "2026-01-01", "2030-12-31")).toEqual([]);
  });

  it("rejette un acompte négatif, non entier, trop grand ou supérieur au prix", async () => {
    for (const deposit_cents of [-1, 0.5, "300", 10_000_001, 120_001]) {
      const r = await create({ ...manual, deposit_cents });
      expect(r.status, JSON.stringify(deposit_cents)).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["deposit_cents"] });
    }
    // Sans prix, aucun acompte n'est possible.
    const noPrice = await create({ kind: "manual", date: "2026-12-19", name: "Camille", deposit_cents: 100 });
    expect(await reply(noPrice)).toEqual({ error: "invalid", fields: ["deposit_cents"] });
  });

  it("accepte les montants limites", async () => {
    expect((await create({ ...manual, price_cents: 10_000_000, deposit_cents: 10_000_000 })).status).toBe(201);
    expect((await create({ ...manual, date: "2026-12-20", price_cents: 0, deposit_cents: 0 })).status).toBe(201);
    expect((await create({ ...manual, date: "2026-12-21", price_cents: 100, deposit_cents: 100 })).status).toBe(201);
  });
});

describe("POST /api/admin/bookings : date bloquée", () => {
  it("bloque une date", async () => {
    const r = await create({ kind: "blocked", date: "2027-01-05", notes: "Congés" });
    expect(r.status).toBe(201);
    expect((await reply(r)).booking).toMatchObject({
      status: "blocked",
      source: "manual",
      event_date: "2027-01-05",
      notes: "Congés",
      client_name: null,
      price_cents: null,
    });
    const availability = await api("GET", "/api/availability?from=2027-01-01&to=2027-01-31");
    expect((await availability.json<{ unavailable: string[] }>()).unavailable).toEqual(["2027-01-05"]);
  });

  it("garde la date sans note, et ne prévient personne", async () => {
    const r = await create({ kind: "blocked", date: "2027-01-05" });
    expect((await reply(r)).booking).toMatchObject({ status: "blocked", notes: null });
    expect(await notificationRows()).toEqual([]);
    expect(deps.emails).toEqual([]);
    expect(deps.telegrams).toEqual([]);
  });

  it("répond 409 si la date est prise", async () => {
    await request({ event_date: "2027-01-05" });
    const r = await create({ kind: "blocked", date: "2027-01-05" });
    expect(r.status).toBe(409);
    expect(await reply(r)).toEqual({ error: "date_taken" });
  });

  it("se retire en l'annulant, ce qui libère la date sans prévenir personne", async () => {
    const { booking } = await reply(await create({ kind: "blocked", date: "2027-01-05" }));
    expect((await act(booking!.id, "cancel")).status).toBe(200);
    expect(await statusOf(booking!.id)).toBe("cancelled");
    expect((await create({ kind: "blocked", date: "2027-01-05" })).status).toBe(201);
    expect(await notificationRows()).toEqual([]);
  });

  it.each([
    ["sans date", { kind: "blocked" }, ["date"]],
    ["avec une date qui n'existe pas", { kind: "blocked", date: "2027-02-30" }, ["date"]],
    ["avec des notes de 2001 caractères", { kind: "blocked", date: "2027-01-05", notes: "x".repeat(2001) }, ["notes"]],
    ["avec des champs de réservation", { kind: "blocked", date: "2027-01-05", name: "Camille" }, ["name"]],
  ])("répond 422 %s", async (_name, body, fields) => {
    const r = await create(body);
    expect(r.status).toBe(422);
    expect(await reply(r)).toEqual({ error: "invalid", fields });
  });
});

describe("POST /api/admin/bookings : corps", () => {
  it("répond 422 à un genre inconnu ou absent", async () => {
    for (const body of [{ date: "2027-01-05" }, { kind: "autre", date: "2027-01-05" }, { kind: 1 }]) {
      const r = await create(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect((await reply(r)).fields).toContain("kind");
    }
  });

  it("répond 422 à un corps qui n'est pas un objet", async () => {
    for (const body of [[], "texte", 42, null]) {
      const r = await create(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(await reply(r)).toMatchObject({ error: "invalid" });
    }
  });

  it("répond 400 à un JSON illisible et 413 à un corps trop gros", async () => {
    const broken = await api("POST", "/api/admin/bookings", undefined, deps, BASE, { "Content-Type": "application/json" });
    expect(broken.status).toBe(400);
    expect(await reply(broken)).toEqual({ error: "invalid_json" });

    const huge = await create({ kind: "blocked", date: "2027-01-05", notes: "x".repeat(20_000) });
    expect(huge.status).toBe(413);
    expect(await reply(huge)).toEqual({ error: "too_large" });
  });
});

describe("PATCH /api/admin/bookings/:id", () => {
  it("ajuste le prix, et l'acompte suit le pourcentage de l'offre", async () => {
    const v = await validatedBooking(deps);
    const r = await patch(v.id, { price_cents: 200_000 });
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ status: "awaiting_deposit", price_cents: 200_000, deposit_cents: 60_000 });
    expect(await getHistory(env.DB, v.id)).toMatchObject([{ event: "validated" }, { actor: "owner", event: "price_adjusted" }]);
  });

  it("fixe le prix et l'acompte à la main", async () => {
    const b = await request();
    const r = await patch(b.id, { price_cents: 100_000, deposit_cents: 20_000 });
    expect((await reply(r)).booking).toMatchObject({ status: "pending_review", price_cents: 100_000, deposit_cents: 20_000 });
  });

  it("ne change que l'acompte si le prix n'est pas donné, sans jamais le laisser dépasser le prix", async () => {
    const b = await request({ price_cents: 150_000, deposit_cents: 45_000 });
    const r = await patch(b.id, { deposit_cents: 10_000 });
    expect((await reply(r)).booking).toMatchObject({ price_cents: 150_000, deposit_cents: 10_000 });

    const over = await patch(b.id, { deposit_cents: 150_001 });
    expect(over.status).toBe(422);
    expect(await reply(over)).toEqual({ error: "invalid", fields: ["deposit_cents"] });
    expect(await getBooking(env.DB, b.id)).toMatchObject({ price_cents: 150_000, deposit_cents: 10_000 });
  });

  it("accepte les montants limites", async () => {
    const b = await request();
    expect((await patch(b.id, { price_cents: 10_000_000, deposit_cents: 10_000_000 })).status).toBe(200);
    expect((await patch(b.id, { price_cents: 0, deposit_cents: 0 })).status).toBe(200);
    expect(await getBooking(env.DB, b.id)).toMatchObject({ price_cents: 0, deposit_cents: 0 });
  });

  it("rejette un prix négatif ou non entier", async () => {
    const b = await request();
    for (const price_cents of [-1, -0.5, 1.5, "1000", 10_000_001, false, [], {}]) {
      const r = await patch(b.id, { price_cents });
      expect(r.status, JSON.stringify(price_cents)).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["price_cents"] });
    }
    expect(await getBooking(env.DB, b.id)).toMatchObject({ price_cents: b.price_cents, deposit_cents: b.deposit_cents });
    expect((await getHistory(env.DB, b.id)).map((h) => h.event)).toEqual([]);
  });

  it("rejette un acompte négatif, non entier ou supérieur au nouveau prix", async () => {
    const b = await request();
    for (const body of [
      { deposit_cents: -1 },
      { deposit_cents: 0.5 },
      { price_cents: 10_000, deposit_cents: 10_001 },
      { price_cents: 0, deposit_cents: 1 },
    ]) {
      const r = await patch(b.id, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["deposit_cents"] });
    }
    expect(await getBooking(env.DB, b.id)).toMatchObject({ price_cents: b.price_cents, deposit_cents: b.deposit_cents });
  });

  it("ferme la session Stripe ouverte : le client paiera le nouveau montant par le même lien", async () => {
    const v = await validatedWithSession();
    const r = await patch(v.id, { price_cents: 100_000 });
    expect(r.status).toBe(200);
    expect((await reply(r)).booking).toMatchObject({ price_cents: 100_000, deposit_cents: 30_000, stripe_session: null });
    expect(deps.stripe.sessions.get("cs_1")!.status).toBe("expired");
  });

  it("répond 503 si le paiement ne répond pas, et ne touche pas à la réservation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const v = await validatedWithSession();
      deps.stripe.failNext("retrieveSession");
      const r = await patch(v.id, { price_cents: 100_000, notes: "Nouveau prix convenu" });
      expect(r.status).toBe(503);
      expect(await reply(r)).toEqual({ error: "payment_unavailable" });
      expect(await getBooking(env.DB, v.id)).toEqual(v);
      expect(deps.stripe.sessions.get("cs_1")!.status).toBe("open");
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0].map(String).join(" ")).not.toContain("Camille");
    } finally {
      log.mockRestore();
    }
  });

  it("répond 409 une fois l'acompte payé : le prix ne se règle plus", async () => {
    const v = await validatedBooking(deps);
    await confirmDeposit(deps, v.id, "stripe");
    const r = await patch(v.id, { price_cents: 100_000, notes: "Trop tard" });
    expect(r.status).toBe(409);
    expect(await reply(r)).toEqual({ error: "stale" });
    expect(await getBooking(env.DB, v.id)).toMatchObject({ price_cents: v.price_cents, notes: v.notes });
  });

  it("répond 404 pour une réservation inconnue", async () => {
    const r = await patch("inconnue", { notes: "x" });
    expect(r.status).toBe(404);
    expect(await reply(r)).toEqual({ error: "not_found" });
  });

  describe("notes", () => {
    it("remplace les notes, à tout moment, et l'historique s'en souvient", async () => {
      const v = await validatedBooking(deps);
      await confirmDeposit(deps, v.id, "stripe");
      deps.setNow("2026-11-09T08:00:00.000Z");
      const r = await patch(v.id, { notes: "  Arrivée à 17 h  " });
      expect(r.status).toBe(200);
      expect((await reply(r)).booking).toMatchObject({ status: "confirmed", notes: "Arrivée à 17 h", price_cents: v.price_cents });
      expect((await getHistory(env.DB, v.id)).at(-1)).toMatchObject({
        at: "2026-11-09T08:00:00.000Z",
        actor: "owner",
        event: "notes_updated",
      });
    });

    it("efface les notes avec une valeur nulle ou vide", async () => {
      const b = await request({ notes: "À effacer" });
      expect((await reply(await patch(b.id, { notes: null }))).booking!.notes).toBeNull();
      await patchBooking(env.DB, b.id, { notes: "À effacer" }, "owner", "notes_updated", T0);
      expect((await reply(await patch(b.id, { notes: "   " }))).booking!.notes).toBeNull();
    });

    it("règle le prix et les notes ensemble", async () => {
      const b = await request();
      const r = await patch(b.id, { price_cents: 80_000, notes: "Tarif association" });
      expect((await reply(r)).booking).toMatchObject({ price_cents: 80_000, deposit_cents: 24_000, notes: "Tarif association" });
    });

    it("refuse des notes sur une réservation déjà anonymisée : ses données ne reviennent pas", async () => {
      const { booking } = await insert(
        newBooking({
          status: "refused",
          hold_until: null,
          anonymized_at: T0,
          client_name: null,
          client_email: null,
          client_phone: null,
          venue: null,
          event_hours: null,
          message: null,
          ip_hash: null,
          notes: null,
        }),
      );
      const r = await patch(booking.id, { notes: "Un nom, un numéro" });
      expect(r.status).toBe(409);
      expect(await reply(r)).toEqual({ error: "stale" });
      expect((await getBooking(env.DB, booking.id))!.notes).toBeNull();
    });

    it("rejette des notes de plus de 2000 caractères", async () => {
      const b = await request();
      const r = await patch(b.id, { notes: "x".repeat(2001) });
      expect(r.status).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["notes"] });
      expect((await patch(b.id, { notes: "x".repeat(2000) })).status).toBe(200);
    });
  });

  describe("corps", () => {
    it("répond 422 quand il n'y a rien à changer", async () => {
      const b = await request();
      for (const body of [{}, { price_cents: null }, [], "texte", null]) {
        const r = await patch(b.id, body);
        expect(r.status, JSON.stringify(body)).toBe(422);
        expect(await reply(r)).toEqual({ error: "invalid", fields: ["body"] });
      }
    });

    it("nomme les champs inconnus au lieu de les ignorer, sans rien modifier", async () => {
      const b = await request();
      const r = await patch(b.id, { price: 5, notes: "x", status: "confirmed" });
      expect(r.status).toBe(422);
      expect(await reply(r)).toEqual({ error: "invalid", fields: ["price", "status"] });
      expect(await getBooking(env.DB, b.id)).toMatchObject({ status: "pending_review", notes: b.notes });
    });

    it("répond 400 à un JSON illisible", async () => {
      const b = await request();
      const r = await api("PATCH", bookingPath(b.id), undefined, deps, BASE, { "Content-Type": "application/json" });
      expect(r.status).toBe(400);
      expect(await reply(r)).toEqual({ error: "invalid_json" });
    });
  });
});

describe("panne imprévue", () => {
  it("répond 500 server_error, sans donnée personnelle dans le journal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = fakeDeps({
        env: {
          DB: {
            prepare: () => {
              throw new Error("D1 cassée");
            },
          },
        } as any,
      });
      const r = await api("GET", "/api/admin/overview", undefined, broken);
      expect(r.status).toBe(500);
      expect(await reply(r)).toEqual({ error: "server_error" });
      expect(log).toHaveBeenCalledOnce();
      const logged = log.mock.calls[0].map(String).join(" ");
      expect(logged).toContain("D1 cassée");
      expect(logged).toContain("GET /api/admin");
    } finally {
      log.mockRestore();
    }
  });

  it("une panne de D1 pendant un ajustement du prix reste une 500, pas une panne du paiement", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const b = await request();
      const prepare = env.DB.prepare.bind(env.DB);
      const failing = fakeDeps({
        env: {
          DB: {
            prepare: (sql: string) => {
              if (/^\s*UPDATE bookings/.test(sql)) throw new Error("D1 cassée");
              return prepare(sql);
            },
            batch: (...args: Parameters<D1Database["batch"]>) => env.DB.batch(...args),
          },
        } as any,
      });
      const r = await patch(b.id, { price_cents: 90_000 }, failing);
      expect(r.status).toBe(500);
    } finally {
      log.mockRestore();
    }
  });
});
