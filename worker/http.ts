import type { Deps } from "./deps";

export type Handler = (req: Request, deps: Deps, ctx: ExecutionContext) => Promise<Response>;

/** Ni gardées en cache ni indexées, sauf si l'appelant en décide autrement. */
const DEFAULT_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(data, { status, headers: { ...DEFAULT_HEADERS, ...headers } });

export type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: "invalid_json" | "too_large" };

const TOO_LARGE = { ok: false, status: 413, error: "too_large" } as const;
const INVALID_JSON = { ok: false, status: 400, error: "invalid_json" } as const;

/** Le corps lu comme du JSON, sans jamais en garder plus de `maxBytes` octets en mémoire. */
export async function readJson(req: Request, maxBytes: number): Promise<JsonBody> {
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
    return { ok: true, value: JSON.parse(text + decoder.decode()) };
  } catch {
    return INVALID_JSON;
  }
}
