import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
// Le chargeur de Playwright n'importe un JSON qu'avec son attribut de type, d'où l'import direct plutôt que `worker/offer.ts`.
import offerJson from "../config/offer.json" with { type: "json" };
import type { Offer } from "../worker/offer";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { cleanup, reachDetails, seed } from "./seed";

/** Les pages légales, le référencement et les en-têtes de sécurité (spec, sections 7, 9 et 10). */

const offer: Offer = offerJson;

const SITE = "https://brotobooth.fr";
/** Le marqueur de tout fait d'entreprise qui manque encore : `scripts/check-launch.mjs` refuse de publier tant qu'il reste. */
const TODO = "[À compléter]";
/** Les cinq pages publiques, avec l'adresse que le site sert : Cloudflare ajoute la barre finale à un dossier. */
const PUBLIC = [
  { path: "/", served: "/" },
  { path: "/reserver", served: "/reserver/" },
  { path: "/mentions-legales", served: "/mentions-legales/" },
  { path: "/cgv", served: "/cgv/" },
  { path: "/confidentialite", served: "/confidentialite/" },
];
const LEGAL = [
  { name: "Mentions légales", path: "/mentions-legales", title: "Mentions légales" },
  { name: "CGV", path: "/cgv", title: "Conditions générales de vente" },
  { name: "Confidentialité", path: "/confidentialite", title: "Politique de confidentialité" },
];
/** La clé de test de Cloudflare : la page servie reçoit celle-ci à la place de la clé vide de la construction d'essai. */
const TEST_SITE_KEY = "1x00000000000000000000AA";
const isTurnstile = (url: URL) => url.hostname === "challenges.cloudflare.com";
/** Un `<script>` sans `src`, sauf un bloc de données JSON-LD, que la politique n'exécute pas. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i;

/** Ce que la politique de sécurité a refusé sur la page : les événements `securitypolicyviolation`, et les erreurs de console. */
async function watchPolicy(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => console.error(`[csp] ${event.violatedDirective} ${event.blockedURI}`));
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

test.afterEach(({ request }) => cleanup(request));

test.describe("pages légales", () => {
  // Sans l'ouverture du logo, qui couvre l'accueil et prend les clics pendant ses deux secondes.
  test.use({ reducedMotion: "reduce" });

  test("les pages légales sont accessibles depuis le pied de page", async ({ page }) => {
    for (const { name, path, title } of LEGAL) {
      await page.goto("/");
      await page.getByRole("contentinfo").getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${path}/?$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    }
  });

  test("le statut de brouillon n'est que dans un commentaire HTML, et le texte n'emploie aucun mot interne", async ({ page, request }) => {
    for (const { path } of LEGAL) {
      expect(await (await request.get(path)).text(), path).toMatch(/<article>\s*<!-- Brouillon à faire valider par un professionnel/);
      await page.goto(path);
      await expect(page.getByRole("main"), path).not.toContainText(/brouillon|valider|statut|bloquer/i);
    }
  });

  test("les pages légales tiennent sur l'écran, sans débordement, avec des cibles de 44 px", async ({ page }) => {
    for (const { path, title } of LEGAL) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      expect(await hasNoHorizontalOverflow(page), path).toBe(true);
      expect(await smallTargets(page.locator("body")), path).toEqual([]);
    }
  });

  test("les pages légales passent le contrôle d'accessibilité automatique", async ({ page }) => {
    for (const { path, title } of LEGAL) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
    }
  });

  test("les CGV parlent d'acompte et portent leur version", async ({ page }) => {
    await page.goto("/cgv");
    await expect(page.getByText(/acompte/i).first()).toBeVisible();
    await expect(page.getByText(offer.termsVersion)).toBeVisible();
  });

  test("l'acompte engage les deux parties, laisse le solde dû et porte le pourcentage de l'offre", async ({ page }) => {
    await page.goto("/cgv");
    const deposit = page.getByRole("region", { name: "L'acompte" });
    await expect(deposit).toContainText("engage les deux parties");
    await expect(deposit).toContainText("solde reste dû");
    // Tant que l'offre est provisoire, le pourcentage n'est pas inventé.
    await expect(deposit).toContainText(offer.draft ? TODO : `${offer.depositPercent} %`);
    await expect(deposit).toContainText(`${offer.paymentHours} h`);
  });

  test("les CGV réservent un paragraphe à la conclusion du professionnel sur la rétractation, et disent l'annulation et la médiation", async ({ page }) => {
    await page.goto("/cgv");
    const withdrawal = page.getByRole("region", { name: "Droit de rétractation" });
    await expect(withdrawal).toContainText("L221-28, 12°");
    await expect(withdrawal).toContainText(/conclusion du professionnel\s*:/i);
    await expect(page.getByRole("region", { name: "Annulation par vous" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Annulation par Brotobooth" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Médiation" })).toContainText("médiateur de la consommation");
  });

  test("la confidentialité dit ce que reçoit Telegram, et jamais l'adresse e-mail", async ({ page }) => {
    await page.goto("/confidentialite");
    const recipients = page.getByRole("region", { name: "Qui reçoit vos données" });
    await expect(recipients.getByRole("listitem")).toHaveCount(4);
    for (const name of ["Cloudflare", "Stripe", "Resend", "Telegram"]) {
      await expect(recipients.getByRole("listitem").filter({ hasText: name })).toHaveCount(1);
    }
    const telegram = recipients.getByRole("listitem").filter({ hasText: "Telegram" });
    await expect(telegram).toContainText("votre nom");
    await expect(telegram).toContainText("le lieu de votre événement");
    await expect(telegram).toContainText("votre numéro de téléphone");
    await expect(telegram).toContainText("jamais votre adresse e-mail");
    await expect(telegram).toContainText("canal d'alerte");
  });

  test("la confidentialité donne la durée de conservation, les droits et Turnstile", async ({ page }) => {
    await page.goto("/confidentialite");
    await expect(page.getByRole("region", { name: "Combien de temps nous les gardons" })).toContainText("12 mois");
    await expect(page.getByRole("region", { name: "Vos droits" })).toContainText(/CNIL/);
    await expect(page.getByRole("region", { name: "Vérification anti-robots" })).toContainText("Turnstile");
    await expect(page.getByRole("region", { name: "Cookies" })).toContainText("aucun cookie");
  });

  test("les mentions légales disent qui édite le site, et un fait manquant porte le marqueur", async ({ page }) => {
    await page.goto("/mentions-legales");
    for (const heading of ["Éditeur du site", "Hébergeur", "Contact"]) {
      await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    }
    // Un SIRET renseigné ou le marqueur : jamais un champ vide, ni un numéro inventé.
    await expect(page.locator("dt", { hasText: "SIRET" }).locator("+ dd")).toContainText(/\[À compléter\]|\d{14}/);
  });
});

test.describe("la case des conditions de vente", () => {
  test("renvoie vers les CGV dans un nouvel onglet, sans rien perdre, et reste une case à cocher", async ({ page }) => {
    await reachDetails(page);
    const terms = page.getByLabel("J'accepte les conditions générales de vente");
    const link = page.getByRole("link", { name: "conditions générales de vente" });
    await expect(link).toHaveAttribute("href", "/cgv");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /\bnoopener\b/);
    await page.getByLabel("Nom").fill("Camille Durand");

    // Le lien ouvre les CGV à côté : la page, sa saisie et la case restent comme ils étaient.
    const [opened] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await opened.waitForLoadState();
    expect(new URL(opened.url()).pathname).toMatch(/^\/cgv\/?$/);
    await expect(opened.getByRole("heading", { level: 1 })).toHaveText("Conditions générales de vente");
    await opened.close();
    await expect(page.getByLabel("Nom")).toHaveValue("Camille Durand");
    await expect(terms).not.toBeChecked();

    // La case se coche par elle-même, et par le début de sa phrase, hors du lien.
    await terms.check();
    await expect(terms).toBeChecked();
    await page.getByText("J'accepte les").click({ position: { x: 8, y: 8 } });
    await expect(terms).not.toBeChecked();
    await page.getByText("J'accepte les").click({ position: { x: 8, y: 8 } });
    await expect(terms).toBeChecked();
  });
});

test("chaque page publique a un titre, une description et son adresse canonique, et l'accueil ses données structurées", async ({ page }) => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const { path, served } of PUBLIC) {
    await page.goto(path);
    const title = await page.title();
    const description = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(title.trim().length, `titre de ${path}`).toBeGreaterThan(10);
    expect(description.trim().length, `description de ${path}`).toBeGreaterThan(50);
    titles.add(title);
    descriptions.add(description);
    await expect(page.locator('link[rel="canonical"]'), path).toHaveAttribute("href", `${SITE}${served}`);
    await expect(page.locator('meta[name="robots"]'), path).toHaveCount(0);
    await expect(page.locator('script[type="application/ld+json"]'), path).toHaveCount(path === "/" ? 1 : 0);
  }
  expect(titles.size, "un titre par page").toBe(PUBLIC.length);
  expect(descriptions.size, "une description par page").toBe(PUBLIC.length);

  // Seuls les faits qui existent : le nom, l'adresse du site et une vraie photo. Ni adresse, ni téléphone inventés.
  await page.goto("/");
  const data = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
  expect(data).toEqual({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Brotobooth",
    url: SITE,
    image: expect.stringMatching(/^https:\/\/brotobooth\.fr\/media\/[\w-]+\.webp$/),
  });
  expect((await page.request.get(new URL(data.image).pathname)).ok()).toBe(true);
});

test("/admin et /demo ne sont pas indexés, les pages publiques le sont", async ({ request }) => {
  for (const path of ["/admin", "/demo"]) {
    expect((await request.get(path)).headers()["x-robots-tag"], path).toContain("noindex");
  }
  for (const { path } of PUBLIC) {
    expect((await request.get(path)).headers()["x-robots-tag"], path).toBeUndefined();
  }
});

test("robots.txt exclut /admin, /acompte, /agenda, /api, /demo, et le plan du site existe", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const lines = (await robots.text()).split("\n").map((line) => line.trim());
  expect(lines).toContain("User-agent: *");
  for (const path of ["/admin", "/acompte", "/agenda", "/api", "/demo"]) expect(lines, path).toContain(`Disallow: ${path}`);
  // Rien de public n'est exclu, ni la racine.
  expect(lines.filter((line) => line.startsWith("Disallow:"))).toHaveLength(5);
  expect(lines).toContain(`Sitemap: ${SITE}/sitemap.xml`);

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.headers()["content-type"]).toContain("xml");
  const locations = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, location]) => location);
  expect(locations).toEqual(PUBLIC.map(({ served }) => `${SITE}${served}`));
});

test("la même politique de sécurité couvre les fichiers statiques et les réponses du Worker", async ({ request }) => {
  const policies = new Set<string>();
  for (const path of ["/", "/reserver", "/admin", "/robots.txt", "/media/tirage-1.webp", "/demo", "/api/availability", "/agenda/inconnu.ics", "/cette-page-n-existe-pas"]) {
    const headers = (await request.get(path)).headers();
    policies.add(headers["content-security-policy"] ?? `aucune sur ${path}`);
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    // `same-origin` et non `strict-origin-when-cross-origin` : les formulaires de /acompte ont besoin de l'en-tête Origin.
    expect(headers["referrer-policy"], path).toBe("same-origin");
  }
  expect([...policies]).toHaveLength(1);
  const [policy] = [...policies];
  expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com;");
  expect(policy).toContain("frame-ancestors 'none'");
});

test("aucune page n'écrit de script dans son HTML", async ({ request }) => {
  const paths = [...PUBLIC.map(({ path }) => path), "/admin", "/demo", "/cette-page-n-existe-pas", "/acompte/inconnu"];
  for (const path of paths) {
    expect(await (await request.get(path)).text(), path).not.toMatch(INLINE_SCRIPT);
  }
});

test("la politique de sécurité refuse un script écrit dans la page", async ({ page }) => {
  await page.goto("/");
  const refused = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
        const script = document.createElement("script");
        script.textContent = "window.injected = true";
        document.head.append(script);
        setTimeout(() => resolve("rien"), 1000);
      }),
  );
  expect(refused).toMatch(/^script-src/);
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
});

test("la politique de sécurité n'interrompt rien", async ({ page }) => {
  const problems = await watchPolicy(page);
  for (const path of ["/", "/reserver", "/admin", ...LEGAL.map(({ path: legal }) => legal)]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // Les images du mur, la vidéo et les polices : tout ce que la page charge à l'arrivée et au défilement.
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState("networkidle");
  }
  expect(problems).toEqual([]);
});

test("la politique de sécurité laisse passer Turnstile : son script et son cadre", async ({ page }) => {
  const problems = await watchPolicy(page);
  const requested: string[] = [];
  await page.route(isTurnstile, (route) => {
    requested.push(route.request().resourceType());
    if (route.request().resourceType() === "script") {
      return route.fulfill({
        contentType: "text/javascript",
        body: `window.turnstile = {
          render: (box) => { const frame = document.createElement("iframe"); frame.src = "https://challenges.cloudflare.com/cdn-cgi/essai"; box.append(frame); return "widget-1"; },
          getResponse: () => "", reset: () => {},
        };`,
      });
    }
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>widget</title>" });
  });
  await page.route((url) => url.pathname === "/reserver", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("data-sitekey>", `data-sitekey="${TEST_SITE_KEY}">`) });
  });

  await reachDetails(page);
  await expect.poll(() => page.frames().some((frame) => isTurnstile(new URL(frame.url() || "about:blank")))).toBe(true);
  expect(requested).toEqual(["script", "document"]);
  expect(problems).toEqual([]);
});

test("la politique de sécurité laisse payer l'acompte : pages du Worker, formulaires et redirections", async ({ page, request }) => {
  const problems = await watchPolicy(page);
  const booking = await seed(request, "awaiting");
  await page.goto(`/acompte/${booking.token}`);
  await page.getByRole("button", { name: /Payer l'acompte/ }).click();
  await expect(page.getByRole("heading", { name: "Simulation" })).toBeVisible();
  // La feuille de style écrite dans la page du Worker s'applique : `style-src` la permet.
  await expect(page.locator(".card")).toHaveCSS("border-top-left-radius", "22px");
  await page.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await expect(page).toHaveURL(/\/acompte\/[^/]+\?paid=1$/);
  expect(problems).toEqual([]);
});

test("aucun cookie déposé sur les pages publiques", async ({ page, context }) => {
  for (const { path } of PUBLIC) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(await context.cookies()).toEqual([]);
});
