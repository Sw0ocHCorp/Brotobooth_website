import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createContact } from "../../worker/contact";
import { cancelBooking } from "../../worker/operations";
import { makeDeps, turnstileVerifier } from "../../worker/deps";
import type { Deps } from "../../worker/deps";
import { chatIds, type Env } from "../../worker/env";
import { resendGateway } from "../../worker/email";
import { processDue } from "../../worker/notifications";
import { offer } from "../../worker/offer";
import {
  claimNotification,
  deleteContactMessage,
  enqueue,
  getState,
  patchBooking,
  setState,
  type ContactMessage,
  type NotificationSpec,
} from "../../worker/repository";
import { handle } from "../../worker/router";
import { telegramGateway } from "../../worker/telegram";
import wrangler from "../../wrangler.jsonc?raw";
import { CHAT_ID, OWNER_EMAIL, T0, fakeDeps, insert, newBooking, notificationRows, requestBody, resetDb, type FakeDeps } from "../support";

let deps: FakeDeps;
let logged: MockInstance<Console["error"]>;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
  vi.unstubAllGlobals();
});

const logs = () => logged.mock.calls.flat().join("\n");

const spec = (channel: NotificationSpec["channel"], template: string, bookingId: string | null, over: Partial<NotificationSpec> = {}): NotificationSpec => ({
  booking_id: bookingId,
  dedupe_key: `${bookingId}:${template}:${channel}`,
  channel,
  recipient: template.startsWith("client_") ? "client" : "owner",
  template,
  due_at: T0,
  ...over,
});
const mail = (template: string, bookingId: string | null, over: Partial<NotificationSpec> = {}) => spec("email", template, bookingId, over);
const telegram = (template: string, bookingId: string | null, over: Partial<NotificationSpec> = {}) => spec("telegram", template, bookingId, over);

/** Une réservation du 19 décembre, par défaut en attente de réponse. */
const seeded = async (over: Parameters<typeof newBooking>[0] = {}) => (await insert(newBooking(over))).booking;

describe("processDue : envoi des messages dus", () => {
  it("envoie une notification due une seule fois", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
    expect(deps.emails).toHaveLength(1);
    expect(deps.emails[0]).toMatchObject({ to: "camille@example.test", subject: "Nous avons bien reçu votre demande pour le samedi 19 décembre 2026" });
    expect(deps.emails[0].text).toContain("Bonjour Camille Martin,");
    expect((await notificationRows())[0].sent_at).toBe(T0);
  });

  it("envoie les messages du propriétaire à l'adresse du propriétaire, et ceux de Telegram à ses chats", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("owner_new_request", b.id), telegram("owner_new_request", b.id)]);
    await processDue(deps);
    expect(deps.emails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    expect(deps.telegrams.map((m) => m.chatId)).toEqual([CHAT_ID]);
    expect(deps.telegrams[0].buttons!.flat().map((x) => x.text)).toEqual(["Valider", "Refuser", "Ajuster le prix"]);
  });

  it("n'envoie pas avant l'heure ni après annulation", async () => {
    const b = await seeded();
    await enqueue(env.DB, [
      mail("client_received", b.id, { dedupe_key: "later", due_at: "2026-11-07T10:00:01.000Z" }),
      mail("client_refused", b.id, { dedupe_key: "cancelled" }),
    ]);
    await env.DB.prepare("UPDATE notifications SET cancelled_at = ? WHERE dedupe_key = 'cancelled'").bind(T0).run();
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
    expect(deps.emails).toHaveLength(0);

    deps.setNow("2026-11-07T10:00:01.000Z");
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(deps.emails.map((m) => m.subject)).toEqual(["Nous avons bien reçu votre demande pour le samedi 19 décembre 2026"]);
    expect((await notificationRows()).find((n) => n.dedupe_key === "cancelled")!.sent_at).toBeNull();
  });

  it("saute un rappel devenu inutile sans échec", async () => {
    const cancelled = await seeded({ status: "cancelled", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", cancelled.id), mail("owner_d7", cancelled.id)]);
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
    expect(deps.telegrams).toHaveLength(0);
    expect(deps.emails).toHaveLength(0);
    const rows = await notificationRows();
    expect(rows.map((n) => n.cancelled_at)).toEqual([T0, T0]);
    expect(rows.map((n) => n.sent_at)).toEqual([null, null]);
    expect(rows.map((n) => n.attempts)).toEqual([0, 0]);
  });

  it("envoie le même rappel quand la réservation est encore confirmée", async () => {
    const confirmed = await seeded({ status: "confirmed", hold_until: null, deposit_paid_at: T0 });
    await enqueue(env.DB, [telegram("owner_d7", confirmed.id)]);
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(deps.telegrams[0].html).toContain("Dans une semaine");
  });

  it("n'envoie pas un message annulé par l'annulation de la réservation", async () => {
    const b = await seeded({ status: "awaiting_deposit" });
    await enqueue(env.DB, [mail("client_deposit_reminder", b.id)]);
    expect((await cancelBooking(deps, b.id, "owner")).ok).toBe(true);
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    // Seul l'avis d'annulation part : le rappel du délai d'acompte a été annulé avec la réservation.
    expect(deps.emails.map((m) => m.subject)).toEqual(["Votre réservation du samedi 19 décembre 2026 est annulée"]);
  });

  it("rend le message d'après la réservation à jour, juste avant l'envoi", async () => {
    const b = await seeded({ status: "awaiting_deposit", deposit_cents: 45_000 });
    await enqueue(env.DB, [mail("client_deposit_link", b.id)]);
    await patchBooking(env.DB, b.id, { deposit_cents: 30_000 }, "owner", "price_adjusted", T0);
    await processDue(deps);
    expect(deps.emails[0].text).toContain("300 €");
    expect(deps.emails[0].text).not.toContain("450 €");
  });

  it("limite le nombre d'envois d'un passage", async () => {
    const b = await seeded();
    await enqueue(env.DB, ["a", "b", "c"].map((k) => mail("client_received", b.id, { dedupe_key: k })));
    expect(await processDue(deps, 2)).toEqual({ sent: 2, failed: 0 });
    expect(await processDue(deps, 2)).toEqual({ sent: 1, failed: 0 });
  });

  it("une panne d'envoi n'empêche pas les notifications suivantes", async () => {
    const first = await seeded({ event_date: "2026-12-19", client_email: "un@example.test" });
    const second = await seeded({ event_date: "2026-12-20", client_email: "deux@example.test" });
    await enqueue(env.DB, [mail("client_received", first.id), mail("client_received", second.id, { due_at: "2026-11-07T10:00:00.500Z" })]);
    deps.setNow("2026-11-07T10:00:01.000Z");
    const send = deps.email.send;
    deps.email.send = async (m) => {
      if (m.to === "un@example.test") throw new Error("panne");
      await send(m);
    };
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 1 });
    expect(deps.emails.map((m) => m.to)).toEqual(["deux@example.test"]);
  });
});

describe("processDue : passages simultanés", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const subjects = () => deps.emails.map((m) => m.subject).sort();

  /** Trois e-mails dus, pour trois dates : chaque message ne doit partir qu'une fois. */
  async function seedThree() {
    const rows: NotificationSpec[] = [];
    for (const [i, date] of ["2026-12-19", "2026-12-20", "2026-12-21"].entries()) {
      const b = await seeded({ event_date: date, client_email: `client${i}@example.test` });
      rows.push(mail("client_received", b.id));
    }
    await enqueue(env.DB, rows);
  }

  it("deux passages lancés ensemble n'envoient chaque message qu'une fois", async () => {
    await seedThree();
    deps.email.send = async (m) => {
      await sleep(5);
      deps.emails.push(m);
    };
    const [a, b] = await Promise.all([processDue(deps), processDue(deps)]);
    expect(a.sent + b.sent).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    expect(deps.emails.map((m) => m.to).sort()).toEqual(["client0@example.test", "client1@example.test", "client2@example.test"]);
  });

  it("un passage qui démarre pendant l'envoi d'un autre ne renvoie pas ce que celui-ci envoie", async () => {
    await seedThree();
    let firstSendStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstSendStarted = resolve));
    deps.email.send = async (m) => {
      firstSendStarted();
      await sleep(30);
      deps.emails.push(m);
    };
    const first = processDue(deps);
    await started; // le premier passage a réservé et envoie : les trois lignes sont encore sans date d'envoi
    const second = processDue(deps);
    const [a, b] = await Promise.all([first, second]);
    expect(a.sent + b.sent).toBe(3);
    expect(deps.emails).toHaveLength(3);
    expect(new Set(deps.emails.map((m) => m.to)).size).toBe(3);
  });

  it("deux passages avec des fausses passerelles distinctes n'envoient pas deux fois (isolats différents)", async () => {
    await seedThree();
    const other = fakeDeps();
    const [a, b] = await Promise.all([processDue(deps), processDue(other)]);
    expect(a.sent + b.sent).toBe(3);
    expect(deps.emails.length + other.emails.length).toBe(3);
  });

  it("deux passages simultanés n'envoient qu'une alerte Telegram par message du propriétaire", async () => {
    const b = await seeded({ status: "confirmed", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", b.id), mail("owner_d7", b.id)]);
    await Promise.all([processDue(deps), processDue(deps), processDue(deps)]);
    expect(deps.telegrams).toHaveLength(1);
    expect(deps.emails).toHaveLength(1);
  });

  it("réserve l'envoi avant de l'envoyer et compte l'essai", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    let during: unknown;
    deps.email.send = async (m) => {
      during = (await notificationRows())[0];
      deps.emails.push(m);
    };
    await processDue(deps);
    expect(during).toMatchObject({ attempts: 1, sent_at: null, claimed_until: "2026-11-07T10:02:00.000Z" });
    expect((await notificationRows())[0]).toMatchObject({ attempts: 1, sent_at: T0 });
  });

  it("laisse un envoi réservé par un autre passage jusqu'à la fin de sa réservation, puis le reprend", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    // Un passage a réservé l'envoi puis s'est interrompu avant de le terminer.
    expect(await claimNotification(env.DB, (await notificationRows())[0].id, T0, "2026-11-07T10:02:00.000Z")).toBe(1);

    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
    deps.setNow("2026-11-07T10:01:59.999Z");
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
    expect(deps.emails).toHaveLength(0);

    deps.setNow("2026-11-07T10:02:00.000Z");
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect((await notificationRows())[0].attempts).toBe(2);
  });

  it("libère l'envoi après un échec : le passage suivant le reprend tout de suite", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    const send = deps.email.send;
    deps.email.send = async () => {
      throw new Error("panne");
    };
    await processDue(deps);
    expect((await notificationRows())[0]).toMatchObject({ attempts: 1, claimed_until: null });
    deps.email.send = send;
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect((await notificationRows())[0].attempts).toBe(2);
  });

  it("compte exactement un essai par envoi : le seuil de trois échecs ne bouge pas", async () => {
    deps.email.send = async () => {
      throw new Error("panne");
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    await processDue(deps);
    await processDue(deps);
    expect((await notificationRows()).filter((n) => n.template === "owner_email_failed")).toHaveLength(0);
    await processDue(deps);
    expect((await notificationRows()).map((n) => [n.template, n.attempts])).toEqual([
      ["client_received", 3],
      ["owner_email_failed", 1],
    ]);
  });

  it("donne la clé de dédoublonnage au service d'e-mail, pour qu'une reprise ne renvoie pas le message", async () => {
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id), mail("owner_new_request", b.id)]);
    await processDue(deps);
    expect(deps.emails.map((m) => m.idempotencyKey).sort()).toEqual([
      expect.stringMatching(new RegExp(`^${b.id}:client_received:email:[0-9a-f]{16}$`)),
      expect.stringMatching(new RegExp(`^${b.id}:owner_new_request:email:[0-9a-f]{16}$`)),
    ]);
  });

  // Resend refuse une clé réutilisée avec un autre contenu : sans l'empreinte, un e-mail dont la réservation a changé
  // entre deux tentatives resterait bloqué jusqu'à l'alerte.
  describe("clé d'idempotence d'une reprise", () => {
    /** Envoie `client_deposit_link` en échec une fois, modifie la réservation s'il le faut, puis le renvoie : les deux clés tentées. */
    async function retry(change?: Parameters<typeof patchBooking>[2]) {
      const b = await seeded({ status: "awaiting_deposit", deposit_cents: 45_000 });
      await enqueue(env.DB, [mail("client_deposit_link", b.id)]);
      const keys: (string | undefined)[] = [];
      let failing = true;
      deps.email.send = async (m) => {
        keys.push(m.idempotencyKey);
        if (failing) throw new Error("panne");
      };
      await processDue(deps);
      if (change) await patchBooking(env.DB, b.id, change, "owner", "price_adjusted", T0);
      failing = false;
      deps.setNow("2026-11-07T10:06:00.000Z");
      await processDue(deps);
      return { keys, id: b.id };
    }

    it("garde la même clé tant que le message ne change pas : la reprise ne renvoie pas un message déjà parti", async () => {
      const { keys } = await retry();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("prend une clé neuve quand la réservation a changé entre deux tentatives, sur le même préfixe", async () => {
      const { keys, id } = await retry({ deposit_cents: 30_000 });
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
      for (const key of keys) expect(key).toMatch(new RegExp(`^${id}:client_deposit_link:email:[0-9a-f]{16}$`));
    });

    it("ne met pas le texte du message dans la clé", async () => {
      const { keys } = await retry();
      expect(keys.join()).not.toMatch(/Camille|acompte|450/);
    });
  });
});

describe("processDue : reprises et alertes", () => {
  it("reprend un envoi après un échec", async () => {
    const d = fakeDeps();
    let fail = true;
    d.email.send = async (m) => {
      if (fail) {
        fail = false;
        throw new Error("panne");
      }
      d.emails.push(m);
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    expect(await processDue(d)).toEqual({ sent: 0, failed: 1 });
    expect((await notificationRows())[0]).toMatchObject({ attempts: 1, last_error: "Error: panne", sent_at: null });
    expect(await processDue(d)).toEqual({ sent: 1, failed: 0 });
    expect(d.emails).toHaveLength(1);
  });

  it("alerte le propriétaire après 3 échecs d'envoi au client, une seule fois", async () => {
    deps.email.send = async () => {
      throw new Error("panne");
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);

    await processDue(deps);
    await processDue(deps);
    expect(deps.telegrams).toHaveLength(0);
    await processDue(deps);
    expect(deps.telegrams).toHaveLength(1);
    expect(deps.telegrams[0]).toMatchObject({ chatId: CHAT_ID });
    expect(deps.telegrams[0].html).toContain("Camille Martin");

    await processDue(deps);
    await processDue(deps);
    expect(deps.telegrams).toHaveLength(1);
    const alerts = (await notificationRows()).filter((n) => n.template === "owner_email_failed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      dedupe_key: `${b.id}:client_received:email:alert`,
      channel: "telegram",
      recipient: "owner",
      booking_id: b.id,
    });
    expect(alerts[0].sent_at).toBe(T0);
  });

  it("n'alerte pas pour un e-mail du propriétaire qui échoue", async () => {
    deps.email.send = async () => {
      throw new Error("panne");
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("owner_new_request", b.id)]);
    for (let i = 0; i < 4; i++) await processDue(deps);
    expect(deps.telegrams).toHaveLength(0);
    expect((await notificationRows()).map((n) => n.template)).toEqual(["owner_new_request"]);
  });

  it("bascule sur e-mail quand Telegram échoue", async () => {
    deps.telegram.send = async () => {
      throw new Error("panne");
    };
    const b = await seeded({ status: "confirmed", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", b.id)]);

    expect(await processDue(deps)).toEqual({ sent: 1, failed: 1 });
    const rows = await notificationRows();
    expect(rows.map((n) => [n.dedupe_key, n.channel, n.recipient, n.template])).toEqual([
      [`${b.id}:owner_d7:telegram`, "telegram", "owner", "owner_d7"],
      [`${b.id}:owner_d7:telegram:fallback`, "email", "owner", "owner_d7"],
    ]);
    expect(rows[0]).toMatchObject({ attempts: 1, sent_at: null });
    expect(rows[1].sent_at).toBe(T0);
    expect(deps.emails).toHaveLength(1);
    expect(deps.emails[0]).toMatchObject({ to: OWNER_EMAIL, subject: "Dans une semaine : samedi 19 décembre 2026" });

    // Au passage suivant, Telegram est retenté sans doubler le message de secours.
    await processDue(deps);
    expect((await notificationRows()).filter((n) => n.channel === "email")).toHaveLength(1);
  });

  it("bascule aussi sur e-mail quand l'alerte Telegram échoue", async () => {
    deps.telegram.send = async () => {
      throw new Error("panne");
    };
    deps.email.send = async (m) => {
      if (m.to === "camille@example.test") throw new Error("panne");
      deps.emails.push(m);
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    for (let i = 0; i < 3; i++) await processDue(deps);
    expect(deps.emails.map((m) => [m.to, m.subject])).toEqual([
      [OWNER_EMAIL, "Un e-mail n'est pas parti pour la prestation du samedi 19 décembre 2026"],
    ]);
  });

  it("envoie à chaque chat configuré", async () => {
    const d = fakeDeps({ env: { ...env, OWNER_EMAIL, TELEGRAM_CHAT_IDS: "1,2" } });
    const b = await seeded({ status: "confirmed", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", b.id)]);
    expect(await processDue(d)).toEqual({ sent: 1, failed: 0 });
    expect(d.telegrams.map((m) => m.chatId)).toEqual(["1", "2"]);
    expect(d.telegrams[1].html).toBe(d.telegrams[0].html);
  });

  it("compte l'envoi comme fait quand un chat répond, sans le renvoyer aux autres", async () => {
    const d = fakeDeps({ env: { ...env, OWNER_EMAIL, TELEGRAM_CHAT_IDS: "1,2" } });
    d.telegram.send = async (chatId, html, buttons) => {
      if (chatId === "2") throw new Error("bot bloqué par ce chat");
      d.telegrams.push({ chatId, html, buttons });
    };
    const b = await seeded({ status: "confirmed", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", b.id)]);
    expect(await processDue(d)).toEqual({ sent: 1, failed: 0 });
    expect(await processDue(d)).toEqual({ sent: 0, failed: 0 });
    expect(d.telegrams.map((m) => m.chatId)).toEqual(["1"]);
    expect(d.emails).toHaveLength(0);
    expect(logs()).toMatch(/Notification \d+ \(owner_d7\) : Error/);
    expect(logs()).not.toContain("bloqué");
  });

  it("échoue, puis écrit par e-mail, quand aucun chat n'est configuré", async () => {
    const d = fakeDeps({ env: { ...env, OWNER_EMAIL, TELEGRAM_CHAT_IDS: " , " } });
    const b = await seeded({ status: "confirmed", hold_until: null });
    await enqueue(env.DB, [telegram("owner_d7", b.id)]);
    expect(await processDue(d)).toEqual({ sent: 1, failed: 1 });
    expect(d.telegrams).toHaveLength(0);
    expect(d.emails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
  });

  it("échoue sans envoyer quand le client n'a pas d'adresse", async () => {
    const b = await seeded({ client_email: null });
    await enqueue(env.DB, [mail("client_received", b.id)]);
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 1 });
    expect(deps.emails).toHaveLength(0);
  });

  it("ne consigne que le numéro, le modèle et le nom de l'erreur", async () => {
    deps.email.send = async () => {
      throw new Error("panne chez camille@example.test, clé re_secrète");
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    await processDue(deps);
    const id = (await notificationRows())[0].id;
    expect(logged.mock.calls).toEqual([[`Notification ${id} (client_received) : Error`]]);
  });

  it("consigne, sans donnée personnelle, une panne de la base pendant la mise en file des suites", async () => {
    deps.email.send = async () => {
      throw new Error("panne");
    };
    const b = await seeded();
    await enqueue(env.DB, [mail("client_received", b.id)]);
    await processDue(deps);
    await processDue(deps);
    const real = env.DB;
    const flaky = {
      prepare: (sql: string) => real.prepare(sql),
      batch: () => Promise.reject(new Error("D1 : camille@example.test")),
    } as unknown as D1Database;
    deps.env = { ...deps.env, DB: flaky };
    logged.mockClear();
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 1 });
    expect(logged.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(/^Notification \d+ \(client_received\) : Error$/),
      expect.stringMatching(/^Notification \d+ \(client_received\) : Error$/),
    ]);
    expect(logs()).not.toContain("camille");
  });
});

describe("processDue : le point du lundi", () => {
  const confirmed = (date: string, name: string) => ({
    status: "confirmed" as const,
    event_date: date,
    client_name: name,
    hold_until: null,
    client_email: `${name.split(" ")[0].toLowerCase()}@example.test`,
  });

  it("liste les prestations à venir, pas celles de la veille ni les annulées", async () => {
    await seeded(confirmed("2026-12-19", "Camille Martin"));
    await seeded({ ...confirmed("2027-01-09", "Lou Durand"), status: "awaiting_deposit" });
    await seeded({ ...confirmed("2026-11-07", "Sam Aujourdhui") });
    await seeded(confirmed("2026-11-06", "Hier Passé"));
    await seeded({ ...confirmed("2026-12-26", "Annulée Cancel"), status: "cancelled" });
    await seeded({ ...confirmed("2026-12-27", "Bloquée Bloc"), status: "blocked" });
    await enqueue(env.DB, [telegram("owner_digest", null, { dedupe_key: "digest:2026-11-07:telegram" }), mail("owner_digest", null, { dedupe_key: "digest:2026-11-07:email" })]);

    expect(await processDue(deps)).toEqual({ sent: 2, failed: 0 });
    const { html } = deps.telegrams[0];
    for (const part of ["samedi 19 décembre 2026", "samedi 9 janvier 2027", "samedi 7 novembre 2026", "Camille Martin", "Lou Durand", "Sam Aujourdhui"]) {
      expect(html).toContain(part);
    }
    for (const part of ["Hier Passé", "Annulée Cancel", "Bloquée Bloc"]) expect(html).not.toContain(part);
    expect(deps.emails[0]).toMatchObject({ to: OWNER_EMAIL, subject: "Point du lundi : les prestations à venir" });
    expect(deps.emails[0].text).toContain("Camille Martin");
  });

  it("annonce une semaine vide", async () => {
    await enqueue(env.DB, [telegram("owner_digest", null, { dedupe_key: "digest:2026-11-07:telegram" })]);
    await processDue(deps);
    expect(deps.telegrams[0].html).toContain("Aucune prestation à venir");
  });

  it("compte le jour de Paris : à minuit passé à Paris, la veille UTC n'est plus à venir", async () => {
    await seeded(confirmed("2026-11-07", "Sam Aujourdhui"));
    await enqueue(env.DB, [telegram("owner_digest", null, { dedupe_key: "digest:x:telegram", due_at: "2026-11-07T23:30:00.000Z" })]);
    deps.setNow("2026-11-07T23:30:00.000Z"); // 0 h 30 à Paris, le 8 novembre
    await processDue(deps);
    expect(deps.telegrams[0].html).toContain("Aucune prestation à venir");
  });
});

describe("processDue : les messages de contact", () => {
  /** Un message du formulaire, enregistré comme le fait `POST /api/contact` : son e-mail au propriétaire attend en file. */
  async function received(over: Record<string, unknown> = {}): Promise<ContactMessage> {
    const body = {
      name: "Lou Bernard",
      email: "lou@example.test",
      phone: "06 98 76 54 32",
      message: "Êtes-vous libres le 12 juin ?",
      turnstile_token: "t",
      ...over,
    };
    expect(await createContact(deps, body, null)).toEqual({ kind: "sent" });
    return (await env.DB.prepare("SELECT * FROM contact_messages ORDER BY rowid DESC LIMIT 1").first<ContactMessage>())!;
  }

  /** L'effacement d'un message : ses envois d'abord, puis le message, comme l'exigent les clés étrangères de D1. */
  const erase = (id: string) => deleteContactMessage(env.DB, id);

  it("envoie le message au propriétaire, « Répondre » écrivant au visiteur, et rien sur Telegram", async () => {
    const c = await received();
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(deps.emails).toEqual([expect.objectContaining({ to: offer.contact.email, replyTo: "lou@example.test", subject: "Message de Lou Bernard" })]);
    expect(deps.emails[0].text).toContain("Êtes-vous libres le 12 juin ?");
    expect(deps.emails[0].idempotencyKey).toMatch(new RegExp(`^contact:${c.id}:email:[0-9a-f]{16}$`));
    expect(deps.telegrams).toEqual([]);
    expect(await notificationRows()).toMatchObject([{ contact_id: c.id, sent_at: T0 }]);
  });

  describe("le destinataire", () => {
    const real = offer.contact;
    afterEach(() => {
      offer.contact = real;
    });

    it("est l'adresse de contact de l'offre, et elle seule", async () => {
      offer.contact = { ...real, email: "contact@example.test" };
      await received();
      expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
      expect(deps.emails.map((m) => m.to)).toEqual(["contact@example.test"]);
    });

    it("retombe sur OWNER_EMAIL quand l'offre n'a pas d'adresse de contact", async () => {
      offer.contact = { ...real, email: "" };
      await received();
      await processDue(deps);
      expect(deps.emails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    });

    it("laisse les autres messages au propriétaire sur OWNER_EMAIL", async () => {
      offer.contact = { ...real, email: "contact@example.test" };
      const b = await seeded();
      await enqueue(env.DB, [mail("owner_new_request", b.id)]);
      await processDue(deps);
      expect(deps.emails.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    });
  });

  it("garde l'e-mail en file quand Resend est en panne, et l'envoie au passage suivant", async () => {
    let down = true;
    deps.email.send = async (m) => {
      if (down) throw new Error("panne");
      deps.emails.push(m);
    };
    await received();
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 1 });
    expect(await notificationRows()).toMatchObject([{ attempts: 1, last_error: "Error: panne", sent_at: null }]);
    down = false;
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(deps.emails.map((m) => [m.to, m.replyTo])).toEqual([[offer.contact.email, "lou@example.test"]]);
  });

  it("au troisième échec, prévient le propriétaire sur Telegram sans rien du message, une seule fois", async () => {
    deps.email.send = async () => {
      throw new Error("panne chez lou@example.test");
    };
    const c = await received();
    await processDue(deps);
    await processDue(deps);
    expect(deps.telegrams).toEqual([]);
    await processDue(deps);
    expect(deps.telegrams.map((m) => m.chatId)).toEqual([CHAT_ID]);
    const { html } = deps.telegrams[0];
    expect(html).toContain("zone Messages");
    for (const value of [c.id, "Lou", "Bernard", "lou@example.test", "06 98 76 54 32", "12 juin"]) expect(html).not.toContain(value);

    await processDue(deps);
    await processDue(deps);
    expect(deps.telegrams).toHaveLength(1);
    // L'alerte porte le message : l'effacer l'emporte aussi.
    expect((await notificationRows()).filter((n) => n.template === "owner_contact_failed")).toEqual([
      expect.objectContaining({
        dedupe_key: `contact:${c.id}:email:alert`,
        channel: "telegram",
        recipient: "owner",
        booking_id: null,
        contact_id: c.id,
        sent_at: T0,
      }),
    ]);
    expect(logs()).not.toMatch(/lou|bernard/i);
  });

  it("n'alerte qu'une fois quand Telegram et Resend sont en panne : l'e-mail de secours de l'alerte n'en appelle pas d'autre", async () => {
    deps.email.send = async () => {
      throw new Error("panne");
    };
    deps.telegram.send = async () => {
      throw new Error("panne");
    };
    const c = await received();
    for (let i = 0; i < 6; i++) await processDue(deps);
    expect((await notificationRows()).map((n) => [n.dedupe_key, n.channel, n.template, n.contact_id])).toEqual([
      [`contact:${c.id}:email`, "email", "owner_contact", c.id],
      [`contact:${c.id}:email:alert`, "telegram", "owner_contact_failed", c.id],
      [`contact:${c.id}:email:alert:fallback`, "email", "owner_contact_failed", c.id],
    ]);
  });

  it("a deleted message cancels its pending email", async () => {
    const kept = await received();
    const erased = await received({ name: "Sam Petit", email: "sam@example.test" });
    const send = deps.email.send;
    // Le second message est effacé pendant le passage, après que celui-ci a listé les deux envois.
    deps.email.send = async (m) => {
      await erase(erased.id);
      await send(m);
    };
    expect(await processDue(deps)).toEqual({ sent: 1, failed: 0 });
    expect(deps.emails.map((m) => m.subject)).toEqual(["Message de Lou Bernard"]);
    expect((await notificationRows()).map((n) => [n.contact_id, n.sent_at])).toEqual([[kept.id, T0]]);
    expect(logged).not.toHaveBeenCalled();
    expect(await processDue(deps)).toEqual({ sent: 0, failed: 0 });
  });
});

describe("passerelle Resend", () => {
  const message = { to: "camille@example.test", subject: "Objet", text: "Texte", html: "<p>Texte</p>" };
  const RESEND_ENV = { ...env, RESEND_API_KEY: "re_cle_secrete", FROM_EMAIL: "reservations@example.test", OWNER_EMAIL } as Env;
  const savedContact = { ...offer.contact };
  afterEach(() => {
    Object.assign(offer.contact, savedContact);
  });

  const recorder = (respond: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it("envoie vers api.resend.com avec la clé et l'expéditeur de l'environnement", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer re_cle_secrete", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: "reservations@example.test",
      to: ["camille@example.test"],
      reply_to: expect.any(String),
      subject: "Objet",
      text: "Texte",
      html: "<p>Texte</p>",
    });
  });

  // L'expéditeur est une adresse d'envoi : un client qui répond à un e-mail doit joindre quelqu'un.
  it("fait répondre à l'adresse de contact de l'offre quand elle est renseignée", async () => {
    Object.assign(offer.contact, { email: "contact@example.test" });
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send(message);
    expect(JSON.parse(calls[0].init.body as string).reply_to).toBe("contact@example.test");
  });

  it("fait répondre à l'adresse du propriétaire tant que l'offre n'a pas d'adresse de contact", async () => {
    Object.assign(offer.contact, { email: "" });
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send(message);
    expect(JSON.parse(calls[0].init.body as string).reply_to).toBe(OWNER_EMAIL);
  });

  it("fait répondre à l'adresse que porte le message, avant celle de l'offre", async () => {
    Object.assign(offer.contact, { email: "contact@example.test" });
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send({ ...message, replyTo: "lou@example.test" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.reply_to).toBe("lou@example.test");
    expect(body).not.toHaveProperty("replyTo");
  });

  it("n'écrit aucune adresse de réponse quand aucune n'est connue", async () => {
    Object.assign(offer.contact, { email: "" });
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway({ ...RESEND_ENV, OWNER_EMAIL: "" }, fetchFn).send(message);
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("reply_to");
  });

  it("envoie la clé d'idempotence quand le message en porte une, et la garde hors du corps", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send({ ...message, idempotencyKey: "b1:client_received:email" });
    expect(calls[0].init.headers).toMatchObject({ "Idempotency-Key": "b1:client_received:email", Authorization: "Bearer re_cle_secrete" });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty("idempotencyKey");
  });

  it("n'envoie aucune clé d'idempotence quand le message n'en porte pas", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await resendGateway(RESEND_ENV, fetchFn).send(message);
    expect(calls[0].init.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("borne l'appel dans le temps", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({}));
    await resendGateway(RESEND_ENV, fetchFn).send(message);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 422, 429, 500, 503])("lève sur une réponse %i, sans reprendre ni la réponse ni la clé", async (status) => {
    const { fetchFn } = recorder(() => new Response('{"message":"adresse camille@example.test refusée"}', { status }));
    const error = await resendGateway(RESEND_ENV, fetchFn).send(message).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Resend a répondu ${status}`);
  });

  it("lève quand le réseau échoue, sans reprendre le message d'origine", async () => {
    const fetchFn = (async () => {
      throw new TypeError("connexion à re_cle_secrete perdue");
    }) as unknown as typeof fetch;
    const error = await resendGateway(RESEND_ENV, fetchFn).send(message).catch((e: Error) => e);
    expect((error as Error).message).toBe("Resend injoignable (TypeError)");
  });

  it("utilise le fetch global par défaut", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({}));
    vi.stubGlobal("fetch", fetchFn);
    await resendGateway(RESEND_ENV).send(message);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
  });
});

describe("passerelle Telegram", () => {
  const TG_ENV = { ...env, TELEGRAM_BOT_TOKEN: "123:jeton-secret" } as Env;
  const buttons = [[{ text: "Valider", data: "v:b1" }, { text: "Refuser", data: "r:b1" }], [{ text: "Ajuster le prix", url: "https://brotobooth.fr/admin#b1" }]];

  const recorder = (respond: () => Response | Promise<Response> = () => Response.json({ ok: true })) => {
    const calls: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), init });
      return respond();
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it("send appelle sendMessage en HTML avec un clavier à boutons", async () => {
    const { calls, fetchFn } = recorder();
    await telegramGateway(TG_ENV, fetchFn).send("42", "<b>Bonjour</b>", buttons);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:jeton-secret/sendMessage");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(calls[0].body).toEqual({
      chat_id: "42",
      text: "<b>Bonjour</b>",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Valider", callback_data: "v:b1" }, { text: "Refuser", callback_data: "r:b1" }],
          [{ text: "Ajuster le prix", url: "https://brotobooth.fr/admin#b1" }],
        ],
      },
    });
  });

  it("send n'ajoute pas de clavier sans bouton", async () => {
    const { calls, fetchFn } = recorder();
    await telegramGateway(TG_ENV, fetchFn).send("42", "texte");
    expect(calls[0].body).toEqual({ chat_id: "42", text: "texte", parse_mode: "HTML" });
  });

  it("edit appelle editMessageText, et retire le clavier sans bouton", async () => {
    const { calls, fetchFn } = recorder();
    const gateway = telegramGateway(TG_ENV, fetchFn);
    await gateway.edit("42", 7, "<b>Fait</b>", buttons);
    await gateway.edit("42", 7, "<b>Fait</b>");
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:jeton-secret/editMessageText");
    expect(calls[0].body).toMatchObject({ chat_id: "42", message_id: 7, text: "<b>Fait</b>", parse_mode: "HTML" });
    expect(calls[1].body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("answer appelle answerCallbackQuery", async () => {
    const { calls, fetchFn } = recorder();
    const gateway = telegramGateway(TG_ENV, fetchFn);
    await gateway.answer("cb1", "C'est fait");
    await gateway.answer("cb2");
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:jeton-secret/answerCallbackQuery");
    expect(calls[0].body).toEqual({ callback_query_id: "cb1", text: "C'est fait" });
    expect(calls[1].body).toEqual({ callback_query_id: "cb2" });
  });

  it.each([400, 401, 403, 429, 500])("lève sur une réponse %i, sans le jeton ni la réponse", async (status) => {
    const { fetchFn } = recorder(() => new Response('{"ok":false,"description":"chat 42 introuvable"}', { status }));
    const gateway = telegramGateway(TG_ENV, fetchFn);
    for (const call of [() => gateway.send("42", "x"), () => gateway.edit("42", 1, "x"), () => gateway.answer("cb")]) {
      const error = (await call().catch((e: Error) => e)) as Error;
      expect(error.message).toBe(`Telegram a répondu ${status}`);
    }
  });

  it("lève quand le réseau échoue, sans l'adresse qui porte le jeton", async () => {
    const fetchFn = (async (url: string) => {
      throw new Error(`échec de ${url}`);
    }) as unknown as typeof fetch;
    const error = (await telegramGateway(TG_ENV, fetchFn).send("42", "x").catch((e: Error) => e)) as Error;
    expect(error.message).toBe("Telegram injoignable (Error)");
    expect(error.message).not.toContain("jeton-secret");
  });
});

describe("chatIds", () => {
  it.each([
    ["1", ["1"]],
    ["1,2", ["1", "2"]],
    [" 1 , -1002 ,, 3 ", ["1", "-1002", "3"]],
    ["", []],
    [" , ", []],
    [undefined, []],
  ])("lit %j", (raw, expected) => {
    expect(chatIds({ ...env, TELEGRAM_CHAT_IDS: raw } as Env)).toEqual(expected);
  });
});

describe("Turnstile réel", () => {
  const TS_ENV = { ...env, TURNSTILE_SECRET: "0x-secret-turnstile" } as Env;
  const reply = (body: unknown, status = 200) => async () => Response.json(body, { status });
  const verifier = (respond: () => Promise<Response>) => {
    const calls: { url: string; form: URLSearchParams; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, form: new URLSearchParams(init.body as URLSearchParams), init });
      return respond();
    }) as unknown as typeof fetch;
    return { calls, verify: turnstileVerifier(TS_ENV, fetchFn) };
  };

  it("répond pass quand siteverify dit success", async () => {
    const { calls, verify } = verifier(reply({ success: true }));
    expect(await verify("jeton-client", "203.0.113.5")).toBe("pass");
    expect(calls[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(calls[0].init.method).toBe("POST");
    expect(Object.fromEntries(calls[0].form)).toEqual({
      secret: "0x-secret-turnstile",
      response: "jeton-client",
      remoteip: "203.0.113.5",
    });
  });

  it("répond fail quand siteverify refuse le jeton", async () => {
    const { verify } = verifier(reply({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(await verify("jeton-client", null)).toBe("fail");
    expect(logged).not.toHaveBeenCalled();
  });

  it("répond fail sur une réponse sans success", async () => {
    expect(await verifier(reply({})).verify("t", null)).toBe("fail");
  });

  it("interroge siteverify même pour un jeton vide : un robot sans jeton obtient fail", async () => {
    const { calls, verify } = verifier(reply({ success: false, "error-codes": ["missing-input-response"] }));
    expect(await verify("", null)).toBe("fail");
    expect(calls).toHaveLength(1);
    expect(calls[0].form.get("response")).toBe("");
    expect(calls[0].form.has("remoteip")).toBe(false);
  });

  it.each([500, 502, 503])("répond unavailable sur une réponse %i", async (status) => {
    expect(await verifier(reply({ success: false }, status)).verify("t", null)).toBe("unavailable");
  });

  it("répond unavailable quand fetch lève", async () => {
    const { verify } = verifier(async () => {
      throw new Error("réseau");
    });
    expect(await verify("t", null)).toBe("unavailable");
  });

  it("répond unavailable quand la réponse n'est pas du JSON", async () => {
    expect(await verifier(async () => new Response("<html>")).verify("t", null)).toBe("unavailable");
  });

  it("ne consigne jamais le jeton ni le secret", async () => {
    const failing = verifier(async () => {
      throw new TypeError("échec avec jeton-client et 0x-secret-turnstile");
    });
    expect(await failing.verify("jeton-client", "203.0.113.5")).toBe("unavailable");
    expect(await verifier(reply({ success: false }, 503)).verify("jeton-client", "203.0.113.5")).toBe("unavailable");
    expect(await verifier(async () => new Response("jeton-client 0x-secret-turnstile")).verify("jeton-client", null)).toBe("unavailable");
    expect(logged).toHaveBeenCalled();
    for (const secret of ["jeton-client", "0x-secret-turnstile", "203.0.113.5"]) expect(logs()).not.toContain(secret);
  });

  it.each(["invalid-input-secret", "missing-input-secret"])(
    "répond unavailable, et le consigne sans citer le secret, quand siteverify refuse le secret du site (%s)",
    async (code) => {
      const { verify } = verifier(reply({ success: false, "error-codes": [code] }));
      expect(await verify("jeton-client", "203.0.113.5")).toBe("unavailable");
      expect(logged.mock.calls).toEqual([[`Turnstile : ${code}`]]);
      for (const secret of ["0x-secret-turnstile", "jeton-client", "203.0.113.5"]) expect(logs()).not.toContain(secret);
    },
  );

  it("répond unavailable quand le refus du secret s'accompagne d'autres codes", async () => {
    const { verify } = verifier(reply({ success: false, "error-codes": ["invalid-input-response", "invalid-input-secret"] }));
    expect(await verify("t", null)).toBe("unavailable");
  });

  it("répond fail, sans rien consigner, pour les autres codes d'erreur", async () => {
    for (const code of ["missing-input-response", "invalid-input-response", "timeout-or-duplicate", "bad-request"]) {
      expect(await verifier(reply({ success: false, "error-codes": [code] })).verify("t", null)).toBe("fail");
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("un secret refusé ne fait pas échouer la demande de bout en bout", async () => {
    const d = fakeDeps({ verifyTurnstile: turnstileVerifier(TS_ENV, (async () => Response.json({ success: false, "error-codes": ["invalid-input-secret"] })) as unknown as typeof fetch) });
    const background = createExecutionContext();
    const r = await handle(
      new Request("https://brotobooth.fr/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await requestBody({ turnstile_token: "" })),
      }),
      d,
      background,
    );
    await waitOnExecutionContext(background);
    expect(r.status).toBe(201);
  });
});

describe("makeDeps", () => {
  it("branche les vraies passerelles quand FAKE_GATEWAYS n'est pas 1", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return Response.json({ success: true, ok: true });
    });
    for (const FAKE_GATEWAYS of [undefined, "", "0", "true"]) {
      calls.length = 0;
      const real = makeDeps({ ...env, FAKE_GATEWAYS });
      expect(real.env.FAKE_GATEWAYS).toBe(FAKE_GATEWAYS);
      await real.email.send({ to: "a@example.test", subject: "s", text: "t", html: "h" });
      await real.telegram.send("1", "x");
      await real.telegram.edit("1", 2, "x");
      await real.telegram.answer("cb");
      expect(await real.verifyTurnstile("t", null)).toBe("pass");
      expect(calls.map((u) => new URL(u).host)).toEqual([
        "api.resend.com",
        "api.telegram.org",
        "api.telegram.org",
        "api.telegram.org",
        "challenges.cloudflare.com",
      ]);
    }
    expect(await getState(env.DB, "demo_messages")).toBeNull();
  });

  it("garde l'environnement tel quel hors des fausses passerelles", () => {
    expect(makeDeps(env).env).toBe(env);
  });
});

describe("fausses passerelles (FAKE_GATEWAYS=1)", () => {
  const FAKE = { ...env, FAKE_GATEWAYS: "1", OWNER_EMAIL: "", TELEGRAM_CHAT_IDS: "" } as Env;
  const stored = async () => JSON.parse((await getState(env.DB, "demo_messages")) ?? "[]") as Record<string, unknown>[];

  it("répondent pass à Turnstile et n'appellent aucun service", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const demo = makeDeps(FAKE);
    expect(await demo.verifyTurnstile("", null)).toBe("pass");
    await demo.email.send({ to: "a@example.test", subject: "s", text: "t", html: "h" });
    await demo.telegram.send("1", "x");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gardent chaque message avec son destinataire, son objet, son texte et ses boutons", async () => {
    const demo = makeDeps({ ...FAKE, FAKE_GATEWAYS: "1" });
    await demo.email.send({ to: "camille@example.test", subject: "Votre acompte", text: "Texte brut", html: "<p>Texte</p>" });
    await demo.telegram.send("42", "<b>Nouvelle demande</b>", [[{ text: "Valider", data: "v:1" }]]);
    const [telegramMessage, emailMessage] = await stored();
    expect(emailMessage).toMatchObject({ channel: "email", to: "camille@example.test", subject: "Votre acompte", text: "Texte brut" });
    expect(telegramMessage).toMatchObject({ channel: "telegram", to: "42", text: "Nouvelle demande", buttons: [[{ text: "Valider", data: "v:1" }]] });
    expect(typeof emailMessage.at).toBe("string");
  });

  it("ne gardent de Telegram que le texte : balises retirées, adresses des liens conservées, caractères décodés", async () => {
    const demo = makeDeps(FAKE);
    await demo.telegram.send("42", '<b>Acompte</b> de A&lt;b&gt; &amp; &quot;C&quot; &#39;D&#39;\n<a href="https://brotobooth.fr/admin#b1?x=1&amp;y=2">Ouvrir</a>');
    expect((await stored())[0].text).toBe('Acompte de A<b> & "C" \'D\'\nOuvrir (https://brotobooth.fr/admin#b1?x=1&y=2)');
  });

  it("gardent aussi les modifications de message et les réponses aux boutons", async () => {
    const demo = makeDeps(FAKE);
    await demo.telegram.edit("42", 7, "<b>Demande validée</b>");
    await demo.telegram.answer("cb1", "C'est fait");
    const [answer, edit] = await stored();
    expect(edit).toMatchObject({ channel: "telegram", to: "42", subject: "Message modifié", text: "Demande validée" });
    expect(answer).toMatchObject({ channel: "telegram", subject: "Réponse au bouton", text: "C'est fait" });
  });

  it("gardent les 50 derniers messages, le plus récent d'abord", async () => {
    const demo = makeDeps(FAKE);
    for (let i = 1; i <= 55; i++) await demo.email.send({ to: "a@example.test", subject: `Message ${i}`, text: "t", html: "h" });
    const messages = await stored();
    expect(messages).toHaveLength(50);
    expect(messages[0].subject).toBe("Message 55");
    expect(messages[49].subject).toBe("Message 6");
  });

  it("donnent au propriétaire des destinataires d'essai quand l'environnement n'en a pas", async () => {
    const demo = makeDeps(FAKE);
    expect(demo.env.OWNER_EMAIL).not.toBe("");
    expect(chatIds(demo.env)).toHaveLength(1);
    const b = await seeded({ status: "confirmed", hold_until: null });
    const old = { due_at: "2020-01-01T00:00:00.000Z" };
    await enqueue(env.DB, [mail("owner_d7", b.id, old), telegram("owner_d7", b.id, old)]);
    expect(await processDue(demo)).toEqual({ sent: 2, failed: 0 });
    expect((await stored()).map((m) => m.channel).sort()).toEqual(["email", "telegram"]);
  });

  it("gardent les adresses de l'environnement quand il en a", () => {
    const demo = makeDeps({ ...FAKE, OWNER_EMAIL: "moi@example.test", TELEGRAM_CHAT_IDS: "7" });
    expect(demo.env.OWNER_EMAIL).toBe("moi@example.test");
    expect(chatIds(demo.env)).toEqual(["7"]);
  });
});

describe("GET /demo", () => {
  const ctx = createExecutionContext();
  const demoDeps = (vars: Partial<Env> = { FAKE_GATEWAYS: "1" }) => fakeDeps({ env: { ...env, ...vars } });
  const seed = (messages: unknown[]) => setState(env.DB, "demo_messages", JSON.stringify(messages));
  const open = (d: Deps = demoDeps(), method = "GET") => handle(new Request("https://brotobooth.fr/demo", { method }), d, ctx);

  const email = (over: Record<string, unknown> = {}) => ({ at: T0, channel: "email", to: "camille@example.test", subject: "Votre acompte", text: "Bonjour", ...over });

  it.each([[undefined], [""], ["0"], ["true"], ["yes"]])("répond 404 quand FAKE_GATEWAYS vaut %j", async (value) => {
    await seed([email()]);
    const r = await open(demoDeps({ FAKE_GATEWAYS: value }));
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("camille@example.test");
  });

  it("n'accepte que GET", async () => {
    expect((await open(demoDeps(), "POST")).status).toBe(405);
  });

  it("affiche une page vide, avec une phrase, avant tout message", async () => {
    const r = await open();
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const body = await r.text();
    // La page d'essai du propriétaire n'est pas une page client : elle ne porte pas l'en-tête « Brotobooth » des pages /acompte.
    expect(body).not.toContain('<header class="site">');
    expect(body).toContain("Aucun message pour l'instant");
    expect(body).toContain('<meta name="robots" content="noindex">');
  });

  it("affiche le canal, le destinataire, l'objet et le texte de chaque message, le plus récent d'abord", async () => {
    await seed([
      email({ subject: "Plus récent", to: "recent@example.test" }),
      { at: T0, channel: "telegram", to: "42", subject: "", text: "Nouvelle demande\nClient : Camille" },
    ]);
    const body = await (await open()).text();
    expect(body).toContain("recent@example.test");
    expect(body).toContain("Plus récent");
    expect(body).toContain("E-mail");
    expect(body).toContain("Telegram");
    expect(body).toContain("Chat 42");
    expect(body).toContain("Nouvelle demande");
    expect(body.indexOf("Plus récent")).toBeLessThan(body.indexOf("Nouvelle demande"));
  });

  it("rend cliquables les seuls liens http et https vers BASE_URL", async () => {
    await seed([
      email({
        text: [
          "Payer : https://brotobooth.fr/acompte/jeton123.",
          "Autre : https://brotobooth.fr.pirate.example/acompte/x",
          "Piège : https://brotobooth.fr@pirate.example/x",
          "Ailleurs : https://example.org/page",
          "Clair : http://brotobooth.fr/acompte/y",
          "Script : javascript:alert(1)",
          "Admin : https://brotobooth.fr/admin#b-1?a=1&b=2",
        ].join("\n"),
      }),
    ]);
    const body = await (await open()).text();
    expect(body).toContain('<a href="https://brotobooth.fr/acompte/jeton123">https://brotobooth.fr/acompte/jeton123</a>.');
    expect(body).toContain('<a href="https://brotobooth.fr/admin#b-1?a=1&amp;b=2">');
    expect(body.match(/<a href="/g) ?? []).toHaveLength(2);
    for (const bad of ["pirate.example", "example.org", "http://brotobooth.fr/acompte/y", "javascript:alert(1)"]) {
      expect(body).toContain(bad);
      expect(body).not.toMatch(new RegExp(`href="[^"]*${bad.replace(/[.?()/:]/g, "\\$&")}`));
    }
  });

  it("affiche les boutons de Telegram en étiquettes ou en liens", async () => {
    await seed([
      {
        at: T0,
        channel: "telegram",
        to: "42",
        subject: "",
        text: "x",
        buttons: [
          [{ text: "Valider", data: "v:b1" }, { text: "Refuser", data: "r:b1" }],
          [{ text: "Ajuster le prix", url: "https://brotobooth.fr/admin#b1" }, { text: "Ailleurs", url: "https://example.org/x" }],
        ],
      },
    ]);
    const body = await (await open()).text();
    expect(body).toContain("Valider");
    expect(body).toContain("Refuser");
    expect(body).toMatch(/<a [^>]*href="https:\/\/brotobooth\.fr\/admin#b1"[^>]*>Ajuster le prix<\/a>/);
    expect(body).toContain("Ailleurs");
    expect(body).not.toContain('href="https://example.org/x"');
  });

  it("affiche échappé un message qui contient du HTML", async () => {
    const script = "<script>alert(1)</script>";
    await seed([
      email({ to: `"><img src=x onerror=alert(1)>`, subject: script, text: `Texte ${script} <img src=x onerror=alert(2)>` }),
      { at: T0, channel: "telegram", to: script, subject: "", text: script, buttons: [[{ text: script, url: `https://brotobooth.fr/"><script>` }, { text: script, data: script }]] },
    ]);
    const body = await (await open()).text();
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("ignore des messages gardés qui seraient illisibles", async () => {
    await setState(env.DB, "demo_messages", "pas du JSON");
    expect((await open()).status).toBe(200);
  });

  it("montre ce que le site enverrait à la suite d'une vraie demande, de bout en bout", async () => {
    const demo = makeDeps({ ...env, FAKE_GATEWAYS: "1", OWNER_EMAIL: "", TELEGRAM_CHAT_IDS: "" } as Env);
    const b = await seeded({ status: "awaiting_deposit" });
    const old = { due_at: "2020-01-01T00:00:00.000Z" };
    await enqueue(env.DB, [mail("client_deposit_link", b.id, old), telegram("owner_new_request", b.id, old), mail("owner_new_request", b.id, old)]);
    await processDue(demo);
    const body = await (await open(demo)).text();
    expect(body).toContain("Bonne nouvelle : nous pouvons être là le samedi 19 décembre 2026");
    expect(body).toContain(`<a href="https://brotobooth.fr/acompte/${b.token}">`);
    expect(body).toContain("Valider");
    expect(body).toContain("Camille Martin");
  });
});

describe("configuration du déploiement", () => {
  it("ne cite jamais FAKE_GATEWAYS dans wrangler.jsonc, et envoie /demo au Worker", () => {
    expect(wrangler).not.toContain("FAKE_GATEWAYS");
    expect(wrangler).toMatch(/"run_worker_first":\s*\[[^\]]*"\/demo"/);
  });
});
