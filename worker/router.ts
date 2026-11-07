import { availability, postRequest } from "./api";
import type { Deps } from "./deps";
import { fromOtherOrigin, json, type Handler } from "./http";
import { paymentPage, startPayment, stripeWebhook } from "./payments";
import { simulationAction, simulationPage } from "./simulated-payment";

/** `:nom` dans `path` capte un segment du chemin, passé au gestionnaire dans l'ordre. */
type Route = { method: string; path: string; handler: Handler };

/** Le gestionnaire d'une page qui s'adresse à un client par son jeton (`:token`, premier segment capté). */
const forToken =
  (handler: (req: Request, deps: Deps, token: string) => Promise<Response>): Handler =>
  (req, deps, _ctx, [token]) =>
    handler(req, deps, token);

const ROUTES: Route[] = [
  { method: "GET", path: "/api/availability", handler: availability },
  { method: "POST", path: "/api/requests", handler: postRequest },
  { method: "POST", path: "/api/stripe/webhook", handler: stripeWebhook },
  { method: "GET", path: "/acompte/:token", handler: forToken(paymentPage) },
  { method: "POST", path: "/acompte/:token", handler: forToken(startPayment) },
  { method: "GET", path: "/acompte/:token/simulation", handler: forToken(simulationPage) },
  { method: "POST", path: "/acompte/:token/simulation", handler: forToken(simulationAction) },
];

/** Les envois des formulaires de `/acompte` viennent du site lui-même, jamais d'une page d'un autre site. */
const SITE_FORMS = "/acompte/";

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

export async function handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  const onPath = ROUTES.flatMap((route) => {
    const params = match(route.path, pathname);
    return params ? [{ route, params }] : [];
  });
  if (onPath.length === 0) return json({ error: "not_found" }, 404);

  const hit = onPath.find(({ route }) => route.method === req.method);
  if (!hit) {
    return json({ error: "method_not_allowed" }, 405, { Allow: onPath.map(({ route }) => route.method).join(", ") });
  }
  const { route, params } = hit;
  try {
    if (req.method === "POST" && pathname.startsWith(SITE_FORMS) && fromOtherOrigin(req, deps.env.BASE_URL)) {
      return json({ error: "forbidden" }, 403);
    }
    return await route.handler(req, deps, ctx, params);
  } catch (error) {
    // Le message et la route, jamais le corps, l'adresse ni les champs : le journal ne reçoit aucune donnée personnelle.
    console.error(`${route.method} ${route.path} : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    return json({ error: "server_error" }, 500);
  }
}
