import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import publicHeaders from "../../public/_headers?raw";
import { page } from "../../worker/html";
import { CONTENT_SECURITY_POLICY, DEFAULT_HEADERS, html, json, redirect } from "../../worker/http";
import { handle } from "../../worker/router";
import { fakeDeps } from "../support";

/** La politique du plan (tâche 18), mot pour mot : ce que le site autorise, et rien d'autre. */
const POLICY =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
  "form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'self'";

/** `public/_headers` lu comme Cloudflare : une règle par chemin non indenté, ses en-têtes en dessous. */
function staticRules(text: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
    } else {
      const colon = line.indexOf(":");
      current![line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return rules;
}

/** Ce que porte toute réponse du Worker, quelle qu'elle soit. */
function expectSiteHeaders(response: Response, label = response.url): void {
  expect(response.headers.get("Content-Security-Policy"), label).toBe(POLICY);
  expect(response.headers.get("X-Content-Type-Options"), label).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy"), label).toBe("same-origin");
}

describe("la politique de sécurité du contenu", () => {
  it("est celle du plan : pas de script écrit dans la page, Turnstile et Stripe pour seules exceptions", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(POLICY);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("est la même sur toute réponse du Worker : JSON, page, redirection (tous passent par DEFAULT_HEADERS)", () => {
    const responses = [json({}), json({ error: "not_found" }, 404), html(page("Titre", "<p>Texte</p>")), redirect("/")];
    for (const response of responses) expectSiteHeaders(response);
    expect(DEFAULT_HEADERS["Content-Security-Policy"]).toBe(POLICY);
    expect(DEFAULT_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(DEFAULT_HEADERS["Referrer-Policy"]).toBe("same-origin");
  });

  it("couvre le flux d'agenda, l'API et les routes inconnues, servis par le routeur", async () => {
    const TOKEN = "d3f1c0de5eed";
    const deps = fakeDeps({ env: { ...env, CALENDAR_TOKEN: TOKEN } });
    for (const path of [`/agenda/${TOKEN}.ics`, "/agenda/faux.ics", "/api/availability?from=2026-12-01&to=2026-12-31", "/inconnu"]) {
      expectSiteHeaders(await handle(new Request(`https://brotobooth.fr${path}`), deps, createExecutionContext()), path);
    }
    // Le flux d'agenda est bien un calendrier, non une page : la politique le couvre quand même.
    const feed = await handle(new Request(`https://brotobooth.fr/agenda/${TOKEN}.ics`), deps, createExecutionContext());
    expect(feed.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
  });

  it("garde `same-origin` : les formulaires des pages du Worker ont besoin de l'en-tête Origin, que `no-referrer` ferait envoyer à `null`", () => {
    expect(html("<p>x</p>").headers.get("Referrer-Policy")).toBe("same-origin");
    expect(json({}).headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("n'autorise aucun script en ligne dans les pages du Worker, qui n'ont qu'une feuille de style en ligne", () => {
    const body = page("Titre", "<p>Texte</p>");
    expect(body).not.toMatch(/<script/i);
    expect(body).toMatch(/<style>/);
  });
});

describe("public/_headers", () => {
  const rules = staticRules(publicHeaders);

  it("donne aux fichiers statiques la même politique et les mêmes en-têtes que le Worker", () => {
    expect(rules.get("/*")).toEqual({
      "Content-Security-Policy": POLICY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
  });

  it("écarte /admin des moteurs de recherche, avec ou sans la barre finale que Cloudflare ajoute", () => {
    expect(rules.get("/admin")).toEqual({ "X-Robots-Tag": "noindex" });
    expect(rules.get("/admin/*")).toEqual({ "X-Robots-Tag": "noindex" });
  });
});
