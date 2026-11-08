import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { processDue } from "../../worker/notifications";
import { expireHold, validateBooking } from "../../worker/operations";
import { getBooking, listUnavailableDates, type Booking } from "../../worker/repository";
import { handle } from "../../worker/router";
import { telegramWebhook } from "../../worker/telegram";
import { renderTelegram } from "../../worker/templates";
import { CHAT_ID, fakeDeps, notificationRows, request, resetDb, type FakeDeps } from "../support";

const URL_WEBHOOK = "https://brotobooth.fr/api/telegram/webhook";
const HEADER = "X-Telegram-Bot-Api-Secret-Token";
const SECRET = "secret-du-webhook";

let deps: FakeDeps;
let b: Booking;
/** Le message que le bot a envoyé au propriétaire pour `b`, tel qu'il le lit. */
let ownerMessage: FakeDeps["telegrams"][number];
let logged: MockInstance<Console["error"]>;

beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps({ env: { ...env, TELEGRAM_WEBHOOK_SECRET: SECRET } });
  b = await request();
  // La demande a déjà été annoncée : les tests ne comptent que ce que les boutons font partir.
  await processDue(deps);
  ownerMessage = deps.telegrams[0];
  deps.emails.length = 0;
  deps.telegrams.length = 0;
  // Les pannes que les tests provoquent sont consignées : on les capte pour garder la sortie nette.
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

const logs = () => logged.mock.calls.flat().join("\n");

/** Un envoi à `telegramWebhook`. Ce qui part après la réponse (le lien du client) est attendu avant de rendre la main. */
async function send(body: string, headers: Record<string, string> = { [HEADER]: SECRET }): Promise<Response> {
  const background = createExecutionContext();
  const response = await telegramWebhook(new Request(URL_WEBHOOK, { method: "POST", headers, body }), deps, background);
  await waitOnExecutionContext(background);
  return response;
}

const update = (data: unknown, chat: number | string = 111) =>
  JSON.stringify({ update_id: 1, callback_query: { id: "cb", data, message: { message_id: 9, chat: { id: chat } } } });

/** Le propriétaire touche un bouton : `data` est la donnée du bouton, `chat` le chat où il le touche. */
const tap = (data: string, chat: number | string = 111, secret: string = SECRET) =>
  send(update(data, chat), { [HEADER]: secret });

const status = async () => (await getBooking(env.DB, b.id))!.status;
const pending = async () => (await notificationRows()).filter((n) => n.sent_at === null && n.cancelled_at === null);
const lastEdit = () => deps.edits.at(-1)!;
const toast = () => deps.answerTexts.at(-1);
/** Les e-mails au client par modèle : `client_deposit_link` et `client_refused` ont chacun un objet reconnaissable. */
const toClient = () => deps.emails.filter((m) => m.to === b.client_email);
const buttonsOf = (edit: { buttons: { data?: string; url?: string }[][] | undefined }) => edit.buttons?.flat().map((x) => x.data ?? x.url);

/** Rien n'a bougé : ni la réservation, ni la file, ni un message envoyé, ni le message du bot modifié. */
async function expectUntouched(statusBefore = "pending_review") {
  expect(await status()).toBe(statusBefore);
  expect(deps.edits).toEqual([]);
  expect(deps.emails).toEqual([]);
  expect(deps.telegrams).toEqual([]);
}

describe("telegramWebhook : valider", () => {
  it("Valider envoie le lien au client et met à jour le message", async () => {
    const valider = ownerMessage.buttons![0][0]; // le bouton que le bot a réellement envoyé
    expect(valider.text).toBe("Valider");
    expect((await tap(valider.data!)).status).toBe(200);

    const booking = (await getBooking(env.DB, b.id))!;
    expect(booking.status).toBe("awaiting_deposit");
    expect(toClient().map((m) => m.subject)).toEqual(["Votre acompte pour le samedi 19 décembre 2026"]);
    expect(toClient()[0].text).toContain(`/acompte/${booking.token}`);
    expect(deps.answers).toEqual(["cb"]);
    expect(toast()).toMatch(/Validée/);
    expect(deps.edits).toHaveLength(1);
    expect(lastEdit()).toMatchObject({ chatId: CHAT_ID, messageId: 9 });
    expect(lastEdit().html).toContain("Validée");
    expect(lastEdit().buttons).toBeUndefined();
  });

  it("le message modifié garde le texte de la demande, sans l'échéance de réponse", async () => {
    await tap(`v:${b.id}`);
    const original = renderTelegram("owner_new_request", { ...b, hold_until: null }, { baseUrl: deps.env.BASE_URL }).html;
    expect(lastEdit().html.startsWith(original)).toBe(true);
    expect(lastEdit().html).toContain("Nouvelle demande pour le samedi 19 décembre 2026");
    expect(lastEdit().html).not.toContain("la date sera libérée");
  });

  it("toucher Valider deux fois n'envoie rien de plus", async () => {
    await tap(`v:${b.id}`);
    const before = await pending();
    const mails = deps.emails.length;
    await tap(`v:${b.id}`);
    expect(await pending()).toEqual(before);
    expect(deps.emails).toHaveLength(mails);
    expect(deps.answers).toEqual(["cb", "cb"]);
    expect(toast()).toMatch(/déjà traitée/i);
    expect(lastEdit().html).toContain("Validée");
    expect(lastEdit().buttons).toBeUndefined();
  });

  it("deux appuis simultanés n'envoient le lien qu'une fois", async () => {
    await Promise.all([tap(`v:${b.id}`), tap(`v:${b.id}`)]);
    expect(toClient().filter((m) => m.subject.startsWith("Votre acompte"))).toHaveLength(1);
    expect(deps.answerTexts.filter((t) => /déjà traitée/i.test(t ?? ""))).toHaveLength(1);
  });

  it("toucher Valider après l'expiration ne ressuscite pas la demande", async () => {
    await expireHold(deps, b);
    await tap(`v:${b.id}`);
    expect(await status()).toBe("expired");
    expect(toast()).toMatch(/plus disponible/i);
    expect(lastEdit().html).toContain("Expirée");
    expect(lastEdit().buttons).toBeUndefined();
    expect(deps.emails).toEqual([]); // les messages de libération restent en file : l'appui n'envoie rien
  });
});

describe("telegramWebhook : refuser", () => {
  it("Refuser demande d'abord confirmation et ne change rien", async () => {
    const before = await notificationRows();
    await tap(`r:${b.id}`);
    expect(await status()).toBe("pending_review");
    expect(await notificationRows()).toEqual(before);
    expect(deps.emails).toEqual([]);
    expect(buttonsOf(lastEdit())).toEqual([`rc:${b.id}`, `x:${b.id}`]);
    expect(lastEdit().html).toContain("Nouvelle demande pour le samedi 19 décembre 2026");
    expect(lastEdit().html).toContain("Refuser cette demande ?");
    expect(deps.answers).toEqual(["cb"]);
  });

  it("confirmer le refus libère la date et prévient le client", async () => {
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toContain("2026-12-19");
    await tap(`r:${b.id}`);
    await tap(`rc:${b.id}`);
    expect(await status()).toBe("refused");
    expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).not.toContain("2026-12-19");
    expect(toClient().map((m) => m.text)).toEqual([expect.stringContaining("ne pouvons malheureusement pas assurer")]);
    expect(lastEdit().html).toContain("Refusée");
    expect(lastEdit().buttons).toBeUndefined();
    expect(toast()).toMatch(/Refusée/);
  });

  it("toucher Confirmer deux fois n'envoie rien de plus", async () => {
    await tap(`rc:${b.id}`);
    const mails = deps.emails.length;
    const before = await notificationRows();
    await tap(`rc:${b.id}`);
    expect(deps.emails).toHaveLength(mails);
    expect(await notificationRows()).toEqual(before);
    expect(toast()).toMatch(/déjà traitée/i);
  });

  it("Renoncer remet les boutons d'origine", async () => {
    const before = await notificationRows();
    await tap(`r:${b.id}`);
    await tap(`x:${b.id}`);
    expect(await status()).toBe("pending_review");
    expect(await notificationRows()).toEqual(before);
    const original = renderTelegram("owner_new_request", b, { baseUrl: deps.env.BASE_URL });
    expect(lastEdit().html).toBe(original.html);
    expect(lastEdit().buttons).toEqual(original.buttons);
    expect(lastEdit().buttons!.flat()).toHaveLength(3);
    expect(lastEdit().buttons).toEqual(ownerMessage.buttons);
  });

  it("refuser une demande déjà validée ne la refuse pas et ne prévient personne", async () => {
    await validateBooking(deps, b.id, "owner"); // validée depuis l'administration, le message du bot reste affiché
    const before = await notificationRows();

    await tap(`rc:${b.id}`);
    expect(await status()).toBe("awaiting_deposit");
    expect(await notificationRows()).toEqual(before);
    expect(deps.emails).toEqual([]);
    expect(toast()).toMatch(/déjà traitée/i);
    expect(lastEdit().html).toContain("Validée");
    expect(lastEdit().buttons).toBeUndefined();
  });

  it("demander le refus ou renoncer sur une demande déjà traitée n'offre plus de boutons", async () => {
    await validateBooking(deps, b.id, "owner");
    for (const data of [`r:${b.id}`, `x:${b.id}`]) {
      await tap(data);
      expect(toast()).toMatch(/déjà traitée/i);
      expect(lastEdit().buttons).toBeUndefined();
      expect(lastEdit().html).not.toContain("Refuser cette demande ?");
    }
    expect(await status()).toBe("awaiting_deposit");
  });

  it("une demande libérée n'est plus disponible, quel que soit le bouton touché", async () => {
    await expireHold(deps, b);
    for (const data of [`r:${b.id}`, `rc:${b.id}`, `x:${b.id}`]) {
      await tap(data);
      expect(toast()).toMatch(/plus disponible/i);
      expect(lastEdit().buttons).toBeUndefined();
    }
    expect(await status()).toBe("expired");
    expect(deps.emails).toEqual([]);
  });
});

describe("telegramWebhook : qui peut agir", () => {
  it("ignore un chat non autorisé", async () => {
    const before = await notificationRows();
    const response = await tap(`v:${b.id}`, 999);
    expect(response.status).toBe(200);
    await expectUntouched();
    expect(await notificationRows()).toEqual(before);
    // Le bouton cesse de tourner, sans rien dire à ce chat.
    expect(deps.answers).toEqual(["cb"]);
    expect(toast()).toBeUndefined();
    expect(logs()).toContain("chat non autorisé");
    expect(logs()).not.toContain("999");
  });

  it("aucun des quatre boutons n'agit depuis un chat non autorisé", async () => {
    for (const code of ["v", "r", "rc", "x"]) await tap(`${code}:${b.id}`, 999);
    await expectUntouched();
  });

  it("accepte chacun des chats du propriétaire, groupe compris", async () => {
    deps.env.TELEGRAM_CHAT_IDS = "222, -100333";
    await tap(`r:${b.id}`, -100333);
    expect(buttonsOf(lastEdit())).toEqual([`rc:${b.id}`, `x:${b.id}`]);
    expect(lastEdit().chatId).toBe("-100333");
    await tap(`v:${b.id}`, "222");
    expect(await status()).toBe("awaiting_deposit");
  });

  it("n'accepte aucun chat quand le propriétaire n'en a configuré aucun", async () => {
    deps.env.TELEGRAM_CHAT_IDS = "";
    await tap(`v:${b.id}`, "");
    await tap(`v:${b.id}`, 0);
    await expectUntouched();
  });
});

describe("telegramWebhook : le secret", () => {
  it("rejette un mauvais secret", async () => {
    const response = await tap(`v:${b.id}`, 111, "faux");
    expect(response.status).toBe(401);
    await expectUntouched();
    expect(deps.answers).toEqual([]);
  });

  it("rejette un secret absent comme un secret faux", async () => {
    expect((await send(update(`v:${b.id}`), {})).status).toBe(401);
    expect((await send(update(`v:${b.id}`), { [HEADER]: "" })).status).toBe(401);
    await expectUntouched();
    expect(deps.answers).toEqual([]);
  });

  it("rejette un secret qui n'en est qu'un début, une suite ou une variante", async () => {
    for (const secret of [SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), SECRET.replace("-", "_"), `${SECRET.slice(0, -1)}!`]) {
      expect((await tap(`v:${b.id}`, 111, secret)).status).toBe(401);
    }
    await expectUntouched();
  });

  it("n'ouvre pas la porte quand le secret du site n'est pas configuré", async () => {
    deps.env.TELEGRAM_WEBHOOK_SECRET = "";
    expect((await send(update(`v:${b.id}`), {})).status).toBe(401);
    expect((await send(update(`v:${b.id}`), { [HEADER]: "" })).status).toBe(401);
    expect((await tap(`v:${b.id}`, 111, "n'importe quoi")).status).toBe(401);
    await expectUntouched();
  });

  it("consigne le refus sans écrire aucun des deux secrets", async () => {
    await tap(`v:${b.id}`, 111, "secret-essaye-par-un-inconnu");
    expect(logs()).toContain("Webhook Telegram refusé");
    expect(logs()).not.toContain("secret-essaye-par-un-inconnu");
    expect(logs()).not.toContain(SECRET);
  });

  it("répond 200 à un secret correct", async () => {
    expect((await tap(`x:${b.id}`)).status).toBe(200);
  });
});

describe("telegramWebhook : ce qu'il ignore", () => {
  it("ignore une donnée inconnue et un identifiant inconnu sans erreur", async () => {
    expect((await tap("nimporte")).status).toBe(200);
    expect(deps.answers).toEqual(["cb"]);
    expect(toast()).toBeUndefined();

    expect((await tap("v:inconnu")).status).toBe(200);
    expect(deps.answers).toEqual(["cb", "cb"]);
    expect(toast()).toMatch(/plus disponible/i);
    await expectUntouched();
  });

  it("ne lit une donnée que si elle est de la forme d'un bouton du bot", async () => {
    for (const data of ["constructor:x", "__proto__:x", "toString:x", "hasOwnProperty:x", "V:" + b.id, "v", "v:", ":", "", `${b.id}`, ` v:${b.id}`]) {
      expect((await tap(data)).status).toBe(200);
    }
    await expectUntouched();
  });

  it("un corps qui n'est pas du JSON ne fait rien et répond 200", async () => {
    expect((await send("pas du json")).status).toBe(200);
    expect((await send("")).status).toBe(200);
    expect((await send('{"update_id": 1, "callback_query": ')).status).toBe(200);
    await expectUntouched();
    expect(deps.answers).toEqual([]);
  });

  it("une mise à jour sans bouton touché ne fait rien et répond 200", async () => {
    const bodies = [
      { update_id: 1, message: { message_id: 1, chat: { id: 111 }, text: "bonjour" } },
      { update_id: 1 },
      {},
      null,
      [],
      42,
      "texte",
    ];
    for (const body of bodies) expect((await send(JSON.stringify(body))).status).toBe(200);
    await expectUntouched();
    expect(deps.answers).toEqual([]);
  });

  it("un bouton touché de forme inattendue ne fait rien et répond 200", async () => {
    const message = { message_id: 9, chat: { id: 111 } };
    const queries = [
      { id: "cb", data: `v:${b.id}` }, // pas de message (message en ligne)
      { id: "cb", data: `v:${b.id}`, message: { chat: { id: 111 } } },
      { id: "cb", data: `v:${b.id}`, message: { message_id: 9 } },
      { id: "cb", data: `v:${b.id}`, message: { message_id: 9, chat: { id: { x: 1 } } } },
      { id: "cb", data: 5, message },
      { id: "cb", message },
      { id: 7, data: `v:${b.id}`, message },
      { data: `v:${b.id}`, message },
      "v",
    ];
    for (const callback_query of queries) expect((await send(JSON.stringify({ update_id: 1, callback_query }))).status).toBe(200);
    await expectUntouched();
    expect(deps.answers).toEqual([]);
  });

  it("un corps démesuré ne fait rien et répond 200", async () => {
    const huge = JSON.stringify({ update_id: 1, padding: "x".repeat(80 * 1024) });
    expect((await send(huge)).status).toBe(200);
    await expectUntouched();
  });
});

describe("telegramWebhook : quand Telegram est en panne", () => {
  it("une réponse qui échoue n'annule pas la validation et ne fait pas échouer le webhook", async () => {
    deps.telegram.answer = async () => {
      throw new Error("Telegram a répondu 500");
    };
    expect((await tap(`v:${b.id}`)).status).toBe(200);
    expect(await status()).toBe("awaiting_deposit");
    expect(toClient()).toHaveLength(1);
    expect(deps.edits).toHaveLength(1); // le message est quand même modifié
    expect(logs()).toContain("Telegram a répondu 500");
  });

  it("un message qui ne se modifie pas n'annule pas le refus et ne fait pas échouer le webhook", async () => {
    deps.telegram.edit = async () => {
      throw new Error("Telegram a répondu 400");
    };
    expect((await tap(`rc:${b.id}`)).status).toBe(200);
    expect(await status()).toBe("refused");
    expect(toClient()).toHaveLength(1);
    expect(deps.answers).toEqual(["cb"]); // le bouton cesse quand même de tourner
    expect(logs()).toContain("Telegram a répondu 400");
  });

  it("ne consigne ni le nom ni le téléphone du client", async () => {
    deps.telegram.answer = async () => {
      throw new Error("Telegram a répondu 500");
    };
    await tap(`v:${b.id}`);
    expect(logs()).not.toContain("Camille");
    expect(logs()).not.toContain(b.client_phone!);
    expect(logs()).not.toContain(b.client_email!);
  });
});

describe("telegramWebhook : par le routeur", () => {
  const call = async (method: string, headers: Record<string, string> = { [HEADER]: SECRET }) => {
    const background = createExecutionContext();
    const response = await handle(new Request(URL_WEBHOOK, { method, headers, body: method === "GET" ? undefined : update(`v:${b.id}`) }), deps, background);
    await waitOnExecutionContext(background);
    return response;
  };

  it("POST /api/telegram/webhook valide la demande", async () => {
    expect((await call("POST")).status).toBe(200);
    expect(await status()).toBe("awaiting_deposit");
    expect(toClient()).toHaveLength(1);
  });

  it("refuse un mauvais secret, ne répond pas au GET", async () => {
    expect((await call("POST", { [HEADER]: "faux" })).status).toBe(401);
    expect(await status()).toBe("pending_review");
    const get = await call("GET");
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
  });
});
