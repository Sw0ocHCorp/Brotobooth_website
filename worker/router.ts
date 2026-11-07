import { availability, postRequest } from "./api";
import type { Deps } from "./deps";
import { json, type Handler } from "./http";

type Route = { method: string; path: string; handler: Handler };

const ROUTES: Route[] = [
  { method: "GET", path: "/api/availability", handler: availability },
  { method: "POST", path: "/api/requests", handler: postRequest },
];

export async function handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  const onPath = ROUTES.filter((route) => route.path === pathname);
  if (onPath.length === 0) return json({ error: "not_found" }, 404);

  const route = onPath.find((candidate) => candidate.method === req.method);
  if (!route) {
    return json({ error: "method_not_allowed" }, 405, { Allow: onPath.map((r) => r.method).join(", ") });
  }
  try {
    return await route.handler(req, deps, ctx);
  } catch (error) {
    // Le message et la route, jamais le corps, l'adresse ni les champs : le journal ne reçoit aucune donnée personnelle.
    console.error(`${route.method} ${route.path} : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    return json({ error: "server_error" }, 500);
  }
}
