import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ACCESS_JWT_HEADER, accessVerifier, newAccessKeyCache } from "../../worker/access";
import { AUD, NOW, NOW_S, TEAM, base64url, encode, newSigner, tokenFrom, type Signer } from "../access-tokens";

/**
 * Le jeton signé que Cloudflare Access joint à chaque requête qu'il laisse passer : le Worker le vérifie lui-même, parce
 * qu'un Worker servi avec des fichiers statiques ne reçoit pas `ctx.access` (documentation de Cloudflare, novembre 2026).
 */

let signer: Signer;
let other: Signer;
let fetched: string[];
let keys: (JsonWebKey & { kid: string })[];
let now: Date;
let errors: MockInstance;

const fetchKeys = (async (url: string) => {
  fetched.push(url);
  return Response.json({ keys });
}) as unknown as typeof fetch;

/** Un vérificateur neuf, avec son propre cache de clés : aucun test ne voit les clés d'un autre. */
const verifier = (env: Partial<{ ACCESS_AUD: string; ACCESS_TEAM_DOMAIN: string }> = {}, fetchFn: typeof fetch = fetchKeys) =>
  accessVerifier({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, ...env }, () => now, fetchFn, newAccessKeyCache());

beforeAll(async () => {
  signer = await newSigner("cle-1");
  other = await newSigner("cle-2");
});

beforeEach(() => {
  fetched = [];
  keys = [signer.jwk];
  now = new Date(NOW);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("le jeton d'Access", () => {
  it("porte le nom d'en-tête que Cloudflare utilise", () => {
    expect(ACCESS_JWT_HEADER).toBe("Cf-Access-Jwt-Assertion");
  });

  it("accepte un jeton signé par l'équipe, émis pour l'application, en cours de validité", async () => {
    expect(await verifier()(await tokenFrom(signer))).toBe(true);
    expect(fetched).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("accepte un public écrit seul plutôt qu'en liste", async () => {
    expect(await verifier()(await tokenFrom(signer, { aud: AUD }))).toBe(true);
  });

  it.each([
    ["aucun jeton", null],
    ["un jeton vide", ""],
    ["deux parties seulement", "aaa.bbb"],
    ["quatre parties", "aaa.bbb.ccc.ddd"],
    ["un en-tête qui n'est pas du JSON", `${base64url(new TextEncoder().encode("pas du json"))}.e30.AAAA`],
    ["des caractères hors base64url", "@@@.@@@.@@@"],
  ])("refuse %s, sans rien demander au réseau", async (_what, token) => {
    expect(await verifier()(token)).toBe(false);
    expect(fetched).toEqual([]);
  });

  it("refuse un jeton émis pour une autre application", async () => {
    expect(await verifier()(await tokenFrom(signer, { aud: ["b".repeat(64)] }))).toBe(false);
  });

  it("refuse un jeton sans public, ou au public vide", async () => {
    expect(await verifier()(await tokenFrom(signer, { aud: undefined }))).toBe(false);
    expect(await verifier()(await tokenFrom(signer, { aud: [] }))).toBe(false);
  });

  it("refuse un jeton émis par une autre équipe", async () => {
    expect(await verifier()(await tokenFrom(signer, { iss: "https://autre-equipe.cloudflareaccess.com" }))).toBe(false);
  });

  it.each([
    ["expiré à l'instant", { exp: NOW_S }],
    ["expiré depuis une heure", { exp: NOW_S - 3600 }],
    ["sans échéance", { exp: undefined }],
    ["à l'échéance qui n'est pas un nombre", { exp: "demain" }],
    ["pas encore valable", { nbf: NOW_S + 600 }],
  ])("refuse un jeton %s", async (_what, claims) => {
    expect(await verifier()(await tokenFrom(signer, claims))).toBe(false);
  });

  it("refuse un jeton signé par une autre clé qui se présente sous le même nom", async () => {
    const forged = await tokenFrom({ ...other, kid: signer.kid });
    expect(await verifier()(forged)).toBe(false);
  });

  it("refuse un jeton dont le contenu a été modifié après la signature", async () => {
    const [head, , signature] = (await tokenFrom(signer, { aud: ["b".repeat(64)] })).split(".");
    const [, wanted] = (await tokenFrom(signer)).split(".");
    expect(await verifier()(`${head}.${wanted}.${signature}`)).toBe(false);
  });

  it.each([
    ["none", ""],
    ["HS256", "AAAA"],
    ["RS512", "AAAA"],
  ])("refuse l'algorithme %s, sans rien demander au réseau", async (alg, signature) => {
    const [, body] = (await tokenFrom(signer)).split(".");
    expect(await verifier()(`${encode({ alg, kid: signer.kid })}.${body}.${signature}`)).toBe(false);
    expect(fetched).toEqual([]);
  });

  // Une signature RS256 valide ne sauve pas un en-tête qui annonce autre chose.
  it.each(["none", "rs256", "RS512"])("refuse une signature valide annoncée sous l'algorithme %s", async (alg) => {
    expect(await verifier()(await tokenFrom(signer, {}, { alg }))).toBe(false);
  });

  it("accepte un jeton valable depuis moins d'une minute dans le futur, pas au-delà, ni un début qui n'est pas un nombre", async () => {
    expect(await verifier()(await tokenFrom(signer, { nbf: NOW_S + 60 }))).toBe(true);
    expect(await verifier()(await tokenFrom(signer, { nbf: NOW_S + 61 }))).toBe(false);
    expect(await verifier()(await tokenFrom(signer, { nbf: "maintenant" }))).toBe(false);
  });

  it("refuse un jeton sans nom de clé, ou d'une clé que l'équipe ne publie pas", async () => {
    expect(await verifier()(await tokenFrom(signer, {}, { kid: undefined }))).toBe(false);
    expect(await verifier()(await tokenFrom(other))).toBe(false);
  });
});

describe("les clés de l'équipe", () => {
  it("ne sont lues qu'une fois pour plusieurs jetons", async () => {
    const verify = verifier();
    expect(await verify(await tokenFrom(signer))).toBe(true);
    expect(await verify(await tokenFrom(signer, { exp: NOW_S + 60 }))).toBe(true);
    expect(fetched).toHaveLength(1);
  });

  it("sont relues quand l'équipe a changé de clé, mais pas plus d'une fois par minute", async () => {
    const verify = verifier();
    expect(await verify(await tokenFrom(signer))).toBe(true);

    // Une clé inconnue, aussitôt : pas de nouvelle lecture, pour qu'un flot de faux jetons ne fasse pas un flot de requêtes.
    keys = [signer.jwk, other.jwk];
    expect(await verify(await tokenFrom(other))).toBe(false);
    expect(fetched).toHaveLength(1);

    now = new Date(Date.parse(NOW) + 61_000);
    expect(await verify(await tokenFrom(other))).toBe(true);
    expect(fetched).toHaveLength(2);
  });

  it("sont relues au bout d'une heure, même sans clé inconnue", async () => {
    const verify = verifier();
    expect(await verify(await tokenFrom(signer))).toBe(true);
    now = new Date(Date.parse(NOW) + 3_601_000);
    expect(await verify(await tokenFrom(signer, { exp: NOW_S + 7200 }))).toBe(true);
    expect(fetched).toHaveLength(2);
  });

  // La page d'administration lance trois appels à la fois : sur un isolat neuf, tous doivent passer.
  it("servent tous les appels simultanés d'un isolat neuf, et ceux d'une relecture", async () => {
    const slow = (async (url: string) => {
      fetched.push(url);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ keys });
    }) as unknown as typeof fetch;
    const verify = verifier({}, slow);
    const token = await tokenFrom(signer, { exp: NOW_S + 7200 });

    expect(await Promise.all([verify(token), verify(token), verify(token), verify(token)])).toEqual([true, true, true, true]);
    now = new Date(Date.parse(NOW) + 3_601_000);
    expect(await Promise.all([verify(token), verify(token), verify(token)])).toEqual([true, true, true]);
  });

  it("ne servent plus au-delà d'une heure si leur relecture échoue, puis resservent dès qu'elle réussit", async () => {
    let down = false;
    const flaky = (async (url: string) => {
      fetched.push(url);
      if (down) throw new Error("réseau");
      return Response.json({ keys });
    }) as unknown as typeof fetch;
    const verify = verifier({}, flaky);
    const token = await tokenFrom(signer, { exp: NOW_S + 86_400 });
    expect(await verify(token)).toBe(true);

    down = true;
    now = new Date(Date.parse(NOW) + 3_601_000);
    expect(await verify(token)).toBe(false);
    expect(fetched).toHaveLength(2);

    // Moins d'une minute après l'échec : pas de nouvel essai, même si le service est revenu.
    down = false;
    now = new Date(Date.parse(NOW) + 3_601_000 + 30_000);
    expect(await verify(token)).toBe(false);
    expect(fetched).toHaveLength(2);

    now = new Date(Date.parse(NOW) + 3_601_000 + 61_000);
    expect(await verify(token)).toBe(true);
    expect(fetched).toHaveLength(3);
  });

  it("ne reconnaissent plus une clé que l'équipe a retirée, une fois relues", async () => {
    const verify = verifier();
    const token = await tokenFrom(signer, { exp: NOW_S + 86_400 });
    expect(await verify(token)).toBe(true);
    keys = [other.jwk];
    now = new Date(Date.parse(NOW) + 3_601_000);
    expect(await verify(token)).toBe(false);
  });

  it("gardent les clés lisibles quand l'une d'elles ne l'est pas", async () => {
    keys = [{ kty: "RSA", kid: "illisible", n: "pas une clé", e: "AQAB" }, { kty: "EC", kid: "autre-famille" } as never, signer.jwk];
    expect(await verifier()(await tokenFrom(signer))).toBe(true);
  });

  it.each([
    ["le réseau tombe", (async () => Promise.reject(new Error("réseau"))) as unknown as typeof fetch],
    ["le service répond 500", (async () => new Response("panne", { status: 500 })) as unknown as typeof fetch],
    ["la réponse n'est pas du JSON", (async () => new Response("<html>")) as unknown as typeof fetch],
    ["la réponse n'a pas de clés", (async () => Response.json({})) as unknown as typeof fetch],
  ])("personne n'est reconnu quand %s, et rien ne lève", async (_what, fetchFn) => {
    expect(await verifier({}, fetchFn)(await tokenFrom(signer))).toBe(false);
  });

  it("n'écrit jamais le jeton dans les journaux", async () => {
    const token = await tokenFrom(signer);
    const failing = (async () => Promise.reject(new Error("réseau"))) as unknown as typeof fetch;
    await verifier({}, failing)(token);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).not.toBe("");
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.split(".")[2]);
  });
});

describe("la configuration", () => {
  // Chaque jeton est émis par le domaine configuré : sans le contrôle de sa forme, il serait accepté, et les clés
  // seraient lues ailleurs que chez Cloudflare Access.
  it.each([
    ["manque", ""],
    ["n'est pas celui d'une équipe Access", "exemple.fr"],
    ["porte un chemin", `${TEAM}/ailleurs`],
    ["imite celui d'Access", "cloudflareaccess.com.exemple.fr"],
    ["porte des majuscules", "Equipe-Test.cloudflareaccess.com"],
  ])("personne n'est reconnu quand le domaine de l'équipe %s, sans rien demander au réseau", async (_what, domain) => {
    const token = await tokenFrom(signer, { iss: `https://${domain}` });
    expect(await verifier({ ACCESS_TEAM_DOMAIN: domain })(token)).toBe(false);
    expect(fetched).toEqual([]);
  });

  // Deux publics absents ne s'accordent pas : ni un public vide face à un jeton au public vide, ni un public non
  // configuré face à un jeton sans public.
  it("personne n'est reconnu quand le public attendu manque, sans rien demander au réseau", async () => {
    expect(await verifier({ ACCESS_AUD: "" })(await tokenFrom(signer, { aud: "" }))).toBe(false);
    expect(await verifier({ ACCESS_AUD: "" })(await tokenFrom(signer, { aud: [""] }))).toBe(false);
    expect(await verifier({ ACCESS_AUD: undefined as unknown as string })(await tokenFrom(signer, { aud: undefined }))).toBe(false);
    expect(await verifier({ ACCESS_AUD: "" })(await tokenFrom(signer))).toBe(false);
    expect(fetched).toEqual([]);
  });
});
