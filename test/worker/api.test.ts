import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../../worker/bookings";
import type { Deps, EmailMessage } from "../../worker/deps";
import { processDue } from "../../worker/notifications";
import { currentTier, offer, priceOf, pricesBody } from "../../worker/offer";
import { countTakenByTier, listRange } from "../../worker/repository";
import { handle } from "../../worker/router";
import {
  CHAT_ID,
  FIRST_PLAN,
  OWNER_EMAIL,
  SECOND_PLAN,
  T0,
  depositFor,
  fakeDeps,
  notificationRows,
  requestBody,
  resetDb,
  testTier,
  useTiers,
  type FakeDeps,
} from "../support";

const ctx = createExecutionContext();
const IP = "203.0.113.5";
const OTHER_IP = "198.51.100.7";
const MAX_BODY = 16 * 1024;

let deps: FakeDeps;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
});

/**
 * Un envoi d'un formulaire public à `path`. `ip: null` : requête sans l'en-tête de Cloudflare. L'envoi immédiat des
 * messages se fait après la réponse : le test l'attend, pour qu'aucun envoi ne déborde sur le test suivant.
 */
const sendTo =
  (path: string) =>
  async (raw: BodyInit | null, d: Deps = deps, ip: string | null = IP, headers: Record<string, string> = {}) => {
    const background = createExecutionContext();
    const response = await handle(
      new Request(`https://brotobooth.fr${path}`, {
        method: "POST",
        body: raw,
        headers: { "Content-Type": "application/json", ...(ip === null ? {} : { "CF-Connecting-IP": ip }), ...headers },
      }),
      d,
      background,
    );
    await waitOnExecutionContext(background);
    return response;
  };
const send = sendTo("/api/requests");
const post = (b: unknown, d: Deps = deps, ip: string | null = IP) => send(JSON.stringify(b), d, ip);
const get = (path: string, d: Deps = deps) => handle(new Request(`https://brotobooth.fr${path}`), d, ctx);

type Reply = { error?: string; status?: string; fields?: string[] };
const reply = (r: Response) => r.json<Reply>();
const stored = () => listRange(env.DB, "2026-01-01", "2030-12-31");

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("POST /api/requests : enregistrement", () => {
  it("enregistre la demande, tient la date 72 h et planifie les alertes", async () => {
    const input = await requestBody();
    const r = await post(input);
    expect(r.status).toBe(201);
    expect(await reply(r)).toEqual({ status: "created" });
    const [b] = await listRange(env.DB, "2026-12-19", "2026-12-19");
    expect(b.status).toBe("pending_review");
    expect(b.source).toBe("site");
    expect(b.hold_until).toBe("2026-11-10T10:00:00.000Z");
    expect(b.terms_version).toBe("2026-11-07");
    expect(b.price_cents).toBe(input.price_cents);
    expect(b.deposit_cents).toBe(depositFor(input.price_cents as number));
    expect(b.created_at).toBe(T0);
    expect((await notificationRows()).map((n) => `${n.template}|${n.channel}`).sort()).toEqual([
      "client_received|email",
      "owner_new_request|email",
      "owner_new_request|telegram",
      "owner_review_reminder|telegram",
      "owner_review_reminder|telegram",
    ]);
  });

  it("calcule le prix et l'acompte d'après la formule", async () => {
    useTiers(testTier("seul", 50_000));
    const [only] = offer.tiers;
    const price = priceOf(only, SECOND_PLAN.id);
    expect(price).not.toBe(priceOf(only, FIRST_PLAN.id));
    await post(await requestBody({ plan: SECOND_PLAN.id }));
    const [b] = await stored();
    expect(b).toMatchObject({ plan: SECOND_PLAN.id, price_cents: price, deposit_cents: depositFor(price) });
  });

  it("enregistre les champs rognés, l'e-mail en minuscules, et sans message un message vide", async () => {
    await post(await requestBody({
      name: "  Camille Durand ", venue: " Salle des fêtes\n", event_hours: " 19 h - 1 h ", phone: " 06 12 34 56 78 ",
      email: "  CAMILLE@Example.test ", event_type: " Mariage ", plan: ` ${FIRST_PLAN.id} `, date: " 2026-12-19 ",
    }));
    const [b] = await stored();
    expect(b).toMatchObject({
      client_name: "Camille Durand", venue: "Salle des fêtes", event_hours: "19 h - 1 h", client_phone: "06 12 34 56 78",
      client_email: "camille@example.test", event_type: "Mariage", plan: FIRST_PLAN.id, event_date: "2026-12-19",
      message: null,
    });
  });

  it("garde le message tel quel, retours à la ligne et caractères spéciaux compris", async () => {
    const message = "Un fond <b>rose</b> & des ballons ;\n« merci », 🎉";
    await post(await requestBody({ message: `  ${message}  ` }));
    expect((await stored())[0].message).toBe(message);
  });

  it("donne à chaque demande un identifiant et un jeton de 256 bits que la réponse ne dévoile pas", async () => {
    const first = await post(await requestBody());
    await post(await requestBody({ date: "2026-12-20", email: "autre@example.test" }));
    const [a, b] = await stored();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(await reply(first))).not.toContain(a.token);
  });

  it("répond date_taken si un autre client a pris la date", async () => {
    await post(await requestBody());
    const r = await post(await requestBody({ email: "autre@example.test" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "date_taken" });
    expect(await stored()).toHaveLength(1);
  });

  it("traite un second envoi identique comme une réussite", async () => {
    await post(await requestBody());
    const r = await post(await requestBody({ email: "CAMILLE@example.test " }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "already_requested" });
    expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toHaveLength(1);
  });

  it("traite deux envois identiques simultanés comme une réussite, jamais comme une date prise", async () => {
    const input = await requestBody();
    const replies = await Promise.all([post(input), post(input)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await stored()).toHaveLength(1);
  });

  it("répond date_taken à deux clients différents qui se disputent la date en même temps", async () => {
    const [mine, theirs] = [await requestBody(), await requestBody({ email: "autre@example.test" })];
    const replies = await Promise.all([post(mine), post(theirs)]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stored()).toHaveLength(1);
  });

  it("envoie tout de suite l'accusé au client et l'alerte au propriétaire", async () => {
    expect((await post(await requestBody())).status).toBe(201);
    expect(deps.emails.map((m) => [m.to, m.subject])).toEqual(
      expect.arrayContaining([
        ["camille@example.test", "Nous avons bien reçu votre demande pour le samedi 19 décembre 2026"],
        [OWNER_EMAIL, "Nouvelle demande pour le samedi 19 décembre 2026"],
      ]),
    );
    expect(deps.emails).toHaveLength(2);
    expect(deps.telegrams).toHaveLength(1);
    expect(deps.telegrams[0].chatId).toBe(CHAT_ID);
    expect(deps.telegrams[0].buttons!.flat().map((b) => b.text)).toEqual(["Valider", "Refuser", "Ajuster le prix"]);
    // Les rappels de 24 h et de 48 h ne sont pas dus : ils attendent la tâche automatique.
    const rows = await notificationRows();
    expect(rows.filter((n) => n.sent_at !== null)).toHaveLength(3);
    expect(rows.filter((n) => n.template === "owner_review_reminder").every((n) => n.sent_at === null)).toBe(true);
  });

  it("ne perd pas la demande si l'envoi immédiat échoue", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = fakeDeps();
      const send = vi.fn(async (_m: EmailMessage) => {
        throw new Error("panne");
      });
      d.email.send = send;
      d.telegram.send = vi.fn(async () => {
        throw new Error("panne");
      });
      expect((await post(await requestBody(), d)).status).toBe(201);
      expect(await stored()).toHaveLength(1);
      // L'envoi a bien été tenté, pour l'accusé comme pour l'alerte du propriétaire.
      expect(send).toHaveBeenCalled();
      expect(send.mock.calls.map(([m]) => m.to)).toEqual(expect.arrayContaining(["camille@example.test", OWNER_EMAIL]));
      expect(d.telegram.send).toHaveBeenCalledTimes(1);
      // Rien n'est perdu : tout reste en file pour la tâche automatique.
      expect((await notificationRows()).filter((n) => n.sent_at === null)).not.toHaveLength(0);
      expect(log.mock.calls.every(([line]) => /^Notification \d+ \(\w+\) : Error$/.test(String(line)))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("reprend à la tâche automatique ce que l'envoi immédiat n'a pas pu envoyer", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = fakeDeps();
      const down = d.email.send;
      d.email.send = async () => {
        throw new Error("panne");
      };
      await post(await requestBody(), d);
      expect(d.emails).toHaveLength(0);
      d.email.send = down;
      d.setNow("2026-11-07T10:05:00.000Z");
      await processDue(d);
      expect(d.emails.map((m) => m.subject)).toEqual(
        expect.arrayContaining(["Nous avons bien reçu votre demande pour le samedi 19 décembre 2026", "Nouvelle demande pour le samedi 19 décembre 2026"]),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("n'envoie rien quand la demande n'est pas enregistrée", async () => {
    await post(await requestBody());
    const sent = deps.emails.length + deps.telegrams.length;
    await post(await requestBody()); // la même demande : déjà enregistrée
    await post(await requestBody({ email: "autre@example.test" })); // la date vient d'être prise
    await post(await requestBody({ date: "2026-12-20", name: "" })); // un champ refusé
    const robot = fakeDeps({ verifyTurnstile: async () => "fail" });
    await post(await requestBody({ date: "2026-12-21", email: "robot@example.test" }), robot);
    expect(deps.emails.length + deps.telegrams.length).toBe(sent);
    expect(robot.emails).toHaveLength(0);
    expect(robot.telegrams).toHaveLength(0);
  });
});

describe("POST /api/requests : limites", () => {
  it("limite à 2 demandes actives par e-mail, sans tenir compte de la casse", async () => {
    await post(await requestBody({ date: "2026-12-19" }));
    await post(await requestBody({ date: "2026-12-20" }));
    const third = await post(await requestBody({ date: "2026-12-21", email: "Camille@Example.test" }));
    expect(third.status).toBe(429);
    // La page dit « vous avez déjà plusieurs demandes en cours » : vrai pour cette raison-là seulement.
    expect(await third.json()).toEqual({ error: "too_many", reason: "email" });
    expect(await listRange(env.DB, "2026-12-21", "2026-12-21")).toHaveLength(0);
    expect((await post(await requestBody({ date: "2026-12-21", email: "autre@example.test" }))).status).toBe(201);
  });

  it("répond que la demande est faite, et non trop de demandes, à qui renvoie la sienne au plafond", async () => {
    await post(await requestBody({ date: "2026-12-19" }));
    await post(await requestBody({ date: "2026-12-20" }));
    const r = await post(await requestBody({ date: "2026-12-19" }));
    expect(r.status).toBe(200);
    expect(await reply(r)).toEqual({ status: "already_requested" });
  });

  it("limite à 5 demandes par adresse IP sur 24 h", async () => {
    const one = async (i: number, ip = IP) => post(await requestBody({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), deps, ip);
    for (let i = 0; i < 5; i++) expect((await one(i)).status).toBe(201);
    const sixth = await one(5);
    expect(sixth.status).toBe(429);
    // Derrière une connexion partagée, le client n'a peut-être aucune demande en cours : la raison le dit.
    expect(await sixth.json()).toEqual({ error: "too_many", reason: "ip" });
    expect(await listRange(env.DB, "2026-12-24", "2026-12-24")).toHaveLength(0);
    expect((await one(6, OTHER_IP)).status).toBe(201);
  });

  it("donne la raison de l'e-mail à qui dépasse les deux limites : ses demandes en cours sont la cause qu'il peut résoudre", async () => {
    const one = async (i: number, email: string) => post(await requestBody({ date: `2026-12-${19 + i}`, email }));
    for (const [i, email] of ["a", "a", "b", "c", "d"].entries()) expect((await one(i, `${email}@example.test`)).status).toBe(201);
    const over = await one(5, "a@example.test");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "too_many", reason: "email" });
  });

  it("oublie les demandes de plus de 24 h pour la limite par adresse IP", async () => {
    const one = async (i: number) => post(await requestBody({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }));
    for (let i = 0; i < 5; i++) await one(i);
    deps.setNow("2026-11-08T10:00:01.000Z");
    expect((await one(5)).status).toBe(201);
  });

  it("sans en-tête d'adresse IP, ne garde aucune empreinte et n'applique pas la limite par adresse", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await post(await requestBody({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), deps, null);
      expect(r.status).toBe(201);
    }
    expect((await stored()).every((b) => b.ip_hash === null)).toBe(true);
  });

  it.each([["vide", ""], ["absent", undefined]])(
    "avec un sel %s, ne garde aucune empreinte et n'applique pas la limite par adresse",
    async (_label, salt) => {
      const d = fakeDeps({ env: { ...env, IP_HASH_SALT: salt as string } });
      for (let i = 0; i < 6; i++) {
        const r = await post(await requestBody({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), d);
        expect(r.status).toBe(201);
      }
      const rows = await stored();
      expect(rows).toHaveLength(6);
      expect(rows.every((b) => b.ip_hash === null)).toBe(true);
    },
  );

  it("conserve seulement une empreinte salée de l'adresse IP", async () => {
    await post(await requestBody());
    const [b] = await listRange(env.DB, "2026-12-19", "2026-12-19");
    expect(b.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.IP_HASH_SALT).toBeTruthy();
    expect(b.ip_hash).toBe(await sha256Hex(env.IP_HASH_SALT + IP));
    expect(JSON.stringify(b)).not.toContain(IP);
  });
});

describe("POST /api/requests : validation", () => {
  it.each([
    [{ date: "2026-11-10" }, "date"], [{ date: "2029-01-01" }, "date"], [{ date: "2026-02-30" }, "date"],
    [{ date: 20261219 }, "date"], [{ plan: "inconnue" }, "plan"], [{ plan: 1 }, "plan"],
    [{ event_type: "Autre chose" }, "event_type"], [{ event_hours: "" }, "event_hours"],
    [{ event_hours: "x".repeat(61) }, "event_hours"], [{ name: "" }, "name"], [{ name: "   " }, "name"],
    [{ name: "x".repeat(121) }, "name"], [{ name: 42 }, "name"], [{ venue: "" }, "venue"],
    [{ venue: "x".repeat(301) }, "venue"], [{ phone: "abc" }, "phone"], [{ phone: "12345" }, "phone"],
    [{ phone: "1".repeat(21) }, "phone"], [{ phone: "06 12 34 56 78 #1" }, "phone"], [{ phone: null }, "phone"],
    [{ email: "pas-un-mail" }, "email"], [{ email: "a b@example.test" }, "email"], [{ email: "a@b" }, "email"],
    [{ email: `${"a".repeat(242)}@example.test` }, "email"], [{ email: { x: 1 } }, "email"],
    [{ message: "x".repeat(2001) }, "message"], [{ message: 7 }, "message"],
    [{ terms: false }, "terms"], [{ terms: "true" }, "terms"], [{ terms: 1 }, "terms"], [{ terms: undefined }, "terms"],
    [{ turnstile_token: 5 }, "turnstile_token"], [{ turnstile_token: "t".repeat(2049) }, "turnstile_token"],
    [{ price_cents: undefined }, "price_cents"], [{ price_cents: null }, "price_cents"], [{ price_cents: "15000" }, "price_cents"],
    [{ price_cents: 1.5 }, "price_cents"], [{ price_cents: -1 }, "price_cents"], [{ price_cents: 10_000_001 }, "price_cents"],
  ])("refuse %j", async (over, field) => {
    const r = await post(await requestBody(over));
    expect(r.status).toBe(422);
    const { error, fields } = await reply(r);
    expect(error).toBe("invalid");
    expect(fields).toContain(field);
    expect(await stored()).toHaveLength(0);
  });

  it("accepte chaque champ à sa longueur maximale", async () => {
    const r = await post(await requestBody({
      name: "x".repeat(120), venue: "x".repeat(300), event_hours: "x".repeat(60), message: "x".repeat(2000),
      phone: "+33 (0)6.12-34-56-78", email: `${"a".repeat(241)}@example.test`, turnstile_token: "t".repeat(2048),
    }));
    expect(r.status).toBe(201);
  });

  it("nomme tous les champs refusés, dans l'ordre du formulaire", async () => {
    const r = await post(await requestBody({ date: "x", name: "", email: "x", terms: false }));
    expect((await reply(r)).fields).toEqual(["date", "name", "email", "terms"]);
  });

  it.each([[null], [[]], ["texte"], [42], [true]])("refuse un corps qui n'est pas un objet : %j", async (raw) => {
    const r = await post(raw);
    expect(r.status).toBe(422);
    expect((await reply(r)).fields).toEqual(
      expect.arrayContaining(["date", "plan", "price_cents", "event_type", "event_hours", "venue", "name", "phone", "email", "terms"]),
    );
  });

  it("répond 400 invalid_json à un JSON mal formé, vide ou qui n'est pas de l'UTF-8", async () => {
    for (const raw of ["{pas du json", "", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])]) {
      const r = await send(raw);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_json" });
    }
    expect(await stored()).toHaveLength(0);
  });

  it("répond 413 au-delà de 16 Ko, et accepte juste 16 Ko", async () => {
    const base = await requestBody();
    const withPad = (n: number) => JSON.stringify({ ...base, pad: "x".repeat(n) });
    const bytes = (text: string) => new TextEncoder().encode(text).length; // « fêtes » compte plus d'octets que de lettres
    const fit = MAX_BODY - bytes(withPad(0));
    expect(bytes(withPad(fit))).toBe(MAX_BODY);
    expect((await send(withPad(fit))).status).toBe(201);

    const tooBig = await send(withPad(fit + 1), deps, IP);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: "too_large" });
    expect(await stored()).toHaveLength(1);
  });

  it("répond 413 d'après la taille annoncée, même si le corps reçu est petit", async () => {
    const r = await send(JSON.stringify(await requestBody()), deps, IP, { "Content-Length": String(MAX_BODY + 1) });
    expect(r.status).toBe(413);
    expect(await stored()).toHaveLength(0);
  });

  it("valide avant de consulter Turnstile, pour ne pas dépenser un jeton", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    const r = await post(await requestBody({ name: "" }), fakeDeps({ verifyTurnstile }));
    expect(r.status).toBe(422);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});

describe("POST /api/requests : prix", () => {
  it("répond price_changed avec le prix du moment, sans rien enregistrer", async () => {
    const input = await requestBody();
    const r = await post({ ...input, price_cents: (input.price_cents as number) + 100 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "price_changed", price_cents: input.price_cents });
    expect(await stored()).toHaveLength(0);
  });
});

describe("POST /api/requests : Turnstile", () => {
  it("transmet le jeton et l'adresse IP", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    const d = fakeDeps({ verifyTurnstile });
    await post(await requestBody({ turnstile_token: " jeton " }), d);
    expect(verifyTurnstile).toHaveBeenLastCalledWith("jeton", IP);
    await post(await requestBody({ date: "2026-12-20", email: "autre@example.test" }), d, null);
    expect(verifyTurnstile).toHaveBeenLastCalledWith("t", null);
  });

  it("refuse un robot, et n'enregistre rien", async () => {
    const r = await post(await requestBody(), fakeDeps({ verifyTurnstile: async () => "fail" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "bot" });
    expect(await stored()).toHaveLength(0);
  });

  it("accepte la demande si le service Turnstile est injoignable", async () => {
    expect((await post(await requestBody(), fakeDeps({ verifyTurnstile: async () => "unavailable" }))).status).toBe(201);
  });

  it("accepte la demande si la vérification Turnstile lève une erreur, et le consigne sans donnée personnelle", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verifyTurnstile = async (): Promise<never> => {
        throw new Error("panne");
      };
      expect((await post(await requestBody({ turnstile_token: "jeton-secret-123" }), fakeDeps({ verifyTurnstile }))).status).toBe(201);
      expect(await stored()).toHaveLength(1);

      expect(log).toHaveBeenCalledOnce();
      const logged = log.mock.calls[0].map(String).join(" ");
      expect(logged).toContain("Turnstile");
      expect(logged).toContain("panne");
      for (const personal of ["jeton-secret-123", "Camille", "camille@example.test", IP]) {
        expect(logged).not.toContain(personal);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("répond que la demande est faite à qui renvoie la sienne avec un jeton déjà dépensé", async () => {
    await post(await requestBody());
    const r = await post(await requestBody({ turnstile_token: "deja-utilise" }), fakeDeps({ verifyTurnstile: async () => "fail" }));
    expect(r.status).toBe(200);
    expect(await reply(r)).toEqual({ status: "already_requested" });
    expect(await stored()).toHaveLength(1);
  });

  it("ne consulte pas Turnstile pour une demande déjà enregistrée", async () => {
    await post(await requestBody());
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    expect((await post(await requestBody(), fakeDeps({ verifyTurnstile }))).status).toBe(200);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("refuse toujours un robot qui envoie une autre demande", async () => {
    await post(await requestBody());
    const r = await post(await requestBody({ date: "2026-12-20" }), fakeDeps({ verifyTurnstile: async () => "fail" }));
    expect(r.status).toBe(403);
    expect(await stored()).toHaveLength(1);
  });
});

describe("GET /api/availability", () => {
  const FROM = "2026-12-01";
  const TO = "2026-12-31";
  const unavailableIn = async (from: string, to: string) =>
    (await (await get(`/api/availability?from=${from}&to=${to}`)).json<{ unavailable: string[] }>()).unavailable;

  it("ne donne que des dates", async () => {
    await post(await requestBody());
    const r = await get(`/api/availability?from=${FROM}&to=${TO}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ unavailable: ["2026-12-19"], earliest: "2026-11-14", latest: "2028-11-07" });
  });

  it("garde le résultat 30 secondes au plus", async () => {
    const r = await get(`/api/availability?from=${FROM}&to=${TO}`);
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("ne donne que les dates de la plage demandée", async () => {
    await post(await requestBody());
    await post(await requestBody({ date: "2027-03-06", email: "autre@example.test" }));
    expect(await unavailableIn(FROM, TO)).toEqual(["2026-12-19"]);
    expect(await unavailableIn("2027-03-01", "2027-03-31")).toEqual(["2027-03-06"]);
    expect(await unavailableIn("2027-04-01", "2027-04-30")).toEqual([]);
  });

  it("accepte une plage de 400 jours", async () => {
    expect((await get(`/api/availability?from=2026-01-01&to=${addDays("2026-01-01", 400)}`)).status).toBe(200);
  });

  it.each([
    ["sans paramètres", ""],
    ["sans fin", "?from=2026-12-01"],
    ["sans début", "?to=2026-12-31"],
    ["avec un mois impossible", "?from=2026-13-01&to=2026-12-31"],
    ["avec un jour impossible", "?from=2026-12-01&to=2026-02-30"],
    ["avec des dates mal écrites", "?from=1er-décembre&to=31/12/2026"],
    ["avec une heure en plus", "?from=2026-12-01T00:00:00Z&to=2026-12-31"],
    ["avec une plage à l'envers", "?from=2026-12-31&to=2026-12-01"],
    ["avec une plage de 401 jours", `?from=2026-01-01&to=${addDays("2026-01-01", 401)}`],
  ])("répond 400 %s", async (_label, query) => {
    const r = await get(`/api/availability${query}`);
    expect(r.status).toBe(400);
    expect(await reply(r)).toEqual({ error: "invalid_range" });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/prices", () => {
  it("donne le palier en cours, ses places restantes et le prix de chaque formule", async () => {
    useTiers(testTier("t1", 10_000, 2), testTier("t2", 20_000));
    await post(await requestBody());
    const r = await get("/api/prices");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual(pricesBody(offer, currentTier(offer, await countTakenByTier(env.DB))));
    expect(body).toMatchObject({ tier: "t1", launch: true, remaining: 1 });
  });

  it("garde le résultat 30 secondes au plus", async () => {
    const r = await get("/api/prices");
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("routage et erreurs", () => {
  it("répond 404 en JSON sur une route d'API inconnue", async () => {
    const r = await get("/api/inconnue");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });

  it("passe par le point d'entrée du Worker avec les dépendances réelles", async () => {
    const r = await exports.default.fetch("https://brotobooth.fr/api/availability?from=2026-12-01&to=2026-12-31");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ unavailable: [] });
  });

  it("répond 405 avec les méthodes permises quand la méthode ne convient pas", async () => {
    const wrongGet = await get("/api/requests");
    expect(wrongGet.status).toBe(405);
    expect(wrongGet.headers.get("Allow")).toBe("POST");
    expect(await wrongGet.json()).toEqual({ error: "method_not_allowed" });

    const wrongPost = await handle(new Request("https://brotobooth.fr/api/availability", { method: "POST" }), deps, ctx);
    expect(wrongPost.status).toBe(405);
    expect(wrongPost.headers.get("Allow")).toBe("GET");
  });

  it("interdit la mise en cache et l'indexation de toutes les réponses du Worker", async () => {
    const replies = [
      await get("/api/inconnue"), await get("/api/requests"), await post(await requestBody()), await post(await requestBody({ name: "" })),
      await send("{"),
    ];
    for (const r of replies) {
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(r.headers.get("Content-Type")).toContain("application/json");
    }
  });

  it("répond 500 server_error à une panne imprévue, sans donnée personnelle dans le journal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = fakeDeps({
        now: () => {
          throw new Error("horloge cassée");
        },
      });
      const r = await post(await requestBody(), broken);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "server_error" });

      expect(log).toHaveBeenCalledOnce();
      const logged = log.mock.calls[0].map(String).join(" ");
      expect(logged).toContain("horloge cassée");
      expect(logged).toContain("POST /api/requests");
      for (const personal of ["Camille", "camille@example.test", "06 12 34 56 78", "Salle des fêtes", IP]) {
        expect(logged).not.toContain(personal);
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("POST /api/requests : type du corps", () => {
  it("répond 415 sans rien écrire à un corps annoncé text/plain ou sans type, et accepte un charset", async () => {
    const raw = JSON.stringify(await requestBody());
    for (const type of ["text/plain", ""]) {
      const r = await send(raw, deps, IP, { "Content-Type": type });
      expect(r.status).toBe(415);
      expect(await reply(r)).toEqual({ error: "unsupported_media_type" });
    }
    expect(await stored()).toEqual([]);
    expect((await send(raw, deps, IP, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(201);
  });
});

describe("POST /api/contact", () => {
  const contact = sendTo("/api/contact");
  const message = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "Camille Durand", email: "camille@example.test", message: "Bonjour", turnstile_token: "t", ...over });

  it("answers 201 and sends the e-mail to the owner right after the response", async () => {
    const r = await contact(message());
    expect(r.status).toBe(201);
    expect(await reply(r)).toEqual({ status: "sent" });
    expect(deps.emails.map((m) => [m.to, m.subject])).toEqual([[offer.contact.email, "Message de Camille Durand"]]);
    expect(await notificationRows()).toMatchObject([{ template: "owner_contact", recipient: "owner", sent_at: T0 }]);
  });

  it("answers 422 with the refused fields and does not queue anything", async () => {
    const r = await contact(message({ email: "x", message: "" }));
    expect(r.status).toBe(422);
    expect(await reply(r)).toEqual({ error: "invalid", fields: ["email", "message"] });
    expect(await notificationRows()).toEqual([]);
    expect(deps.emails).toEqual([]);
  });

  it("answers 403 for a robot and 429 beyond the limit", async () => {
    expect((await contact(message(), fakeDeps({ verifyTurnstile: async () => "fail" }))).status).toBe(403);
    const salted = fakeDeps({ env: { ...env, IP_HASH_SALT: "sel" } });
    for (let i = 0; i < offer.maxPerIpPer24h; i++) await contact(message(), salted);
    const r = await contact(message(), salted);
    expect(r.status).toBe(429);
    expect(await reply(r)).toEqual({ error: "too_many" });
  });

  it("answers 415 and writes nothing to a body not announced as JSON, accepts a charset", async () => {
    for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Type": "" }]) {
      const r = await contact(message(), deps, IP, headers);
      expect(r.status).toBe(415);
      expect(await reply(r)).toEqual({ error: "unsupported_media_type" });
    }
    expect(await notificationRows()).toEqual([]);
    expect((await contact(message(), deps, IP, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(201);
  });

  it("answers 400 invalid_json to a body that is not JSON, like /api/requests", async () => {
    const r = await contact("a=b");
    expect(r.status).toBe(400);
    expect(await reply(r)).toEqual({ error: "invalid_json" });
  });
});
