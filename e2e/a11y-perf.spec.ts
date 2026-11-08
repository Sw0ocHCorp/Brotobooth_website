import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Les contrôles d'avant ouverture (spec, section 11) : accessibilité automatique de chaque page, et rapidité d'affichage de l'accueil. */

/** WCAG AA pour un texte courant ; le titre, grand, n'en demande que 3, mais on lui applique la même exigence. */
const CONTRAST_MIN = 4.5;
const PAGES = ["/", "/reserver", "/cgv", "/mentions-legales", "/confidentialite", "/admin/"];

/** Attend la fin de l'ouverture du logo et de toute animation en cours : axe mesurerait le contraste d'un texte encore voilé. */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
}

for (const path of PAGES) {
  test(`aucune violation d'accessibilité sur ${path}`, async ({ page }) => {
    await page.goto(path);
    await settled(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

// ---------- le titre au-dessus du mur ----------

/**
 * Le plus faible contraste, sur les pixels de la page, entre le texte de `selector` et ce qu'il y a derrière lui. Axe ne peut
 * pas juger un fond en dégradé (« incomplete », jamais une violation) : le texte est rendu transparent, la zone photographiée,
 * puis chaque pixel du fond comparé à la couleur du texte posé dessus (WCAG 2.1, 1.4.3).
 */
async function weakestContrast(page: Page, selector: string): Promise<number> {
  const target = page.locator(selector).first();
  const clip = (await target.boundingBox())!;
  const png = await page.screenshot({ clip, animations: "disabled", style: `${selector} { color: transparent !important; text-shadow: none !important; }` });
  const color = await target.evaluate((element) => getComputedStyle(element).color);
  return page.evaluate(
    async ({ data, color }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const [red, green, blue, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
      const linear = (value: number) => ((value /= 255) <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      let weakest = Infinity;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        const text = luminance(alpha * red + (1 - alpha) * r, alpha * green + (1 - alpha) * g, alpha * blue + (1 - alpha) * b);
        const back = luminance(r, g, b);
        weakest = Math.min(weakest, (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05));
      }
      return weakest;
    },
    { data: png.toString("base64"), color },
  );
}

test("le titre reste lisible au-dessus du mur", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await expect(page.locator("#wall .print").first()).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#hero").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
  for (const selector of ["#hero h1", "#hero .hero-copy p", "#hero .btn.ghost"]) {
    const weakest = await weakestContrast(page, selector);
    console.log(`Contraste le plus faible, ${selector}, ${page.viewportSize()!.width} px : ${weakest.toFixed(2)}`);
    expect(weakest, selector).toBeGreaterThanOrEqual(CONTRAST_MIN);
  }
});

// ---------- rapidité ----------

/** Le profil du plan : 4 Mb/s (soit 500 000 octets par seconde) et 20 ms de latence. */
const PROFILE = { offline: false, latency: 20, downloadThroughput: 500_000, uploadThroughput: 500_000 };
/** L'objectif de la spec : le titre, plus grand élément affiché au chargement, apparaît en moins de 2,5 s. */
const LCP_BUDGET_MS = 2500;
/** Un chargement isolé varie avec la machine : on en mesure trois, chacun à froid, et on garde le médian. */
const LOADS = 3;

type Lcp = { time: number; element: string };

/**
 * Le plus grand élément affiché d'un chargement de l'accueil à froid, sous le profil du plan : `PerformanceObserver`
 * garde le dernier candidat, qui reste celui du chargement tant que le visiteur ne touche à rien.
 */
async function measureLcp(page: Page): Promise<Lcp> {
  await page.addInitScript(() => {
    new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1) as PerformanceEntry & { element?: Element; url?: string };
      const element = entry.element;
      const name = element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}` : "(supprimé)";
      Reflect.set(window, "lcp", { time: entry.startTime, element: entry.url ? `${name} ${entry.url.split("/").pop()}` : name });
    }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", PROFILE);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Le mur arrive après l'ouverture (2 s) : on attend qu'elle soit finie pour que ses tirages aient pu devenir le candidat.
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  return page.evaluate(() => Reflect.get(window, "lcp") as Lcp);
}

for (const [label, reducedMotion] of [
  ["avec l'ouverture", "no-preference"],
  ["avec réduction des animations", "reduce"],
] as const) {
  test(`LCP sous 2,5 s en 4G simulée, ${label}`, async ({ browser, browserName, viewport }) => {
    test.skip(browserName !== "chromium", "les mesures de rapidité passent par le protocole de Chromium");
    const loads: Lcp[] = [];
    for (let load = 0; load < LOADS; load++) {
      const context = await browser.newContext({ viewport, reducedMotion });
      loads.push(await measureLcp(await context.newPage()));
      await context.close();
    }
    loads.sort((a, b) => a.time - b.time);
    const median = loads[Math.floor(LOADS / 2)];
    const summary = loads.map(({ time, element }) => `${Math.round(time)} ms (${element})`).join(", ");
    console.log(`LCP ${label}, ${viewport!.width} px : ${summary}`);
    test.info().annotations.push({ type: "lcp", description: summary });
    expect(median.time).toBeLessThan(LCP_BUDGET_MS);
  });
}
