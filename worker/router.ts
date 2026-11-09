import { adminApi } from "./admin";
import { availability, postRequest, prices } from "./api";
import { calendarFeed } from "./calendar";
import { demoPage } from "./demo";
import type { Deps } from "./deps";
import { findRoute, fromOtherOrigin, json, type Handler, type Route } from "./http";
import { notFoundPage, otherOriginPage, paymentPage, startPayment, stripeWebhook } from "./payments";
import { simulationAction, simulationPage } from "./simulated-payment";
import { telegramWebhook } from "./telegram";

/**
 * Le gestionnaire d'une page qui s'adresse à un client par son jeton (`:token`, premier segment capté). Le
 * contexte d'exécution suit en dernier : seules les pages qui enregistrent un paiement en ont besoin.
 */
const forToken =
  (handler: (req: Request, deps: Deps, token: string, ctx: ExecutionContext) => Promise<Response>): Handler =>
  (req, deps, ctx, [token]) =>
    handler(req, deps, token, ctx);

/** `/agenda/<jeton>.ics` : le jeton est le nom du fichier sans son extension. Sans elle, il n'y a pas de jeton, et le flux répond 404. */
const ICS = ".ics";
const agenda: Handler = (_req, deps, _ctx, [file]) =>
  calendarFeed(deps, file.endsWith(ICS) ? file.slice(0, -ICS.length) : "");

const ROUTES: Route[] = [
  { method: "GET", path: "/api/availability", handler: availability },
  { method: "GET", path: "/api/prices", handler: prices },
  { method: "POST", path: "/api/requests", handler: postRequest },
  { method: "POST", path: "/api/stripe/webhook", handler: stripeWebhook },
  { method: "POST", path: "/api/telegram/webhook", handler: telegramWebhook },
  { method: "GET", path: "/acompte/:token", handler: forToken(paymentPage) },
  { method: "POST", path: "/acompte/:token", handler: forToken(startPayment) },
  { method: "GET", path: "/acompte/:token/simulation", handler: forToken(simulationPage) },
  { method: "POST", path: "/acompte/:token/simulation", handler: forToken(simulationAction) },
  { method: "GET", path: "/agenda/:file", handler: agenda },
  { method: "GET", path: "/demo", handler: demoPage },
];

/**
 * Les envois des formulaires de `/acompte` viennent du site lui-même, jamais d'une page d'un autre site. Une adresse de
 * `/acompte/` que personne ne reconnaît (un lien mal recopié, une méthode inattendue) est une page à lire, jamais du JSON.
 */
const SITE_FORMS = "/acompte/";

/** Tout `/api/admin/` passe par `adminApi`, qui vérifie le propriétaire avant même de chercher la route. */
const ADMIN = "/api/admin/";

/**
 * Une exception devient une réponse 500. Le journal reçoit la route et le message, jamais le corps, l'adresse ni
 * les champs : aucune donnée personnelle.
 */
async function guarded(label: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error(`${label} : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    return json({ error: "server_error" }, 500);
  }
}

export async function handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith(ADMIN)) {
    return guarded(`${req.method} ${ADMIN}*`, () => adminApi(req, deps, ctx, pathname));
  }

  const found = findRoute(ROUTES, req.method, pathname);
  if (found instanceof Response) return pathname.startsWith(SITE_FORMS) ? notFoundPage() : found;
  const { route, params } = found;
  return guarded(`${route.method} ${route.path}`, async () => {
    if (req.method === "POST" && pathname.startsWith(SITE_FORMS) && fromOtherOrigin(req, deps.env.BASE_URL)) {
      return otherOriginPage();
    }
    return route.handler(req, deps, ctx, params);
  });
}
