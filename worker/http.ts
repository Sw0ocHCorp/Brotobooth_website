import type { Deps } from "./deps";

/** `params` : les segments `:nom` du chemin de la route, dans l'ordre. */
export type Handler = (req: Request, deps: Deps, ctx: ExecutionContext, params: string[]) => Promise<Response>;

/** Ni gardées en cache ni indexées, sauf si l'appelant en décide autrement. */
const DEFAULT_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(data, { status, headers: { ...DEFAULT_HEADERS, ...headers } });

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
