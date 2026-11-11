import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { normalTier, pricesBody, type PricesBody } from "../worker/offer";
import { placesLine } from "../src/scripts/prices";
import { discountText, euros, isBookable, launchBody, normalPrice, offer, plansOf, refillText } from "./seed";

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

test("une carte par borne : ses formules et le lien pour la réserver, ou « Bientôt disponible »", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator("#formules").getByRole("article");
  await expect(cards).toHaveCount(offer.booths.length);
  for (const [index, booth] of offer.booths.entries()) {
    const card = cards.nth(index);
    await expect(card.getByRole("heading", { level: 3 })).toHaveText(booth.name);
    for (const line of booth.includes) await expect(card).toContainText(line);

    // Une borne à venir le dit en toutes lettres, et rien ne mène à sa réservation.
    if (!isBookable(offer, booth.id)) {
      await expect(card).toContainText("Bientôt disponible.");
      await expect(card.getByRole("link")).toHaveCount(0);
      continue;
    }
    await expect(card).not.toContainText("Bientôt");
    for (const plan of plansOf(offer, booth.id)) {
      const row = card.getByRole("listitem").filter({ hasText: new RegExp(`^\\s*${plan.prints} tirages`) });
      await expect(row).toHaveCount(1);
      // Une formule encore sans prix (offre provisoire) n'affiche aucun montant.
      if (normalPrice(plan) > 0) await expect(row).toContainText(euros(normalPrice(plan)));
      else await expect(row).not.toContainText("€");
    }
    // Un seul lien par borne : le nombre de tirages se choisit ensuite, sur la réservation.
    await expect(card.getByRole("link")).toHaveCount(1);
    await expect(card.getByRole("link")).toHaveText(`Choisir le ${booth.name}`);
    await expect(card.getByRole("link")).toHaveAttribute("href", `/reserver?borne=${booth.id}`);
  }
});

// Une carte large éloignerait chaque prix de son nombre de tirages : sur ordinateur, une carte garde le tiers de la section,
// côte à côte avec les autres et la première sous le titre ; sur téléphone, elles prennent toute la largeur.
test("les cartes des formules gardent une largeur lisible, alignées sous le titre", async ({ page, viewport }) => {
  await page.goto("/");
  const [title, grid] = await Promise.all([
    page.getByRole("heading", { name: "Les formules" }).boundingBox(),
    page.locator("#formules .plans").boundingBox(),
  ]);
  const boxes = await Promise.all((await page.locator("#formules").getByRole("article").all()).map((card) => card.boundingBox()));
  expect(Math.abs(boxes[0]!.x - title!.x)).toBeLessThan(1);
  for (const [index, box] of boxes.entries()) {
    if (viewport!.width > 860) {
      expect(box!.width, `carte ${index + 1}`).toBeLessThanOrEqual(grid!.width / 3 + 1);
      if (index < 3) expect(box!.y, `carte ${index + 1}`).toBe(boxes[0]!.y);
    } else {
      expect(Math.abs(box!.width - grid!.width), `carte ${index + 1}`).toBeLessThan(1);
    }
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
  // Seule la borne à venir, à la demande du propriétaire, dit « Bientôt disponible. » : rien d'autre n'est annoncé pour plus tard.
  await expect(page.getByRole("main")).not.toContainText(/Bientôt(?! disponible\.)|Boîte à questions|notre premier/);
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

// ---------- l'offre de lancement sur la carte du BrotoBooth ----------

const answerWith = (page: Page, body: PricesBody) =>
  page.route("**/api/prices", (route) => route.fulfill({ json: body }));

const bookableCard = (page: Page) => page.locator("#formules").getByRole("article").nth(offer.booths.findIndex((booth) => isBookable(offer, booth.id)));

test.describe("l'offre de lancement", () => {
  test.skip(offer.tiers[0].places === undefined, "aucun palier limité dans l'offre");

  test("pendant l'offre, la carte montre le prix du moment, le prix normal barré et les places", async ({ page }) => {
    const body = launchBody(7);
    await answerWith(page, body);
    await page.goto("/");
    const card = bookableCard(page);
    await expect(card.locator("[data-launch]")).toBeVisible();
    await expect(card).toContainText("Offre de lancement");
    await expect(card).toContainText(placesLine(7));
    // « Offre de lancement » en pastille blanche.
    await expect(card.locator("[data-launch] strong")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    for (const plan of plansOf(offer, offer.booths.find((booth) => isBookable(offer, booth.id))!.id)) {
      const row = card.getByRole("listitem").filter({ hasText: new RegExp(`^\\s*${plan.prints} tirages`) });
      const { priceCents, normalCents } = body.plans[plan.id];
      await expect(row).toContainText(discountText(priceCents, normalCents));
      // À l'écran : la pastille d'économie, le prix normal barré, puis le prix du moment.
      const [saving, struck, price] = [row.locator(".saving"), row.locator("s"), row.locator("b")];
      await expect(saving).toBeVisible();
      await expect(saving).toContainText(`−${euros(normalCents - priceCents)}`);
      await expect(saving).toHaveCSS("background-color", "rgb(255, 255, 255)");
      const [savingBox, struckBox, priceBox] = await Promise.all([saving.boundingBox(), struck.boundingBox(), price.boundingBox()]);
      expect(savingBox!.x + savingBox!.width).toBeLessThanOrEqual(struckBox!.x);
      expect(struckBox!.x + struckBox!.width).toBeLessThanOrEqual(priceBox!.x);
      await expect(row.locator("s")).toBeVisible();
      await expect(row.locator("s")).toHaveText(new RegExp(euros(normalCents)));
      await expect(row.locator("b")).toHaveCSS("font-weight", "800");
    }
    await expect(card).toContainText("Recharge de 100 tirages");
    await expect(card).not.toContainText("le jour J");
    await expect(card.locator("[data-refill]")).toHaveText(refillText(body));
  });

  test("une seule place restante se dit au singulier", async ({ page }) => {
    await answerWith(page, launchBody(1));
    await page.goto("/");
    await expect(bookableCard(page)).toContainText("Plus qu'une place à ce prix");
  });

  test("hors offre, la carte garde les prix normaux", async ({ page }) => {
    await answerWith(page, pricesBody(offer, { tier: normalTier(offer), remaining: null, launch: false }));
    await page.goto("/");
    await expect(page.locator("#formules [data-amount]").first()).toBeVisible();
    await expect(page.locator("#formules [data-amount]").first()).toHaveCSS("font-weight", "800");
    await expect(page.locator("#formules [data-launch]")).toBeHidden();
    await expect(page.locator("#formules s")).toHaveCount(0);
    await expect(page.locator("#formules .saving")).toHaveCount(0);
    await expect(bookableCard(page).locator("[data-refill]")).toHaveText(euros(normalTier(offer).refillCents));
  });

  for (const [name, fail] of [
    ["injoignable", (page: Page) => page.route("**/api/prices", (route) => route.abort())],
    ["en erreur 500", (page: Page) => page.route("**/api/prices", (route) => route.fulfill({ status: 500, body: "boom" }))],
  ] as const) {
    test(`sans réponse de /api/prices (${name}), la carte garde les prix normaux`, async ({ page }) => {
      await fail(page);
      await page.goto("/");
      await expect(page.locator("#formules [data-amount]").first()).toBeVisible();
      await expect(page.locator("#formules [data-launch]")).toBeHidden();
      await expect(page.locator("#formules s")).toHaveCount(0);
      await expect(page.locator("#formules .saving")).toHaveCount(0);
    });
  }
});
