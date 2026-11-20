import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { settleAlerts } from "../../worker/alerts";
import { ServiceRefusal } from "../../worker/http";
import { processDue } from "../../worker/notifications";
import { expireHold, refuseBooking, validateBooking } from "../../worker/operations";
import type { Booking } from "../../worker/repository";
import { telegramWebhook } from "../../worker/telegram";
import { alertRows, fakeDeps, request, resetDb, useDeposit, type FakeDeps } from "../support";

/**
 * L'alerte Telegram d'une demande (le message à boutons « Valider / Refuser ») suit la demande : dès qu'elle a reçu sa
 * réponse ailleurs que par ce message (administration, autre téléphone, expiration), il perd ses boutons et dit où elle
 * en est.
 */
useDeposit(0);

const CHATS = "111,222";
const SECRET = "secret-du-webhook";

let deps: FakeDeps;
let b: Booking;
let logged: MockInstance<Console["error"]>;

beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps({ env: { ...env, TELEGRAM_CHAT_IDS: CHATS, TELEGRAM_WEBHOOK_SECRET: SECRET } });
  b = await request();
  await processDue(deps); // l'alerte part dans les deux chats
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

/** Les alertes de la demande telles que le bot les a envoyées, une par chat. */
const sentAlerts = () => deps.telegrams.filter((m) => m.buttons?.flat().some((button) => button.data === `v:${b.id}`));

/** La base, sauf pour les requêtes qui correspondent à `pattern` : elles lèvent, comme une panne de D1. */
const brokenFor = (pattern: RegExp): D1Database =>
  ({
    prepare: (sql: string) => {
      if (pattern.test(sql)) throw new Error("D1 indisponible");
      return env.DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  }) as unknown as D1Database;

describe("retenir l'alerte d'une demande", () => {
  it("retient le message de chaque chat qui l'a reçu", async () => {
    const sent = sentAlerts();
    expect(sent.map((m) => m.chatId)).toEqual(["111", "222"]);
    expect(await alertRows()).toEqual(sent.map((m) => ({ chat_id: m.chatId, message_id: m.messageId, booking_id: b.id })));
  });

  it("ne retient ni les relances ni les autres messages du bot", async () => {
    deps.setNow("2026-11-08T10:05:00.000Z"); // la relance des 24 h est due
    await processDue(deps);
    expect(deps.telegrams.length).toBeGreaterThan(2);
    expect(await alertRows()).toHaveLength(2);
  });

  it("ne pas réussir à retenir l'alerte ne fait ni échouer ni renvoyer le message, qui est parti", async () => {
    await resetDb(env.DB);
    const d = fakeDeps({ env: { ...env, TELEGRAM_CHAT_IDS: CHATS, DB: brokenFor(/INTO telegram_alerts/) } });
    b = await request();
    expect(await processDue(d)).toMatchObject({ failed: 0 });
    expect(d.telegrams.filter((m) => m.buttons)).toHaveLength(2);
    await processDue(d);
    expect(d.telegrams.filter((m) => m.buttons)).toHaveLength(2);
    expect(await alertRows()).toEqual([]);
  });

  it("ne retient pas le message d'un chat qui n'a pas répondu, ni un envoi sans numéro de message", async () => {
    await resetDb(env.DB);
    const d = fakeDeps({ env: { ...env, TELEGRAM_CHAT_IDS: "111,222,333" } });
    d.telegram.send = async (chatId) => {
      if (chatId === "111") throw new Error("Telegram injoignable (Error)");
      return chatId === "222" ? null : 7;
    };
    b = await request();
    await processDue(d);
    expect(await alertRows()).toEqual([{ chat_id: "333", message_id: 7, booking_id: b.id }]);
  });
});

describe("mettre l'alerte à jour", () => {
  it("la laisse intacte tant que la demande attend sa réponse", async () => {
    await settleAlerts(deps);
    await processDue(deps);
    expect(deps.edits).toEqual([]);
    expect(await alertRows()).toHaveLength(2);
  });

  it.each([
    ["acceptée", (d: FakeDeps) => validateBooking(d, b.id, "owner"), "Confirmée"],
    ["refusée", (d: FakeDeps) => refuseBooking(d, b.id, "owner"), "Refusée"],
    ["expirée", (d: FakeDeps) => expireHold(d, b), "Expirée, la date est libérée"],
  ])("une demande %s ailleurs : chaque alerte perd ses boutons et dit où elle en est, au passage suivant", async (_what, act, line) => {
    const alerts = sentAlerts();
    await act(deps);
    await processDue(deps);

    expect(deps.edits.map((edit) => [edit.chatId, edit.messageId])).toEqual(alerts.map((m) => [m.chatId, m.messageId]));
    for (const edit of deps.edits) {
      expect(edit.buttons).toBeUndefined();
      expect(edit.html).toContain(b.client_name!);
      expect(edit.html.endsWith(`<b>${line}</b>`)).toBe(true);
    }
    expect(await alertRows()).toEqual([]);

    // Une alerte mise à jour ne l'est pas une seconde fois.
    await processDue(deps);
    expect(deps.edits).toHaveLength(2);
  });

  it("une panne de Telegram garde l'alerte pour le passage suivant, sans rien faire échouer", async () => {
    await validateBooking(deps, b.id, "owner");
    const edit = deps.telegram.edit;
    deps.telegram.edit = async () => {
      throw new Error("Telegram injoignable (Error)");
    };
    await expect(processDue(deps)).resolves.toMatchObject({ failed: 0 });
    expect(await alertRows()).toHaveLength(2);

    deps.telegram.edit = edit;
    await processDue(deps);
    expect(deps.edits).toHaveLength(2);
    expect(await alertRows()).toEqual([]);
  });

  it.each([
    ["500 : l'alerte est gardée pour le passage suivant", 500, 2],
    ["429 (trop de requêtes) : l'alerte est gardée", 429, 2],
    // Un jeton faux ou changé ne doit pas faire oublier les alertes : elles attendent qu'il soit corrigé.
    ["401 (jeton refusé) : l'alerte est gardée", 401, 2],
    ["404 (bot introuvable) : l'alerte est gardée", 404, 2],
    ["400 (message supprimé, ou déjà à jour) : il n'y a plus rien à tenter", 400, 0],
    ["403 (bot bloqué) : il n'y a plus rien à tenter", 403, 0],
  ])("Telegram répond %s", async (_what, status, kept) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await validateBooking(deps, b.id, "owner");
    deps.telegram.edit = async () => {
      throw new ServiceRefusal("Telegram", status);
    };
    await processDue(deps);
    expect(await alertRows()).toHaveLength(kept);
    // Une alerte abandonnée se lit dans les journaux, avec le code de Telegram ; une alerte gardée, comme une panne.
    const abandoned = warned.mock.calls.flat().join("\n");
    expect(abandoned.includes(`Telegram a répondu ${status}`)).toBe(kept === 0);
    expect(logged.mock.calls.flat().join("\n").includes(`Telegram a répondu ${status}`)).toBe(kept === 2);
    warned.mockRestore();
  });

  it("une panne dans un chat n'empêche pas de mettre l'autre à jour", async () => {
    await validateBooking(deps, b.id, "owner");
    const edit = deps.telegram.edit;
    deps.telegram.edit = async (chatId, ...rest) => {
      if (chatId === "111") throw new ServiceRefusal("Telegram", 500);
      return edit(chatId, ...rest);
    };
    await processDue(deps);
    expect(deps.edits.map((e) => e.chatId)).toEqual(["222"]);
    expect((await alertRows()).map((row) => row.chat_id)).toEqual(["111"]);
  });

  it("ne consigne ni le nom ni le téléphone du client, même si la panne les cite", async () => {
    await validateBooking(deps, b.id, "owner");
    deps.telegram.edit = async () => {
      throw new Error(`échec pour ${b.client_name} (${b.client_phone})`);
    };
    await processDue(deps);
    const logs = logged.mock.calls.flat().join("\n");
    expect(logs).toContain("Alerte Telegram");
    expect(logs).not.toContain(b.client_name!);
    expect(logs).not.toContain(b.client_phone!);
  });

  it("une base en panne sur les alertes ne fait échouer ni l'envoi des messages ni la tâche", async () => {
    await validateBooking(deps, b.id, "owner");
    deps.env = { ...deps.env, DB: brokenFor(/FROM telegram_alerts/) };
    await expect(processDue(deps)).resolves.toMatchObject({ failed: 0 });
    expect(logged.mock.calls.flat().join("\n")).toContain("Alerte Telegram");
  });
});

describe("mettre l'alerte à jour, avec un acompte", () => {
  useDeposit(25);

  it("une demande acceptée annonce l'acompte attendu", async () => {
    await resetDb(env.DB);
    const d = fakeDeps();
    b = await request();
    await processDue(d);
    await validateBooking(d, b.id, "owner");
    await processDue(d);
    expect(d.edits).toHaveLength(1);
    expect(d.edits[0].html.endsWith("<b>Validée, acompte attendu</b>")).toBe(true);
  });
});

describe("répondre par un bouton du bot", () => {
  /** Le propriétaire touche le bouton `data` du message `message`. Ce qui part après la réponse est attendu. */
  async function tap(data: string, message: FakeDeps["telegrams"][number]): Promise<void> {
    const body = JSON.stringify({
      update_id: 1,
      callback_query: { id: "cb", data, message: { message_id: message.messageId, chat: { id: Number(message.chatId) } } },
    });
    const background = createExecutionContext();
    const headers = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
    await telegramWebhook(new Request("https://brotobooth.fr/api/telegram/webhook", { method: "POST", headers, body }), deps, background);
    await waitOnExecutionContext(background);
  }

  it("le message touché est mis à jour une fois, et l'alerte de l'autre chat le suit", async () => {
    const [mine, other] = sentAlerts();
    await tap(`v:${b.id}`, mine);

    expect(deps.edits.map((edit) => [edit.chatId, edit.messageId]).sort()).toEqual([
      [mine.chatId, mine.messageId],
      [other.chatId, other.messageId],
    ]);
    // Le message touché annonce que le client est prévenu ; l'autre, où en est la demande.
    expect(deps.edits.find((edit) => edit.chatId === mine.chatId)!.html.endsWith("<b>Confirmée, le client en est informé</b>")).toBe(true);
    expect(deps.edits.find((edit) => edit.chatId === other.chatId)!.html.endsWith("<b>Confirmée</b>")).toBe(true);
    expect(await alertRows()).toEqual([]);
  });

  it("demander confirmation du refus garde l'alerte : elle suit encore la demande", async () => {
    const [mine] = sentAlerts();
    await tap(`r:${b.id}`, mine);
    expect(deps.edits).toHaveLength(1);
    expect(deps.edits[0].buttons).toBeDefined();
    expect(await alertRows()).toHaveLength(2);

    // La demande est acceptée depuis l'administration : le message qui demandait confirmation est mis à jour lui aussi.
    await validateBooking(deps, b.id, "owner");
    await processDue(deps);
    expect(deps.edits.filter((edit) => edit.html.endsWith("<b>Confirmée</b>"))).toHaveLength(2);
    expect(await alertRows()).toEqual([]);
  });

  it("une base en panne sur les alertes n'empêche pas de mettre à jour le message touché", async () => {
    const [mine] = sentAlerts();
    deps.env = { ...deps.env, DB: brokenFor(/telegram_alerts/) };
    await tap(`v:${b.id}`, mine);
    expect(deps.edits.map((edit) => [edit.chatId, edit.messageId])).toEqual([[mine.chatId, mine.messageId]]);
    expect(deps.edits[0].html.endsWith("<b>Confirmée, le client en est informé</b>")).toBe(true);
  });

  it("si Telegram ne modifie pas le message touché, il reste retenu et sera repris", async () => {
    const [mine] = sentAlerts();
    const edit = deps.telegram.edit;
    deps.telegram.edit = async () => {
      throw new ServiceRefusal("Telegram", 500);
    };
    await tap(`v:${b.id}`, mine);
    expect(await alertRows()).toHaveLength(2);

    deps.telegram.edit = edit;
    await processDue(deps);
    expect(deps.edits.map((e) => e.chatId).sort()).toEqual(["111", "222"]);
    expect(await alertRows()).toEqual([]);
  });
});
