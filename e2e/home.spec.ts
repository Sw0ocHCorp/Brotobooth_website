import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { FIRST_PLAN, offer } from "./seed";

const ROSE = "rgb(242, 85, 155)";
const ORANGE = "rgb(255, 138, 61)";
const CLEAR = "rgba(0, 0, 0, 0)";
const SECTIONS = ["Ce que vivent vos invités", "Un combiné sur le côté ?", "Les formules", "Une date en tête ?"];

const menu = (page: Page) => page.getByRole("navigation", { name: "Menu principal" });

/** Le nombre de boutons pleins de rose dont une partie est dans la fenêtre. */
const roseButtonsInView = (page: Page) =>
  page.evaluate(
    (rose) =>
      [...document.querySelectorAll("a, button")].filter((element) => {
        const { top, bottom, width } = element.getBoundingClientRect();
        return getComputedStyle(element).backgroundColor === rose && width > 0 && bottom > 0 && top < innerHeight;
      }).length,
    ROSE,
  );

test.describe("sans JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("la page raconte les sections dans l'ordre, sans JavaScript", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Réservez votre photobooth");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(SECTIONS);
    await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();

    // Chaque section se lit sans animation : les vraies photos sont là, posées de biais comme des tirages.
    const photos = page.getByRole("main").getByRole("img");
    await expect(photos).toHaveCount(6);
    for (const photo of await photos.all()) {
      await photo.scrollIntoViewIfNeeded();
      await expect(photo).toBeVisible();
      await expect(photo.locator("xpath=..")).toHaveCSS("transform", /^matrix\(/);
    }
    // Sans script pour la retirer, la barre garde son voile : elle reste lisible au-dessus des sections.
    await expect(page.getByRole("banner")).not.toHaveCSS("background-color", CLEAR);
  });
});

test("le menu mène aux trois destinations", async ({ page }) => {
  await page.goto("/");
  await expect(menu(page).getByRole("link")).toHaveText(["La borne", "Formules", "Réserver"]);
  await expect(page.getByRole("link", { name: "Réserver" })).toHaveAttribute("href", "/reserver");
  await expect(menu(page).getByRole("link", { name: "La borne" })).toHaveAttribute("href", "/#borne");
  await expect(menu(page).getByRole("link", { name: "Formules" })).toHaveAttribute("href", "/#formules");
  await expect(page.getByRole("banner").getByRole("link", { name: "Brotobooth, accueil" })).toHaveAttribute("href", "/");

  // La section atteinte par le menu commence sous la barre, qui reste à l'écran.
  await menu(page).getByRole("link", { name: "Formules" }).click();
  const title = page.getByRole("heading", { name: "Les formules" });
  await expect(title).toBeInViewport();
  const [bar, heading] = await Promise.all([page.getByRole("banner").boundingBox(), title.boundingBox()]);
  expect(heading!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
  await expect(menu(page)).toBeInViewport();
});

test("la barre est claire sur l'ouverture, puis voilée pour rester lisible", async ({ page }) => {
  await page.goto("/");
  const bar = page.getByRole("banner");
  await expect(bar).toHaveCSS("background-color", CLEAR);
  await page.getByRole("heading", { name: "Les formules" }).scrollIntoViewIfNeeded();
  await expect(bar).not.toHaveCSS("background-color", CLEAR);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(bar).toHaveCSS("background-color", CLEAR);
});

test("les formules viennent de la configuration et mènent à la réservation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Choisir cette formule", exact: true }).first()).toHaveAttribute("href", `/reserver?formule=${FIRST_PLAN.id}`);

  const cards = page.locator("#formules").getByRole("article");
  await expect(cards).toHaveCount(offer.plans.length);
  for (const [index, plan] of offer.plans.entries()) {
    const card = cards.nth(index);
    await expect(card.getByRole("heading", { level: 3 })).toHaveText(plan.name);
    const choose = card.getByRole("link", { name: "Choisir cette formule", exact: true });
    await expect(choose).toHaveAttribute("href", `/reserver?formule=${plan.id}`);
    await expect(choose).toHaveAccessibleDescription(plan.name);
    // Une formule encore sans prix (offre provisoire) n'affiche aucun montant.
    if (plan.priceCents > 0) await expect(card).toContainText("€");
    else await expect(card).not.toContainText("€");
    for (const line of plan.includes) await expect(card).toContainText(line);
  }
});

// Chaque phrase parle à celui qui réserve : ce que vivront ses invités, ce que nous installons chez lui, rien qui n'existe pas encore.
test("l'accueil parle à celui qui réserve", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#hero p")).toHaveText("Vos invités se prennent en photo, repartent avec leur tirage et se laissent des messages audio-vidéo au combiné.");
  await expect(page.locator(".founders blockquote")).toHaveText(/^Une borne construite de nos mains, que nous venons installer chez vous\.$/);
  await expect(page.locator(".founders p")).toHaveText(
    "Nous avons construit cette borne nous-mêmes, du meuble en bois au logiciel. Nous l'installons chez vous, sur le lieu de votre événement.",
  );
  await expect(page.getByRole("main")).not.toContainText(/Bientôt|Boîte à questions|notre premier/);
});

test("au plus un bouton rose par écran", async ({ page }) => {
  await page.goto("/");
  // Les deux boutons roses de la page, l'ouverture et la dernière section : blanc sur rose ne passe le contraste
  // qu'en grand texte, donc 19 px au moins et en gras.
  const rose = page.getByRole("link", { name: "Choisir une date" });
  await expect(rose).toHaveCount(2);
  for (const button of await rose.all()) {
    const style = await button.evaluate((element) => {
      const { backgroundColor, fontSize, fontWeight } = getComputedStyle(element);
      return { backgroundColor, fontSize: parseFloat(fontSize), fontWeight: Number(fontWeight) };
    });
    expect(style).toMatchObject({ backgroundColor: ROSE, fontWeight: 700 });
    expect(style.fontSize).toBeGreaterThanOrEqual(19);
  }

  // Une fenêtre glissée du haut en bas de la page, par quarts d'écran.
  const { height, step } = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, step: innerHeight / 4 }));
  for (let top = 0; top < height; top += step) {
    await page.evaluate((y) => scrollTo(0, y), top);
    expect(await roseButtonsInView(page), `fenêtre à ${top} px`).toBeLessThanOrEqual(1);
  }
});

test("aucune couleur de marque dans le texte", async ({ page }) => {
  await page.goto("/");
  const texts = page.locator("h1, h2, h3, p, a, span, li, b, blockquote, address");
  expect(await texts.count()).toBeGreaterThan(20);
  const colored = await texts.evaluateAll(
    (elements, brand) =>
      elements.filter((element) => brand.includes(getComputedStyle(element).color)).map((element) => element.textContent?.trim().slice(0, 40)),
    [ROSE, ORANGE],
  );
  expect(colored).toEqual([]);
});

test("aucun débordement horizontal, sur téléphone comme sur ordinateur, et cibles de 44 px", async ({ page }) => {
  await page.goto("/");
  await expect(menu(page).getByRole("link")).toHaveCount(3);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  expect(await smallTargets(page.locator("body"))).toEqual([]);
});

test("l'accueil et la page introuvable passent le contrôle d'accessibilité automatique", async ({ page }) => {
  for (const path of ["/", "/cette-page-n-existe-pas"]) {
    await page.goto(path);
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});

test("le pied de page donne le contact renseigné et les pages légales", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  for (const [name, href] of [["Mentions légales", "/mentions-legales"], ["CGV", "/cgv"], ["Confidentialité", "/confidentialite"]]) {
    await expect(footer.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  }
  // Un moyen de contact encore vide n'apparaît pas.
  const { phone, email, social } = offer.contact;
  await expect(footer.locator('a[href^="tel:"]')).toHaveCount(phone ? 1 : 0);
  await expect(footer.locator('a[href^="mailto:"]')).toHaveCount(email ? 1 : 0);
  if (phone) await expect(footer.getByRole("link", { name: phone })).toBeVisible();
  if (email) await expect(footer.getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
  for (const url of social) await expect(footer.locator(`a[href="${url}"]`)).toBeVisible();
});

test("une page 404 ramène à l'accueil", async ({ page }) => {
  const response = await page.goto("/cette-page-n-existe-pas");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cette page n'existe pas");
  await expect(menu(page).getByRole("link")).toHaveText(["La borne", "Formules", "Réserver"]);
  await page.getByRole("main").getByRole("link", { name: "Retour à l'accueil" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Réservez votre photobooth");
});
