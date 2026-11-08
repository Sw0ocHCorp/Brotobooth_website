import { expect, test, type Locator, type Page } from "@playwright/test";
import { hasNoHorizontalOverflow } from "./layout";

/** Les trois animations de l'accueil (spec, section 7) : l'ouverture, le mur de tirages et l'arrivée des images. */

/** L'ouverture dure 2 s ; un peu plus, et elle est forcément finie. */
const AFTER_OPENING_MS = 2300;
/** Le mur s'adapte à l'écran : 8 tirages sur un téléphone (moins de 760 px), 9 au-delà. */
const printsFor = (page: Page) => (page.viewportSize()!.width < 760 ? 8 : 9);

/** L'angle de rotation de la transformation calculée d'un élément, en degrés. */
const angleOf = (element: Locator) =>
  element.evaluate((node) => {
    const { a, b } = new DOMMatrix(getComputedStyle(node).transform);
    return (Math.atan2(b, a) * 180) / Math.PI;
  });

/** Les éléments de `selector` vus en vol, notés à chaque image depuis l'appel : `flown()` dit combien. */
const watchFlights = async (page: Page, selector: string) => {
  await page.evaluate((selector) => {
    const flown = new Set<Element>();
    const watch = () => {
      for (const element of document.querySelectorAll(selector)) if (element.getAnimations().length) flown.add(element);
      document.body.dataset.flown = String(flown.size);
      requestAnimationFrame(watch);
    };
    watch();
  }, selector);
  return () => page.evaluate(() => Number(document.body.dataset.flown));
};

test("l'ouverture se termine dans l'en-tête et révèle le contenu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(1);
  await page.waitForTimeout(AFTER_OPENING_MS);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.locator(".print")).not.toHaveCount(0);
  // Le logo plat de la barre prend le relais, et le contenu n'est plus voilé.
  await expect(page.getByRole("banner").locator(".logo svg")).toHaveCSS("opacity", "0.9");
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
  await expect(page.getByRole("navigation", { name: "Menu principal" })).toHaveCSS("opacity", "1");
});

test("un toucher termine l'ouverture aussitôt", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(1);
  await page.mouse.click(10, 10);
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
});

test("un toucher sur un bouton encore caché termine l'ouverture sans l'activer", async ({ browser, viewport }) => {
  const context = await browser.newContext({ hasTouch: true, viewport });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(1);
  const box = (await page.getByRole("link", { name: "Choisir une date" }).first().boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe("/");
  await context.close();
});

test("un défilement termine l'ouverture aussitôt", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(1);
  await page.mouse.move(200, 200);
  await page.mouse.wheel(0, 400);
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
});

test("l'ouverture ne rejoue pas dans la même visite", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(AFTER_OPENING_MS);
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
});

test("avec réduction des animations : pas d'ouverture, mur immobile, contenu visible", async ({ browser, viewport }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
  await expect(page.locator(".print")).toHaveCount(printsFor(page));
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

  // Les images des sections sont déjà à leur place, et rien ne bouge en descendant la page.
  for (const shot of await page.locator(".shot").all()) {
    await shot.scrollIntoViewIfNeeded();
    await expect(shot).toBeVisible();
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await context.close();
});

test("si le stockage de session est interdit, la page fonctionne", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new Error("interdit");
      },
    }),
  );
  await page.goto("/");
  await page.waitForTimeout(AFTER_OPENING_MS);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
  await expect(page.locator(".hero-copy")).toHaveCSS("opacity", "1");
});

test("arrivée sur une section : pas d'ouverture, la section s'affiche", async ({ page }) => {
  await page.goto("/#formules");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Les formules" })).toBeInViewport();
});

test("le mur compte 9 tirages sur ordinateur, 8 sur téléphone, sans débordement", async ({ page }) => {
  await page.goto("/");
  await page.mouse.click(10, 10);
  const prints = page.locator("#wall .print");
  await expect(prints).toHaveCount(printsFor(page));
  // Les vrais tirages de la borne, jamais une image de banque.
  for (const src of await prints.locator("img").evaluateAll((images) => images.map((image) => image.getAttribute("src")))) {
    expect(src).toMatch(/^\/media\/tirage-[1-8]\.webp$/);
  }
  // Chaque tirage se pose en partie dans l'ouverture, qui garde les débords pour elle.
  const hero = (await page.locator("#hero").boundingBox())!;
  for (const print of await prints.all()) {
    await expect.poll(() => print.evaluate((node) => node.getAnimations().length)).toBe(0);
    const box = (await print.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(hero.x);
    expect(box.x).toBeLessThan(hero.x + hero.width);
  }
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
});

test("les images de section arrivent une fois et finissent à leur place", async ({ page }) => {
  await page.goto("/");
  await page.mouse.click(10, 10);
  const shots = page.locator(".shot");
  await expect(shots).toHaveCount(6);
  // Pas encore arrivée, une image est déjà lue par un lecteur d'écran, avec son texte alternatif.
  const founders = page.getByRole("img", { name: "Les deux fondateurs dos à dos, photographiés par la borne" });
  await expect(founders).toHaveCount(1);
  await expect(founders.locator("xpath=..")).toHaveClass(/\btoss\b/);
  const flown = await watchFlights(page, ".shot");
  for (const shot of await shots.all()) {
    // Dans la page : `scrollIntoViewIfNeeded` attendrait que l'image ne bouge plus.
    await shot.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect(shot).toBeVisible();
    // Le vol est lancé au prochain passage de l'observateur, pas au défilement : sans cette attente, « aucune animation »
    // serait vrai avant même le départ, et l'angle serait lu au premier instant du vol. `toss` part avec `animate()`.
    await expect(shot).not.toHaveClass(/\btoss\b/);
    await expect.poll(() => shot.evaluate((node) => node.getAnimations().length)).toBe(0);
    const rest = await shot.evaluate((node) => parseFloat(getComputedStyle(node).getPropertyValue("--r")));
    expect(await angleOf(shot)).toBeCloseTo(rest, 1);
  }
  expect(await flown()).toBe(6);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  // Revenir sur une image ne la relance pas.
  await page.evaluate(() => scrollTo(0, 0));
  await shots.first().evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  expect(await shots.first().evaluate((node) => node.getAnimations().length)).toBe(0);
});
