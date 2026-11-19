import { TEAM_DOMAIN_FORMAT, type Env } from "./env";
import { callServiceOk } from "./http";

/**
 * Le jeton signé que Cloudflare Access joint à toute requête qu'il laisse passer. Le Worker le vérifie lui-même : servi
 * avec des fichiers statiques, il s'exécute derrière un routeur interne qui ne lui transmet pas `ctx.access`
 * (developers.cloudflare.com/workers/configuration/cloudflare-access, « ctx.access limitations », novembre 2026).
 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Les clés de l'équipe sont relues au bout d'une heure. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/** Une clé inconnue, ou une lecture en échec, ne fait pas relire les clés plus d'une fois par minute. */
const RETRY_MS = 60 * 1000;
/** Un léger écart d'horloge avec Access ne refuse pas un jeton tout juste émis. */
const NOT_BEFORE_LEEWAY_S = 60;

/** Les clés publiques de l'équipe, par nom (`kid`), avec l'instant de leur lecture et celui où le dernier essai s'est terminé. */
export type AccessKeyCache = { keys: Map<string, CryptoKey>; readAt: number; triedAt: number };

export const newAccessKeyCache = (): AccessKeyCache => ({
  keys: new Map(),
  readAt: Number.NEGATIVE_INFINITY,
  triedAt: Number.NEGATIVE_INFINITY,
});

/** Le cache de l'isolat : il sert d'une requête à l'autre tant que l'isolat vit. */
const isolateCache = newAccessKeyCache();

function bytesOf(part: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(part)) return null;
  try {
    return Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function objectOf(part: string): Record<string, unknown> | null {
  const bytes = bytesOf(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readKeys(teamDomain: string, fetchFn: typeof fetch): Promise<Map<string, CryptoKey>> {
  const response = await callServiceOk("Cloudflare Access", fetchFn, `https://${teamDomain}/cdn-cgi/access/certs`, {});
  const body = await response.json<{ keys?: (JsonWebKey & { kid?: unknown })[] } | null>().catch(() => null);
  const keys = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (typeof jwk?.kid !== "string" || jwk.kty !== "RSA") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, RSA, false, ["verify"]));
    } catch {
      // Une clé illisible est ignorée : les autres restent utilisables.
    }
  }
  if (keys.size === 0) throw new Error("aucune clé publiée");
  return keys;
}

/**
 * La clé `kid` de l'équipe, ou `null`. Les clés lues depuis moins d'une heure servent telles quelles ; au-delà, ou pour
 * une clé inconnue (l'équipe a changé de clé), elles sont relues, au plus une fois par minute. Un essai ne compte qu'une
 * fois terminé : des appels simultanés lisent chacun les clés, et aucun n'est refusé parce qu'un autre a commencé (la page
 * d'administration en lance trois à la fois). Si la relecture échoue, des clés de plus d'une heure ne servent plus :
 * mieux vaut refuser le propriétaire quelques minutes que se fier à des clés périmées.
 */
async function keyOf(kid: string, teamDomain: string, cache: AccessKeyCache, clock: () => number, fetchFn: typeof fetch): Promise<CryptoKey | null> {
  const startedAt = clock();
  const stale = startedAt - cache.readAt >= KEYS_TTL_MS;
  if ((stale || !cache.keys.has(kid)) && startedAt - cache.triedAt >= RETRY_MS) {
    try {
      cache.keys = await readKeys(teamDomain, fetchFn);
      cache.readAt = clock();
    } catch (error) {
      // Ni le jeton ni son contenu ne sont écrits dans les journaux.
      console.error(`Clés de Cloudflare Access illisibles : ${(error as Error).message}`);
    }
    cache.triedAt = clock();
  }
  return clock() - cache.readAt < KEYS_TTL_MS ? (cache.keys.get(kid) ?? null) : null;
}

/**
 * Dit si `token` est un jeton d'Access valide pour l'application d'administration : signé en RS256 par une clé de
 * l'équipe (`ACCESS_TEAM_DOMAIN`), émis par elle (`iss`) pour cette application (`aud` contient `ACCESS_AUD`), et en cours
 * de validité. Tout le reste répond `false`, sans jamais lever : jeton absent ou mal formé, autre algorithme (dont
 * `none`), configuration incomplète, clés illisibles.
 */
export function accessVerifier(
  env: Pick<Env, "ACCESS_AUD" | "ACCESS_TEAM_DOMAIN">,
  now: () => Date,
  fetchFn: typeof fetch = fetch,
  cache: AccessKeyCache = isolateCache,
): (token: string | null) => Promise<boolean> {
  return async (token) => {
    const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
    if (!token || !env.ACCESS_AUD || !TEAM_DOMAIN_FORMAT.test(teamDomain)) return false;

    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [head, body, sign] = parts;
    const header = objectOf(head);
    const claims = objectOf(body);
    const signature = bytesOf(sign);
    if (header === null || claims === null || signature === null) return false;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

    const clock = () => now().getTime();
    const nowS = clock() / 1000;
    const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return false;
    if (claims.iss !== `https://${teamDomain}`) return false;
    if (typeof claims.exp !== "number" || claims.exp <= nowS) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowS + NOT_BEFORE_LEEWAY_S)) return false;

    const key = await keyOf(header.kid, teamDomain, cache, clock, fetchFn);
    if (key === null) return false;
    try {
      return await crypto.subtle.verify(RSA.name, key, signature, new TextEncoder().encode(`${head}.${body}`));
    } catch {
      return false;
    }
  };
}
