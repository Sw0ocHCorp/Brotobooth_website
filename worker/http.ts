import type { Deps } from "./deps";

/** `params` : les segments `:nom` du chemin de la route, dans l'ordre. */
export type Handler = (req: Request, deps: Deps, ctx: ExecutionContext, params: string[]) => Promise<Response>;

/** `:nom` dans `path` capte un segment du chemin, passé au gestionnaire dans l'ordre. */
export type Route = { method: string; path: string; handler: Handler };

/** Ni gardées en cache ni indexées, sauf si l'appelant en décide autrement. */
export const DEFAULT_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(data, { status, headers: { ...DEFAULT_HEADERS, ...headers } });

/** Les segments captés par `:nom`, ou `null` si `pathname` n'est pas de la forme de `path`. */
function match(path: string, pathname: string): string[] | null {
  const wanted = path.split("/");
  const actual = pathname.split("/");
  if (wanted.length !== actual.length) return null;
  const params: string[] = [];
  for (const [i, segment] of wanted.entries()) {
    if (!segment.startsWith(":")) {
      if (segment !== actual[i]) return null;
    } else if (actual[i] === "") {
      return null;
    } else {
      params.push(actual[i]);
    }
  }
  return params;
}

/** La route de `routes` qui répond à `method` sur `pathname`, avec ses segments captés, ou la réponse 404 ou 405 à rendre. */
export function findRoute(routes: Route[], method: string, pathname: string): { route: Route; params: string[] } | Response {
  const onPath = routes.flatMap((route) => {
    const params = match(route.path, pathname);
    return params ? [{ route, params }] : [];
  });
  if (onPath.length === 0) return json({ error: "not_found" }, 404);

  const hit = onPath.find(({ route }) => route.method === method);
  return hit ?? json({ error: "method_not_allowed" }, 405, { Allow: onPath.map(({ route }) => route.method).join(", ") });
}

/**
 * Une page HTML : jamais gardée en cache ni indexée, et sans son adresse (qui porte le jeton) dans le `Referer`
 * d'un autre site. `same-origin` et non `no-referrer` : avec ce dernier, un navigateur envoie `Origin: null`
 * pour un formulaire du site lui-même, que le contrôle d'origine des `POST` refuserait.
 */
export const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });

/** Renvoie le navigateur vers `location` par un `GET` (303), y compris après un `POST`. */
export const redirect = (location: string): Response =>
  new Response(null, { status: 303, headers: { ...DEFAULT_HEADERS, Location: location } });

/**
 * `true` si la requête annonce une autre origine que celle du site (`BASE_URL`). Sans en-tête `Origin`,
 * elle ne vient pas d'une page d'un navigateur : il n'y a rien à refuser.
 */
export function fromOtherOrigin(req: Request, baseUrl: string): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin !== new URL(baseUrl).origin;
}

const digest = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/**
 * `true` si `given` est le secret `expected`. Les deux sont réduits à une empreinte de même longueur, comparée
 * octet par octet sans s'arrêter au premier écart : ni la durée, ni la longueur ne disent où ils diffèrent.
 * Un secret absent ou vide, d'un côté ou de l'autre, est refusé, jamais comparé : deux textes vides ne s'accordent pas.
 */
export async function secretMatches(given: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;
}

export type TextBody =
  | { ok: true; value: string }
  | { ok: false; status: 400 | 413; error: "invalid_body" | "too_large" };

const TOO_LARGE = { ok: false, status: 413, error: "too_large" } as const;
const INVALID_BODY = { ok: false, status: 400, error: "invalid_body" } as const;

/** Le corps lu comme du texte UTF-8, sans jamais en garder plus de `maxBytes` octets en mémoire. */
export async function readText(req: Request, maxBytes: number): Promise<TextBody> {
  // La taille annoncée peut manquer (envoi par morceaux) ou mentir : les octets reçus sont comptés aussi.
  if (Number(req.headers.get("Content-Length")) > maxBytes) return TOO_LARGE;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    const reader = req.body?.getReader();
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return TOO_LARGE;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { ok: true, value: text + decoder.decode() };
  } catch {
    return INVALID_BODY;
  }
}

export type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: "invalid_json" | "too_large" };

const INVALID_JSON = { ok: false, status: 400, error: "invalid_json" } as const;

/** Le corps lu comme du JSON, sans jamais en garder plus de `maxBytes` octets en mémoire. */
export async function readJson(req: Request, maxBytes: number): Promise<JsonBody> {
  const text = await readText(req, maxBytes);
  if (!text.ok) return text.error === "too_large" ? TOO_LARGE : INVALID_JSON;
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    return INVALID_JSON;
  }
}

/** Un service extérieur qui ne répond pas dans ce délai ne doit pas retenir l'envoi des messages suivants. */
const OUTBOUND_TIMEOUT_MS = 10_000;

/**
 * Un appel à un service extérieur, borné dans le temps. Si l'appel échoue, l'erreur nomme le service et le
 * type de la panne, jamais le message d'origine : il peut citer l'adresse appelée, qui porte parfois un secret.
 */
export async function callService(service: string, fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${service} injoignable (${error instanceof Error ? error.name : "erreur inconnue"})`);
  }
}

/** Comme `callService`, et lève aussi sur une réponse qui n'est pas 2xx, sans reprendre son contenu. */
export async function callServiceOk(service: string, fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const res = await callService(service, fetchFn, url, init);
  if (!res.ok) throw new Error(`${service} a répondu ${res.status}`);
  return res;
}

/** Un envoi `POST` d'un corps JSON. */
export const jsonPost = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
