import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../../worker/bookings";
import type { Deps } from "../../worker/deps";
import { planById } from "../../worker/offer";
import { listDueNotifications, listRange } from "../../worker/repository";
import { handle } from "../../worker/router";
import { T0, fakeDeps, resetDb, type FakeDeps } from "../support";

const ctx = createExecutionContext();
const IP = "203.0.113.5";
const OTHER_IP = "198.51.100.7";
const MAX_BODY = 16 * 1024;

const body = (o: Record<string, unknown> = {}) => ({
  date: "2026-12-19", plan: "formule-1", event_type: "Mariage", event_hours: "19 h - 1 h",
  venue: "Salle des fêtes", name: "Camille Durand", phone: "06 12 34 56 78", email: "camille@example.test",
  terms: true, turnstile_token: "t", ...o,
});

let deps: FakeDeps;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps();
});

/** Un envoi du formulaire. `ip: null` : requête sans l'en-tête de Cloudflare. */
const send = (raw: BodyInit | null, d: Deps = deps, ip: string | null = IP, headers: Record<string, string> = {}) =>
  handle(
    new Request("https://brotobooth.fr/api/requests", {
      method: "POST",
      body: raw,
      headers: { ...(ip === null ? {} : { "CF-Connecting-IP": ip }), ...headers },
    }),
    d,
    ctx,
  );
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
    const r = await post(body());
    expect(r.status).toBe(201);
    expect(await reply(r)).toEqual({ status: "created" });
    const [b] = await listRange(env.DB, "2026-12-19", "2026-12-19");
    expect(b.status).toBe("pending_review");
    expect(b.source).toBe("site");
    expect(b.hold_until).toBe("2026-11-10T10:00:00.000Z");
    expect(b.terms_version).toBe("2026-11-07");
    expect(b.price_cents).toBe(planById("formule-1")!.priceCents);
    expect(b.deposit_cents).toBe(0);
    expect(b.created_at).toBe(T0);
    expect(await listDueNotifications(env.DB, T0, 20)).not.toHaveLength(0);
  });

  it("calcule le prix et l'acompte d'après la formule", async () => {
    const formule = planById("formule-2")!;
    const provisional = formule.priceCents;
    formule.priceCents = 150_000;
    try {
      await post(body({ plan: "formule-2" }));
    } finally {
      formule.priceCents = provisional;
    }
    const [b] = await stored();
    expect(b.plan).toBe("formule-2");
    expect(b.price_cents).toBe(150_000);
    expect(b.deposit_cents).toBe(45_000);
  });

  it("enregistre les champs rognés, l'e-mail en minuscules, et sans message un message vide", async () => {
    await post(body({
      name: "  Camille Durand ", venue: " Salle des fêtes\n", event_hours: " 19 h - 1 h ", phone: " 06 12 34 56 78 ",
      email: "  CAMILLE@Example.test ", event_type: " Mariage ", plan: " formule-1 ", date: " 2026-12-19 ",
    }));
    const [b] = await stored();
    expect(b).toMatchObject({
      client_name: "Camille Durand", venue: "Salle des fêtes", event_hours: "19 h - 1 h", client_phone: "06 12 34 56 78",
      client_email: "camille@example.test", event_type: "Mariage", plan: "formule-1", event_date: "2026-12-19",
      message: null,
    });
  });

  it("garde le message tel quel, retours à la ligne et caractères spéciaux compris", async () => {
    const message = "Un fond <b>rose</b> & des ballons ;\n« merci », 🎉";
    await post(body({ message: `  ${message}  ` }));
    expect((await stored())[0].message).toBe(message);
  });

  it("donne à chaque demande un identifiant et un jeton de 256 bits que la réponse ne dévoile pas", async () => {
    const first = await post(body());
    await post(body({ date: "2026-12-20", email: "autre@example.test" }));
    const [a, b] = await stored();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(await reply(first))).not.toContain(a.token);
  });

  it("répond date_taken si un autre client a pris la date", async () => {
    await post(body());
    const r = await post(body({ email: "autre@example.test" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "date_taken" });
    expect(await stored()).toHaveLength(1);
  });

  it("traite un second envoi identique comme une réussite", async () => {
    await post(body());
    const r = await post(body({ email: "CAMILLE@example.test " }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "already_requested" });
    expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toHaveLength(1);
  });

  it("traite deux envois identiques simultanés comme une réussite, jamais comme une date prise", async () => {
    const replies = await Promise.all([post(body()), post(body())]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await stored()).toHaveLength(1);
  });

  it("répond date_taken à deux clients différents qui se disputent la date en même temps", async () => {
    const replies = await Promise.all([post(body()), post(body({ email: "autre@example.test" }))]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stored()).toHaveLength(1);
  });

  it("ne perd pas la demande si l'envoi immédiat échoue", async () => {
    const d = fakeDeps();
    d.email.send = async () => {
      throw new Error("panne");
    };
    expect((await post(body(), d)).status).toBe(201);
    expect(await stored()).toHaveLength(1);
  });
});

describe("POST /api/requests : limites", () => {
  it("limite à 2 demandes actives par e-mail, sans tenir compte de la casse", async () => {
    await post(body({ date: "2026-12-19" }));
    await post(body({ date: "2026-12-20" }));
    expect((await post(body({ date: "2026-12-21", email: "Camille@Example.test" }))).status).toBe(429);
    expect(await listRange(env.DB, "2026-12-21", "2026-12-21")).toHaveLength(0);
    expect((await post(body({ date: "2026-12-21", email: "autre@example.test" }))).status).toBe(201);
  });

  it("répond que la demande est faite, et non trop de demandes, à qui renvoie la sienne au plafond", async () => {
    await post(body({ date: "2026-12-19" }));
    await post(body({ date: "2026-12-20" }));
    const r = await post(body({ date: "2026-12-19" }));
    expect(r.status).toBe(200);
    expect(await reply(r)).toEqual({ status: "already_requested" });
  });

  it("limite à 5 demandes par adresse IP sur 24 h", async () => {
    const one = (i: number, ip = IP) => post(body({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), deps, ip);
    for (let i = 0; i < 5; i++) expect((await one(i)).status).toBe(201);
    const sixth = await one(5);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "too_many" });
    expect(await listRange(env.DB, "2026-12-24", "2026-12-24")).toHaveLength(0);
    expect((await one(6, OTHER_IP)).status).toBe(201);
  });

  it("oublie les demandes de plus de 24 h pour la limite par adresse IP", async () => {
    const one = (i: number) => post(body({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }));
    for (let i = 0; i < 5; i++) await one(i);
    deps.setNow("2026-11-08T10:00:01.000Z");
    expect((await one(5)).status).toBe(201);
  });

  it("sans en-tête d'adresse IP, ne garde aucune empreinte et n'applique pas la limite par adresse", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await post(body({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), deps, null);
      expect(r.status).toBe(201);
    }
    expect((await stored()).every((b) => b.ip_hash === null)).toBe(true);
  });

  it.each([["vide", ""], ["absent", undefined]])(
    "avec un sel %s, ne garde aucune empreinte et n'applique pas la limite par adresse",
    async (_label, salt) => {
      const d = fakeDeps({ env: { ...env, IP_HASH_SALT: salt as string } });
      for (let i = 0; i < 6; i++) {
        const r = await post(body({ date: `2026-12-${19 + i}`, email: `client${i}@example.test` }), d);
        expect(r.status).toBe(201);
      }
      const rows = await stored();
      expect(rows).toHaveLength(6);
      expect(rows.every((b) => b.ip_hash === null)).toBe(true);
    },
  );

  it("conserve seulement une empreinte salée de l'adresse IP", async () => {
    await post(body());
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
  ])("refuse %j", async (over, field) => {
    const r = await post(body(over));
    expect(r.status).toBe(422);
    const { error, fields } = await reply(r);
    expect(error).toBe("invalid");
    expect(fields).toContain(field);
    expect(await stored()).toHaveLength(0);
  });

  it("accepte chaque champ à sa longueur maximale", async () => {
    const r = await post(body({
      name: "x".repeat(120), venue: "x".repeat(300), event_hours: "x".repeat(60), message: "x".repeat(2000),
      phone: "+33 (0)6.12-34-56-78", email: `${"a".repeat(241)}@example.test`, turnstile_token: "t".repeat(2048),
    }));
    expect(r.status).toBe(201);
  });

  it("nomme tous les champs refusés, dans l'ordre du formulaire", async () => {
    const r = await post(body({ date: "x", name: "", email: "x", terms: false }));
    expect((await reply(r)).fields).toEqual(["date", "name", "email", "terms"]);
  });

  it.each([[null], [[]], ["texte"], [42], [true]])("refuse un corps qui n'est pas un objet : %j", async (raw) => {
    const r = await post(raw);
    expect(r.status).toBe(422);
    expect((await reply(r)).fields).toEqual(
      expect.arrayContaining(["date", "plan", "event_type", "event_hours", "venue", "name", "phone", "email", "terms"]),
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
    const withPad = (n: number) => JSON.stringify({ ...body(), pad: "x".repeat(n) });
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
    const r = await send(JSON.stringify(body()), deps, IP, { "Content-Length": String(MAX_BODY + 1) });
    expect(r.status).toBe(413);
    expect(await stored()).toHaveLength(0);
  });

  it("valide avant de consulter Turnstile, pour ne pas dépenser un jeton", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    const r = await post(body({ name: "" }), fakeDeps({ verifyTurnstile }));
    expect(r.status).toBe(422);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});

describe("POST /api/requests : Turnstile", () => {
  it("transmet le jeton et l'adresse IP", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    const d = fakeDeps({ verifyTurnstile });
    await post(body({ turnstile_token: " jeton " }), d);
    expect(verifyTurnstile).toHaveBeenLastCalledWith("jeton", IP);
    await post(body({ date: "2026-12-20", email: "autre@example.test" }), d, null);
    expect(verifyTurnstile).toHaveBeenLastCalledWith("t", null);
  });

  it("refuse un robot, et n'enregistre rien", async () => {
    const r = await post(body(), fakeDeps({ verifyTurnstile: async () => "fail" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "bot" });
    expect(await stored()).toHaveLength(0);
  });

  it("accepte la demande si le service Turnstile est injoignable", async () => {
    expect((await post(body(), fakeDeps({ verifyTurnstile: async () => "unavailable" }))).status).toBe(201);
  });

  it("accepte la demande si la vérification Turnstile lève une erreur, et le consigne sans donnée personnelle", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verifyTurnstile = async (): Promise<never> => {
        throw new Error("panne");
      };
      expect((await post(body({ turnstile_token: "jeton-secret-123" }), fakeDeps({ verifyTurnstile }))).status).toBe(201);
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
    await post(body());
    const r = await post(body({ turnstile_token: "deja-utilise" }), fakeDeps({ verifyTurnstile: async () => "fail" }));
    expect(r.status).toBe(200);
    expect(await reply(r)).toEqual({ status: "already_requested" });
    expect(await stored()).toHaveLength(1);
  });

  it("ne consulte pas Turnstile pour une demande déjà enregistrée", async () => {
    await post(body());
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    expect((await post(body(), fakeDeps({ verifyTurnstile }))).status).toBe(200);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("refuse toujours un robot qui envoie une autre demande", async () => {
    await post(body());
    const r = await post(body({ date: "2026-12-20" }), fakeDeps({ verifyTurnstile: async () => "fail" }));
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
    await post(body());
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
    await post(body());
    await post(body({ date: "2027-03-06", email: "autre@example.test" }));
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
      await get("/api/inconnue"), await get("/api/requests"), await post(body()), await post(body({ name: "" })),
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
      const r = await post(body(), broken);
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
