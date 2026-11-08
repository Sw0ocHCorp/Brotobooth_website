import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { enqueueWeeklyDigest, releaseDueHolds, runCron } from "../../worker/cron";
import worker from "../../worker/index";
import { attachSession } from "../../worker/operations";
import {
  getBooking,
  getHistory,
  getState,
  listDueNotifications,
  listUnavailableDates,
  patchBooking,
  type Booking,
  type NewBooking,
} from "../../worker/repository";
import { T0, fakeDeps, insert, newBooking, request, resetDb, strictStripe, validatedBooking, type FakeDeps } from "../support";

const DEADLINE = "2026-11-10T10:00:00.000Z";
/** Lundi 9 h à Paris, un an et un jour après `T0` : de quoi libérer, annoncer le point et anonymiser dans un même passage. */
const MONDAY_9H = "2027-11-08T08:00:00.000Z";
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

let deps: FakeDeps;
let logged: MockInstance<Console["error"]>;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
  strictStripe(deps);
  // Les pannes que les tests provoquent sont consignées : on les capte pour garder la sortie nette.
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

/** Une session de paiement de 30 minutes ouverte pour `b` à l'heure de `deps`. */
const openSession = (b: Booking) =>
  deps.stripe.createSession({
    bookingId: b.id,
    token: b.token,
    email: b.client_email,
    amountCents: b.deposit_cents!,
    label: "Acompte",
    expiresAt: Math.floor(deps.now().getTime() / 1000) + 1800,
  });

/** Une réservation validée dont le client a ouvert sa session de paiement : la date est tenue 72 h. */
async function validatedWithSession(over: Partial<NewBooking> = {}): Promise<Booking> {
  const v = await validatedBooking(deps, over);
  const attached = await attachSession(deps, v.id, await openSession(v));
  if (!attached.ok) throw new Error(`attachSession : ${attached.reason}`);
  return attached.booking;
}

/** L'instant où la date cesse d'être tenue. */
const afterHold = (b: Booking): string => b.hold_until!;

const current = async (b: Booking) => (await getBooking(env.DB, b.id))!;
const lastEvent = async (b: Booking) => (await getHistory(env.DB, b.id)).at(-1);
const queued = async (template: string) =>
  (await listDueNotifications(env.DB, FAR_FUTURE, 100)).filter((n) => n.template === template);
const digests = () => queued("owner_digest");

/** La base, sauf pour les requêtes qui correspondent à `pattern` : elles lèvent, comme une panne de D1. */
const brokenFor = (pattern: RegExp): D1Database =>
  ({
    prepare: (sql: string) => {
      if (pattern.test(sql)) throw new Error("D1 indisponible");
      return env.DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  }) as unknown as D1Database;

describe("releaseDueHolds", () => {
  it("libère une demande sans réponse après 72 h", async () => {
    const b = await request();
    deps.setNow(DEADLINE);
    await releaseDueHolds(deps);
    expect((await current(b)).status).toBe("expired");
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual([]);
    expect(await lastEvent(b)).toMatchObject({ actor: "system", event: "released" });
    expect((await queued("client_released")).length).toBe(1);
    expect((await queued("owner_released")).map((n) => n.channel).sort()).toEqual(["email", "telegram"]);
  });

  it("ne libère pas avant l'échéance", async () => {
    const b = await request();
    deps.setNow("2026-11-10T09:59:00.000Z");
    await releaseDueHolds(deps);
    expect((await current(b)).status).toBe("pending_review");
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual(["2026-12-19"]);
  });

  it("libère plusieurs demandes échues dans un même passage", async () => {
    const a = await request({ event_date: "2026-12-19" });
    const b = await request({ event_date: "2026-12-26" });
    deps.setNow(DEADLINE);
    await releaseDueHolds(deps);
    expect([(await current(a)).status, (await current(b)).status]).toEqual(["expired", "expired"]);
  });

  it("confirme au lieu de libérer si Stripe dit que c'est payé", async () => {
    const v = await validatedWithSession();
    deps.stripe.completeSession(v.stripe_session!);
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    const b = await current(v);
    expect(b.status).toBe("confirmed");
    expect(b.deposit_paid_at).toBe(DEADLINE);
    expect(await lastEvent(v)).toMatchObject({ actor: "stripe", event: "paid" });
    expect((await queued("client_confirmed")).length).toBe(1);
    expect(await queued("owner_released")).toEqual([]);
    expect(await queued("owner_late_payment")).toEqual([]);
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual(["2026-12-19"]);
  });

  it("expire une session encore ouverte avant de libérer", async () => {
    const v = await validatedWithSession();
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect(deps.stripe.sessions.get(v.stripe_session!)!.status).toBe("expired");
    expect((await current(v)).status).toBe("expired");
  });

  it("libère sans la fermer une seconde fois une session que Stripe a déjà fermée", async () => {
    const v = await validatedWithSession();
    await deps.stripe.expireSession(v.stripe_session!);
    const expire = vi.spyOn(deps.stripe, "expireSession");
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("expired");
    expect(expire).not.toHaveBeenCalled();
  });

  it("si le client paie pendant la fermeture de sa session, il est confirmé", async () => {
    const v = await validatedWithSession();
    const expire = deps.stripe.expireSession;
    deps.stripe.expireSession = async (id) => {
      deps.stripe.completeSession(id); // le paiement aboutit à l'instant où la tâche ferme la session
      return expire(id); // Stripe refuse : la session n'est plus ouverte
    };
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("confirmed");
    expect(await lastEvent(v)).toMatchObject({ actor: "stripe", event: "paid" });
    expect(await queued("owner_released")).toEqual([]);
    expect(await queued("owner_late_payment")).toEqual([]);
  });

  it("si la session ne se ferme pas et reste ouverte, la date reste tenue jusqu'au prochain passage", async () => {
    const v = await validatedWithSession();
    deps.stripe.failNext("expireSession");
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("awaiting_deposit");
    expect(deps.stripe.sessions.get(v.stripe_session!)!.status).toBe("open");

    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("expired");
    expect(deps.stripe.sessions.get(v.stripe_session!)!.status).toBe("expired");
  });

  it("si Stripe ne répond pas, la date reste tenue jusqu'au prochain passage, et les autres sont traitées", async () => {
    const v = await validatedWithSession({ event_date: "2026-12-19" });
    const p = await request({ event_date: "2026-12-26" });
    deps.stripe.failNext("retrieveSession");
    deps.setNow(DEADLINE);
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("awaiting_deposit");
    expect((await current(v)).stripe_session).toBe(v.stripe_session);
    expect((await current(p)).status).toBe("expired");

    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("expired");
  });

  it("ne consigne que l'identifiant de la réservation et le nom de l'erreur", async () => {
    const v = await validatedWithSession();
    deps.stripe.retrieveSession = async () => {
      throw new Error("indisponible pour camille@example.test");
    };
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]);
    expect(line).toContain(v.id);
    expect(line).toContain("Error");
    expect(line).not.toContain("camille");
    expect(line).not.toContain("indisponible");
  });

  it("libère sans appeler Stripe une réservation en attente d'acompte qui n'a pas de session", async () => {
    const v = await validatedBooking(deps);
    expect(v.stripe_session).toBeNull();
    const retrieve = vi.spyOn(deps.stripe, "retrieveSession");
    const expire = vi.spyOn(deps.stripe, "expireSession");
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("expired");
    expect(retrieve).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("si le client ouvre une nouvelle session pendant la fermeture de la première, la date reste tenue", async () => {
    const v = await validatedWithSession();
    const expire = deps.stripe.expireSession;
    let reopened = "";
    deps.stripe.expireSession = async (id) => {
      await expire(id);
      // Sa requête, partie avant l'échéance, aboutit pendant que la tâche ferme la première session.
      const session = await openSession(v);
      reopened = session.id;
      expect((await attachSession(deps, v.id, session)).ok).toBe(true);
    };
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);

    const kept = await current(v);
    expect(kept.status).toBe("awaiting_deposit");
    expect(kept.stripe_session).toBe(reopened);
    expect(kept.hold_until).toBe("2026-11-10T10:35:00.000Z");
    expect(deps.stripe.sessions.get(reopened)!.status).toBe("open");
    expect(await queued("owner_released")).toEqual([]);

    // Il paie avec la nouvelle session : la date lui appartenait toujours.
    deps.stripe.completeSession(reopened);
    deps.setNow(kept.hold_until!);
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("confirmed");
  });

  it("si l'échéance recule pendant la fermeture de la session, la date reste tenue", async () => {
    const v = await validatedWithSession();
    const expire = deps.stripe.expireSession;
    deps.stripe.expireSession = async (id) => {
      await expire(id);
      await patchBooking(env.DB, v.id, { hold_until: "2026-11-10T11:00:00.000Z" }, "owner", "hold_extended", deps.now().toISOString());
    };
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("awaiting_deposit");
  });

  it("si la session est retirée pendant la fermeture sans que l'échéance recule, la réservation attend le passage suivant", async () => {
    const v = await validatedWithSession();
    const expire = deps.stripe.expireSession;
    deps.stripe.expireSession = async (id) => {
      await expire(id);
      // Le propriétaire ajuste le prix à cet instant : la session est oubliée, l'échéance ne bouge pas.
      await patchBooking(
        env.DB,
        v.id,
        { stripe_session: null, stripe_session_expires: null },
        "owner",
        "price_adjusted",
        deps.now().toISOString(),
      );
    };
    deps.setNow(afterHold(v));
    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("awaiting_deposit");

    await releaseDueHolds(deps);
    expect((await current(v)).status).toBe("expired");
  });

  it("relit la réservation avant de la libérer : une date prolongée depuis la liste est laissée", async () => {
    const first = await validatedWithSession({ event_date: "2026-12-19" }); // échue à 10 h
    deps.setNow("2026-11-07T11:00:00.000Z");
    const second = await validatedBooking(deps, { event_date: "2026-12-26" }); // échue à 11 h
    deps.setNow("2026-11-10T12:00:00.000Z");

    // La tâche a déjà dressé sa liste quand le client de la seconde ouvre sa session de paiement.
    const retrieve = deps.stripe.retrieveSession;
    let extended = false;
    deps.stripe.retrieveSession = async (id) => {
      if (!extended) {
        extended = true;
        const session = await openSession(second);
        expect((await attachSession(deps, second.id, session)).ok).toBe(true);
      }
      return retrieve(id);
    };
    await releaseDueHolds(deps);

    expect((await current(first)).status).toBe("expired");
    const kept = await current(second);
    expect(kept.status).toBe("awaiting_deposit");
    expect(kept.hold_until).toBe("2026-11-10T12:35:00.000Z");
    expect(deps.stripe.sessions.get(kept.stripe_session!)!.status).toBe("open");
  });
});

describe("enqueueWeeklyDigest", () => {
  it("prépare le point du lundi à partir de 9 h de Paris, une seule fois", async () => {
    deps.setNow("2026-11-09T07:59:00.000Z");
    await enqueueWeeklyDigest(deps);
    expect(await digests()).toHaveLength(0);

    deps.setNow("2026-11-09T08:00:00.000Z");
    await enqueueWeeklyDigest(deps);
    await enqueueWeeklyDigest(deps);
    const sent = await digests();
    expect(sent.map((n) => n.channel).sort()).toEqual(["email", "telegram"]);
    expect(sent.every((n) => n.booking_id === null && n.recipient === "owner")).toBe(true);
    expect(sent.every((n) => n.due_at === "2026-11-09T08:00:00.000Z")).toBe(true);
    expect(sent.map((n) => n.dedupe_key).sort()).toEqual(["digest:2026-11-09:email", "digest:2026-11-09:telegram"]);
  });

  it("suit l'heure d'été de Paris", async () => {
    deps.setNow("2026-07-06T06:59:00.000Z"); // 8 h 59 à Paris
    await enqueueWeeklyDigest(deps);
    expect(await digests()).toHaveLength(0);

    deps.setNow("2026-07-06T07:00:00.000Z"); // 9 h
    await enqueueWeeklyDigest(deps);
    expect(await digests()).toHaveLength(2);
  });

  it("ne le double pas aux passages suivants du même lundi", async () => {
    for (const iso of ["2026-11-09T08:00:00.000Z", "2026-11-09T08:05:00.000Z", "2026-11-09T22:55:00.000Z"]) {
      deps.setNow(iso);
      await enqueueWeeklyDigest(deps);
    }
    expect(await digests()).toHaveLength(2);
  });

  it("le prépare quand même si la tâche n'est passée que plus tard dans la journée", async () => {
    deps.setNow("2026-11-09T15:00:00.000Z");
    await enqueueWeeklyDigest(deps);
    expect((await digests()).map((n) => n.channel).sort()).toEqual(["email", "telegram"]);
  });

  it.each([
    ["mardi", "2026-11-10T08:00:00.000Z"],
    ["dimanche", "2026-11-08T08:00:00.000Z"],
  ])("ne prépare rien le %s", async (_day, iso) => {
    deps.setNow(iso);
    await enqueueWeeklyDigest(deps);
    expect(await digests()).toEqual([]);
  });

  it("en prépare un nouveau chaque lundi", async () => {
    for (const iso of ["2026-11-09T08:00:00.000Z", "2026-11-16T08:00:00.000Z"]) {
      deps.setNow(iso);
      await enqueueWeeklyDigest(deps);
    }
    expect((await digests()).map((n) => n.dedupe_key).sort()).toEqual([
      "digest:2026-11-09:email",
      "digest:2026-11-09:telegram",
      "digest:2026-11-16:email",
      "digest:2026-11-16:telegram",
    ]);
  });
});

describe("runCron", () => {
  it("écrit son dernier passage", async () => {
    await runCron(deps);
    expect(await getState(env.DB, "last_cron_run")).toBe(T0);
  });

  it("écrit son dernier passage, même si une étape échoue", async () => {
    const v = await validatedWithSession();
    deps.stripe.failNext("retrieveSession");
    deps.setNow(afterHold(v));
    await runCron(deps);
    expect((await current(v)).status).toBe("awaiting_deposit");
    expect(await getState(env.DB, "last_cron_run")).toBe(DEADLINE);
  });

  it("libère, prépare le point du lundi et anonymise dans un même passage", async () => {
    const due = await request();
    const refused = (await insert(newBooking({ status: "refused", event_date: "2026-12-26", hold_until: null }))).booking;
    deps.setNow(MONDAY_9H);
    await runCron(deps);
    expect((await current(due)).status).toBe("expired");
    expect(await digests()).toHaveLength(2);
    expect((await current(refused)).anonymized_at).toBe(MONDAY_9H);
    expect(await getState(env.DB, "last_cron_run")).toBe(MONDAY_9H);
    expect(logged).not.toHaveBeenCalled();
  });

  it("une étape en panne n'empêche pas les suivantes", async () => {
    const refused = (await insert(newBooking({ status: "refused", hold_until: null }))).booking;
    deps.setNow(MONDAY_9H);
    deps.env = { ...deps.env, DB: brokenFor(/hold_until <= \?/) }; // la libération ne peut pas lister les échéances
    await runCron(deps);
    expect(await digests()).toHaveLength(2);
    expect((await current(refused)).anonymized_at).toBe(MONDAY_9H);
    expect(await getState(env.DB, "last_cron_run")).toBe(MONDAY_9H);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0])).toContain("Error");
  });

  it("une anonymisation en panne n'empêche ni la libération ni le point, et sera reprise au passage suivant", async () => {
    const due = await request();
    deps.setNow(MONDAY_9H);
    deps.env = { ...deps.env, DB: brokenFor(/anonymized_at = \?/) };
    await runCron(deps);
    expect((await current(due)).status).toBe("expired");
    expect(await digests()).toHaveLength(2);
    expect(await getState(env.DB, "last_anonymize")).toBeNull();
    expect(await getState(env.DB, "last_cron_run")).toBe(MONDAY_9H);
  });

  describe("anonymisation", () => {
    /** Un refus, une expiration et une prestation confirmée, tous créés à `T0`. */
    async function seed() {
      const row = async (status: NewBooking["status"], event_date: string) =>
        (await insert(newBooking({ status, event_date, hold_until: null, deposit_paid_at: status === "confirmed" ? T0 : null })))
          .booking;
      return { refused: await row("refused", "2026-12-12"), expired: await row("expired", "2026-12-19"), confirmed: await row("confirmed", "2026-12-26") };
    }

    it("anonymise les refus et expirations de plus de 12 mois, pas les prestations confirmées", async () => {
      const { refused, expired, confirmed } = await seed();
      deps.setNow("2027-11-09T10:00:00.000Z");
      await runCron(deps);
      for (const b of [refused, expired]) {
        expect(await current(b)).toMatchObject({
          client_name: null,
          client_email: null,
          client_phone: null,
          venue: null,
          message: null,
          ip_hash: null,
          notes: null,
          anonymized_at: "2027-11-09T10:00:00.000Z",
        });
      }
      expect(await current(confirmed)).toEqual(confirmed);
    });

    it.each([
      ["pile 12 mois après la création", "2027-11-07T10:00:00.000Z", false],
      ["une milliseconde plus tard", "2027-11-07T10:00:00.001Z", true],
    ])("%s", async (_when, iso, anonymized) => {
      const { refused } = await seed();
      deps.setNow(iso);
      await runCron(deps);
      expect((await current(refused)).anonymized_at !== null).toBe(anonymized);
    });

    it("ne repasse qu'une fois par jour de Paris", async () => {
      await seed();
      deps.setNow("2027-11-09T10:00:00.000Z");
      await runCron(deps);
      expect(await getState(env.DB, "last_anonymize")).toBe("2027-11-09");

      const late = (await insert(newBooking({ status: "refused", event_date: "2026-12-05", hold_until: null }))).booking;
      deps.setNow("2027-11-09T22:59:00.000Z"); // 23 h 59 à Paris : même jour
      await runCron(deps);
      expect((await current(late)).client_name).not.toBeNull();

      deps.setNow("2027-11-09T23:05:00.000Z"); // 0 h 05 à Paris : le lendemain, bien que ce soit encore le 9 en UTC
      await runCron(deps);
      expect((await current(late)).anonymized_at).toBe("2027-11-09T23:05:00.000Z");
      expect(await getState(env.DB, "last_anonymize")).toBe("2027-11-10");
    });
  });
});

describe("tâche planifiée du Worker", () => {
  it("lance la tâche automatique", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    const last = await getState(env.DB, "last_cron_run");
    expect(last).not.toBeNull();
    expect(Math.abs(Date.parse(last!) - Date.now())).toBeLessThan(60_000);
  });
});
