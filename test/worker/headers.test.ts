import { describe, expect, it } from "vitest";
import publicHeaders from "../../public/_headers?raw";
import { page } from "../../worker/html";
import { CONTENT_SECURITY_POLICY, DEFAULT_HEADERS, html, json, redirect } from "../../worker/http";

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

describe("la politique de sécurité du contenu", () => {
  it("est celle du plan : pas de script écrit dans la page, Turnstile et Stripe pour seules exceptions", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(POLICY);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("est la même sur toute réponse du Worker, JSON, page, redirection ou flux d'agenda (tous passent par DEFAULT_HEADERS)", () => {
    const responses = [json({}), json({ error: "not_found" }, 404), html(page("Titre", "<p>Texte</p>")), redirect("/")];
    for (const response of responses) {
      expect(response.headers.get("Content-Security-Policy")).toBe(POLICY);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(DEFAULT_HEADERS["Content-Security-Policy"]).toBe(POLICY);
    expect(DEFAULT_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("garde `same-origin` sur les pages du Worker : leurs formulaires ont besoin de l'en-tête Origin", () => {
    expect(html("<p>x</p>").headers.get("Referrer-Policy")).toBe("same-origin");
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
