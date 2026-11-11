import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { placesLine } from "../src/scripts/prices";
import { currentTier, normalTier, pricesBody, type Plan, type PricesBody } from "../worker/offer";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import {
  FIRST_PLAN,
  SECOND_PLAN,
  TEST_SITE_KEY,
  addDays,
  boothButton,
  choosePlan,
  cleanup,
  client,
  discountText,
  euros,
  expectContact,
  fakeTurnstile,
  fillDetails,
  isBookable,
  isTurnstile,
  isoDate,
  launchBody,
  refillText,
  normalPrice,
  offer,
  pickFreeDate,
  planButton,
  plansOf,
  reachDetails,
  seed,
  servePage,
  showDay,
  withSiteKey,
} from "./seed";

/** `/reserver` : la date, la formule et les coordonnées, dans la carte posée sur la vidéo de la borne (spec, sections 4 et 7). */

const ROSE = "rgb(242, 85, 155)";
const ORANGE = "rgb(255, 138, 61)";
const CLEAR = "rgba(0, 0, 0, 0)";
const REQUESTS = "**/api/requests";
const PRICES = "**/api/prices";
const isAvailability = (url: URL) => url.pathname === "/api/availability";
const POSTER = /\/media\/borne-boucle-poster\.webp$/;
const FILM = "/media/borne-boucle.mp4";
/** La version nette des grands écrans (1080p) ; FILM reste celle des téléphones, sous 3 Mo. */
const FILM_LARGE = "/media/borne-boucle-1080.mp4";
const LARGE_SCREEN = "(min-width: 1024px)";

const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** « samedi 12 décembre 2026 ». */
const longDate = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));

const days = (page: Page) => page.locator("#days");
const send = (page: Page) => page.getByRole("button", { name: "Envoyer ma demande" });
const terms = (page: Page) => page.getByLabel("J'accepte les conditions générales de vente");
const confirmed = (page: Page) => page.getByRole("heading", { name: "Merci, votre demande est envoyée !" });
const goOn = (page: Page) => page.getByRole("button", { name: "Continuer" });
const booths = (page: Page) => page.getByRole("group", { name: "Votre borne" });
const prints = (page: Page) => page.getByRole("group", { name: "Nombre de tirages" });

/** Une phrase qui invite à nous contacter n'est écrite que si l'offre dit comment. */
const hasContact = Boolean(offer.contact.phone || offer.contact.email);
/** Comment `ContactLine` invite à nous joindre : par téléphone s'il y en a un, sinon par e-mail. */
const reachUs = offer.contact.phone ? "appelez-nous" : "écrivez-nous";

/** Ce que le client a saisi est toujours là. */
async function expectKept(page: Page, who: ReturnType<typeof client>) {
  await expect(page.getByLabel("Type d'événement")).toHaveValue("Anniversaire");
  await expect(page.getByLabel("Horaires de l'événement")).toHaveValue(who.hours);
  await expect(page.getByLabel("Lieu")).toHaveValue(who.venue);
  await expect(page.getByLabel("Nom", { exact: true })).toHaveValue(who.name);
  await expect(page.getByLabel("Téléphone")).toHaveValue(who.phone);
  await expect(page.getByLabel("E-mail")).toHaveValue(who.email);
  await expect(terms(page)).toBeChecked();
}

test.afterEach(({ request }) => cleanup(request));

test("le parcours complet", async ({ page, request }) => {
  await page.goto("/reserver");
  const crumbs = page.getByRole("list", { name: "Étapes" });
  const current = crumbs.locator('[aria-current="step"]');
  await expect(current).toHaveText("1 · Date");
  await expect(page.getByRole("button", { name: "Continuer" })).toBeDisabled();
  const day = await pickFreeDate(page);
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(day).toHaveCSS("box-shadow", new RegExp(ORANGE.replace(/[()]/g, "\\$&")));
  const date = (await day.getAttribute("data-date"))!;
  const label = longDate(date).replace(/^./, (letter) => letter.toUpperCase());
  await expect(page.getByText(label, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Continuer" }).click();
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await expect(current).toHaveText("2 · Formule");
  await expect(goOn(page)).toBeDisabled();
  // La formule se choisit en deux temps : la borne, puis le nombre de tirages, qui n'apparaît qu'ensuite.
  await expect(prints(page)).toBeHidden();
  await boothButton(page, FIRST_PLAN.booth).click();
  await expect(boothButton(page, FIRST_PLAN.booth)).toHaveAttribute("aria-pressed", "true");
  await expect(prints(page)).toBeVisible();
  await expect(goOn(page)).toBeDisabled();
  await planButton(page, FIRST_PLAN).click();
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
  await expect(planButton(page, FIRST_PLAN)).toHaveCSS("box-shadow", new RegExp(ORANGE.replace(/[()]/g, "\\$&")));
  await goOn(page).click();

  await expect(current).toHaveText("3 · Coordonnées");
  const who = await fillDetails(page);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  await expect(crumbs).toBeHidden();
  const done = page.getByText(/répondons sous 72\sh/).filter({ visible: true });
  await expect(done).toContainText(`Nous gardons le ${longDate(date)} pour vous`);
  await expect(done).toContainText("Si vous ne voyez pas l'e-mail, regardez dans vos courriers indésirables.");
  await expect(page.getByRole("link", { name: "Retour à l'accueil" })).toHaveAttribute("href", "/");

  // La demande est arrivée telle que le client l'a saisie, et elle tient la date. Les demandes des tests précédents,
  // refusées par le nettoyage, restent sur cette date : seule compte celle de ce client.
  const { bookings } = await (await request.get(`/api/admin/bookings?from=${date}&to=${date}`)).json();
  expect(bookings.filter((booking: { client_email: string }) => booking.client_email === who.email)).toEqual([
    expect.objectContaining({
      status: "pending_review",
      plan: FIRST_PLAN.id,
      event_type: "Anniversaire",
      event_hours: who.hours,
      venue: who.venue,
      client_name: who.name,
      client_phone: who.phone,
      client_email: who.email,
    }),
  ]);
});

test("la borne vient avant les tirages : une borne à venir se voit sans se choisir, une autre montre ses seules formules", async ({ page }) => {
  await page.goto("/reserver");
  await pickFreeDate(page);
  await goOn(page).click();
  await expect(booths(page).getByRole("button")).toHaveCount(offer.booths.length);
  await expect(prints(page)).toBeHidden();

  for (const booth of offer.booths) {
    const button = boothButton(page, booth.id);
    await expect(button).toContainText(booth.name);
    if (booth.includes.length > 0) await expect(button).toContainText(booth.includes.join(" · "));
    if (!isBookable(offer, booth.id)) {
      // Atténuée sans être effacée : « Bientôt disponible » se lit comme les autres notes de la carte.
      await expect(button).toBeDisabled();
      await expect(button).toContainText("Bientôt disponible");
      await expect(button).toHaveCSS("opacity", "1");
      const soft = await page.locator(".res-note").first().evaluate((note) => getComputedStyle(note).color);
      await expect(button.getByText("Bientôt disponible")).toHaveCSS("color", soft);
      continue;
    }
    await expect(button).toBeEnabled();
    await expect(button).not.toContainText("Bientôt");
    await button.click();
    // Le focus reste sur la borne ; ses tirages apparaissent dessous, et seulement les siens.
    await expect(button).toBeFocused();
    const own = plansOf(offer, booth.id);
    await expect(prints(page).getByRole("button")).toHaveCount(own.length);
    for (const plan of own) {
      await expect(planButton(page, plan)).toBeVisible();
      await expect(planButton(page, plan)).toContainText(`${plan.prints} tirages`);
      if (normalPrice(plan) > 0) await expect(planButton(page, plan)).toContainText(euros(normalPrice(plan)));
      else await expect(planButton(page, plan)).not.toContainText("€");
    }
    const [group, list] = await Promise.all([booths(page).boundingBox(), prints(page).boundingBox()]);
    expect(list!.y).toBeGreaterThanOrEqual(group!.y + group!.height);
    await expect(goOn(page)).toBeDisabled();
  }
});

test("choisir une autre borne efface le nombre de tirages choisi", async ({ page }) => {
  // Une seconde borne réservable, posée dans la page servie : l'offre du site n'en a peut-être qu'une.
  const other = '<button type="button" class="choice" data-booth="borne-d-essai" aria-pressed="false"><b>Borne d\'essai</b></button>';
  await servePage(page, "/reserver", "Votre borne</p>", `Votre borne</p>${other}`);
  await page.goto("/reserver");
  await pickFreeDate(page);
  await goOn(page).click();
  await choosePlan(page, FIRST_PLAN);
  await expect(goOn(page)).toBeEnabled();

  await boothButton(page, "borne-d-essai").click();
  await expect(boothButton(page, "borne-d-essai")).toHaveAttribute("aria-pressed", "true");
  await expect(boothButton(page, FIRST_PLAN.booth)).toHaveAttribute("aria-pressed", "false");
  await expect(planButton(page, FIRST_PLAN)).toBeHidden();
  await expect(goOn(page)).toBeDisabled();
  // De retour sur la première borne, ses tirages sont à choisir de nouveau.
  await boothButton(page, FIRST_PLAN.booth).click();
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "false");
  await expect(goOn(page)).toBeDisabled();
});

// Firefox garde d'une visite à l'autre l'état `disabled` qu'un script a changé : la page ne s'y fie pas, le script le rétablit.
test("« Continuer » de la formule reste désactivé sans formule, même si la page servie ne le désactive pas", async ({ page }) => {
  await servePage(page, "/reserver", 'id="go-plan" disabled>', 'id="go-plan">');
  await page.goto("/reserver");
  await pickFreeDate(page);
  await goOn(page).click();
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await expect(goOn(page)).toBeDisabled();
  await boothButton(page, FIRST_PLAN.booth).click();
  await expect(goOn(page)).toBeDisabled();
  await planButton(page, FIRST_PLAN).click();
  await expect(goOn(page)).toBeEnabled();
});

test("le lien d'une borne la présélectionne : après la date, il reste le nombre de tirages à choisir", async ({ page }) => {
  await page.goto(`/reserver?borne=${SECOND_PLAN.booth}`);
  await pickFreeDate(page);
  await goOn(page).click();
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await expect(boothButton(page, SECOND_PLAN.booth)).toHaveAttribute("aria-pressed", "true");
  await expect(prints(page).getByRole("button")).toHaveCount(plansOf(offer, SECOND_PLAN.booth).length);
  await expect(goOn(page)).toBeDisabled();
  await planButton(page, SECOND_PLAN).click();
  await goOn(page).click();

  // Un retour montre la borne et la formule choisies, qui peuvent encore changer.
  await page.getByRole("button", { name: "Retour" }).click();
  await expect(boothButton(page, SECOND_PLAN.booth)).toHaveAttribute("aria-pressed", "true");
  await expect(planButton(page, SECOND_PLAN)).toHaveAttribute("aria-pressed", "true");
  await expect(goOn(page)).toBeEnabled();

  let sent: Record<string, unknown> | undefined;
  await page.route(REQUESTS, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { status: "created" } });
  });
  await goOn(page).click();
  await fillDetails(page);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  expect(sent).toMatchObject({ plan: SECOND_PLAN.id, terms: true, turnstile_token: "" });
});

test("le lien d'une borne à venir ou inconnue ne présélectionne rien", async ({ page }) => {
  const unbookable = offer.booths.filter((booth) => !isBookable(offer, booth.id)).map((booth) => booth.id);
  for (const wanted of [...unbookable, "inconnue"]) {
    await page.goto(`/reserver?borne=${wanted}`);
    await pickFreeDate(page);
    await goOn(page).click();
    await expect(page.getByRole("heading", { name: "Choisissez votre formule" }), wanted).toBeVisible();
    await expect(booths(page).getByRole("button"), wanted).toHaveCount(offer.booths.length);
    await expect(booths(page).locator('[aria-pressed="true"]'), wanted).toHaveCount(0);
    await expect(prints(page), wanted).toBeHidden();
  }
});

test("une formule que le serveur refuse ramène aux tirages, avec le message juste dessous", async ({ page }) => {
  await reachDetails(page);
  await fillDetails(page);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 422, json: { error: "invalid", fields: ["plan"] } }));
  await send(page).click();

  const problem = page.getByText("Cette formule n'est plus proposée. Choisissez-en une autre.");
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await expect(problem).toBeVisible();
  await expect(problem).toBeFocused();
  // La borne reste choisie ; le nombre de tirages est à choisir de nouveau.
  await expect(boothButton(page, FIRST_PLAN.booth)).toHaveAttribute("aria-pressed", "true");
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "false");
  await expect(goOn(page)).toBeDisabled();
  const [list, text] = await Promise.all([prints(page).boundingBox(), problem.boundingBox()]);
  expect(text!.y).toBeGreaterThanOrEqual(list!.y + list!.height);

  await planButton(page, FIRST_PLAN).click();
  await expect(problem).toBeHidden();
  await expect(goOn(page)).toBeEnabled();
});

// ---------- le prix du moment (spec de l'offre de lancement, sections 7 et 8) ----------
// Aucun test ne suppose le palier en cours : la base d'essai se remplit pendant la série. Ils lisent `/api/prices` ou le remplacent.

/** Le montant qu'un bouton de formule affiche pour `body` : « 150 €, au lieu de 250 €, soit −100 € » pendant l'offre, sinon le prix seul. */
function amountFor({ launch, plans }: PricesBody, plan: Plan): string {
  const { priceCents, normalCents } = plans[plan.id];
  return launch && priceCents !== normalCents ? discountText(priceCents, normalCents) : euros(priceCents);
}

const amount = (page: Page, plan: Plan) => planButton(page, plan).locator("[data-amount]");

test("l'envoi transmet le prix affiché", async ({ page }) => {
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/prices");
  // Intercepté puis relayé : le serveur reçoit la demande telle que la page l'envoie, et l'accepte.
  let sent: Record<string, unknown> | undefined;
  await page.route(REQUESTS, (route) => {
    sent = route.request().postDataJSON();
    return route.continue();
  });
  await reachDetails(page);
  const shown: PricesBody = await (await read).json();
  await expect(amount(page, FIRST_PLAN)).toHaveText(amountFor(shown, FIRST_PLAN));
  await fillDetails(page);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  expect(sent).toMatchObject({ plan: FIRST_PLAN.id, price_cents: shown.plans[FIRST_PLAN.id].priceCents });
});

test.describe("l'offre de lancement", () => {
  test.skip(offer.tiers[0].places === undefined, "aucun palier limité dans l'offre");

  test("l'étape 2 montre le prix du moment", async ({ page }) => {
    const body = launchBody(7);
    await page.route(PRICES, (route) => route.fulfill({ json: body }));
    await page.goto("/reserver");
    await pickFreeDate(page);
    await goOn(page).click();
    await boothButton(page, FIRST_PLAN.booth).click();

    // « Plus que 7 places à ce prix » au-dessus des tirages, la recharge après eux.
    const launch = prints(page).locator("[data-launch]");
    await expect(launch).toBeVisible();
    await expect(launch).toContainText("Offre de lancement");
    await expect(launch).toContainText(placesLine(7));
    const refill = prints(page).getByText("Recharge de 100 tirages");
    await expect(refill).not.toContainText("le jour J");
    await expect(refill).toBeVisible();
    await expect(refill).toContainText(euros(body.refillCents));
    await expect(prints(page).locator("[data-refill]")).toHaveText(refillText(body));
    await expect(launch.locator("strong")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const own = plansOf(offer, FIRST_PLAN.booth);
    const [top, first, last, bottom] = await Promise.all([
      launch.boundingBox(),
      planButton(page, own[0]).boundingBox(),
      planButton(page, own.at(-1)!).boundingBox(),
      refill.boundingBox(),
    ]);
    expect(top!.y + top!.height).toBeLessThanOrEqual(first!.y);
    expect(bottom!.y).toBeGreaterThanOrEqual(last!.y + last!.height);

    // Chaque bouton : l'économie en pastille, le prix normal barré, atténué, puis le prix du moment ; tout se lit après lui.
    const soft = await page.locator(".choices-label").first().evaluate((label) => getComputedStyle(label).color);
    for (const plan of own) {
      await expect(planButton(page, plan)).toContainText(`${plan.prints} tirages`);
      await expect(amount(page, plan)).toHaveText(amountFor(body, plan));
      const [price, struck] = [amount(page, plan).locator("b"), amount(page, plan).locator("s")];
      await expect(struck).toBeVisible();
      await expect(struck).toHaveCSS("color", soft);
      await expect(price).not.toHaveCSS("color", soft);
      await expect(struck).toHaveCSS("font-size", await price.evaluate((element) => getComputedStyle(element).fontSize));
      const saving = amount(page, plan).locator(".saving");
      await expect(saving).toBeVisible();
      await expect(saving).toHaveCSS("background-color", "rgb(255, 255, 255)");
      const [savingBox, priceBox, struckBox] = await Promise.all([saving.boundingBox(), price.boundingBox(), struck.boundingBox()]);
      expect(savingBox!.x + savingBox!.width).toBeLessThanOrEqual(struckBox!.x);
      expect(struckBox!.x + struckBox!.width).toBeLessThanOrEqual(priceBox!.x);
    }
  });

  test("sans réponse à la relecture, l'étape 2 revient aux prix normaux, jamais au prix refusé", async ({ page }) => {
    const body = launchBody(7);
    let reads = 0;
    await page.route(PRICES, (route) => (++reads === 1 ? route.fulfill({ json: body }) : route.abort()));
    await page.route(REQUESTS, (route) => route.fulfill({ status: 409, json: { error: "price_changed", price_cents: normalPrice(FIRST_PLAN) } }));
    await reachDetails(page);
    await expect(amount(page, FIRST_PLAN)).toHaveText(amountFor(body, FIRST_PLAN));
    await fillDetails(page);
    await send(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "Le prix de cette formule vient de changer" })).toBeFocused();
    await expect.poll(() => reads).toBe(2);

    await page.getByRole("button", { name: "Retour" }).click();
    await expect(prints(page)).toBeVisible();
    await expect(prints(page).locator("[data-launch]")).toBeHidden();
    await expect(prints(page).locator("s")).toHaveCount(0);
    await expect(prints(page).locator(".saving")).toHaveCount(0);
    for (const plan of plansOf(offer, FIRST_PLAN.booth)) await expect(amount(page, plan)).toHaveText(euros(normalPrice(plan)));
    await expect(prints(page).locator("[data-refill]")).toHaveText(euros(normalTier(offer).refillCents));
  });

  test("le message d'un prix changé ne parle que de sa formule", async ({ page }) => {
    const other = plansOf(offer, FIRST_PLAN.booth).find((plan) => plan.id !== FIRST_PLAN.id);
    test.skip(!other, "une seule formule pour cette borne");
    await page.route(PRICES, (route) => route.fulfill({ json: launchBody(7) }));
    await page.route(REQUESTS, (route) => route.fulfill({ status: 409, json: { error: "price_changed", price_cents: normalPrice(FIRST_PLAN) } }));
    await reachDetails(page);
    await fillDetails(page);
    await send(page).click();
    const problem = page.getByRole("alert").filter({ hasText: "Le prix de cette formule vient de changer" });
    await expect(problem).toBeVisible();

    // La même formule choisie de nouveau : le message parle toujours d'elle et reste.
    await page.getByRole("button", { name: "Retour" }).click();
    await planButton(page, FIRST_PLAN).click();
    await goOn(page).click();
    await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
    await expect(problem).toBeVisible();
    // Une autre formule : le message dirait un prix faux pour elle, il s'efface.
    await page.getByRole("button", { name: "Retour" }).click();
    await planButton(page, other!).click();
    await goOn(page).click();
    await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
    await expect(problem).toBeHidden();
  });

  /** Un `/api/prices` périmé pour `FIRST_PLAN` : le prix normal pendant l'offre réelle, celui du premier palier une fois l'offre finie. */
  const outdated = (real: PricesBody): PricesBody =>
    real.launch ? pricesBody(offer, { tier: normalTier(offer), remaining: null, launch: false }) : pricesBody(offer, currentTier(offer, {}));

  // Le client a vu un prix que le serveur ne tient plus (le cache de 30 s, un palier rempli entre-temps) : le serveur répond
  // vraiment `price_changed`. La page relit les prix ; si elle n'y arrive pas, le renvoi part quand même au prix annoncé.
  for (const [name, reread] of [
    ["un prix changé est expliqué, puis le renvoi aboutit", "answers"],
    ["renvoi au nouveau prix même si /api/prices ne répond plus", "fails"],
  ] as const) {
    test(name, async ({ page, request }) => {
      const real: PricesBody = await (await request.get("/api/prices")).json();
      const stale = outdated(real);
      const [was, now] = [stale.plans[FIRST_PLAN.id].priceCents, real.plans[FIRST_PLAN.id].priceCents];
      expect(was, "le corps de remplacement doit porter un autre prix que le vrai").not.toBe(now);
      let reads = 0;
      await page.route(PRICES, (route) => {
        if (++reads === 1) return route.fulfill({ json: stale });
        return reread === "answers" ? route.continue() : route.abort();
      });
      const sent: unknown[] = [];
      let held = Promise.resolve();
      await page.route(REQUESTS, async (route) => {
        sent.push(route.request().postDataJSON().price_cents);
        await held;
        return route.continue();
      });

      await reachDetails(page);
      await expect(amount(page, FIRST_PLAN)).toHaveText(amountFor(stale, FIRST_PLAN));
      const who = await fillDetails(page);
      await send(page).click();

      // Près du bouton d'envoi, sans quitter les coordonnées : la formule reste choisie et rien n'est à ressaisir.
      const problem = page.getByRole("alert").filter({ hasText: "Le prix de cette formule vient de changer" });
      await expect(problem).toHaveText(
        `Le prix de cette formule vient de changer : ${euros(now)} au lieu de ${euros(was)}. Si ce prix vous convient, envoyez à nouveau votre demande.`,
      );
      await expect(problem).toBeFocused();
      await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
      await expectKept(page, who);
      await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
      // Les prix de l'étape 2 sont relus ; sans réponse, ce sont les prix normaux, jamais un prix que le serveur a refusé.
      await expect.poll(() => reads).toBe(2);
      await expect(amount(page, FIRST_PLAN)).toHaveText(reread === "answers" ? amountFor(real, FIRST_PLAN) : euros(normalPrice(FIRST_PLAN)));

      // Le message s'efface dès l'envoi suivant, avant la réponse.
      let release = () => {};
      held = new Promise((resolve) => (release = resolve));
      await send(page).click();
      await expect(send(page)).toBeDisabled();
      await expect(problem).toBeHidden();
      release();
      await expect(confirmed(page)).toBeVisible();
      expect(sent).toEqual([was, now]);
    });
  }
});

// Le client renvoie une demande déjà reçue (double envoi, autre onglet) : rien n'est en double, et il sait où lire la suite.
test("une demande déjà reçue rassure le client sans rien envoyer de plus", async ({ page }) => {
  const date = await reachDetails(page);
  await fillDetails(page);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 200, json: { status: "already_requested" } }));
  await send(page).click();
  // Son propre titre : « Merci, votre demande est envoyée ! » contredirait « inutile de la renvoyer ».
  const heading = page.getByRole("heading", { level: 1, name: "Votre demande nous est déjà parvenue" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(confirmed(page)).toHaveCount(0);
  const note = page.getByText("inutile de la renvoyer").filter({ visible: true });
  await expect(note).toHaveText(
    new RegExp(`^Votre demande pour le ${longDate(date)} est bien enregistrée, inutile de la renvoyer\\. Vous trouverez dans vos e-mails son récapitulatif, puis notre réponse\\.$`),
  );
  await expect(page.getByText(/premier envoi|répondons sous/).filter({ visible: true })).toHaveCount(0);
});

test("une date prise est barrée et inactive", async ({ page, request }) => {
  const { date } = await seed(request, "pending");
  await page.goto("/reserver");
  const day = await showDay(page, date);
  await expect(day).toBeDisabled();
  await expect(day).toHaveCSS("text-decoration-line", "line-through");
  await expect(day).toHaveAccessibleName(`${longDate(date)}, déjà réservée`);
  // Une date libre voisine reste à prendre.
  const next = days(page).locator(`[data-date="${addDays(date, 1)}"]`);
  if ((await next.count()) > 0) await expect(next).toHaveAccessibleName(`${longDate(addDays(date, 1))}, libre`);
});

test("les dates trop proches sont inactives, et la page dit pourquoi", async ({ page, request }) => {
  const today = isoDate(new Date());
  const { earliest } = await (await request.get(`/api/availability?from=${today}&to=${addDays(today, 31)}`)).json();
  await page.goto("/reserver");
  await expect(days(page)).toHaveAttribute("aria-busy", "false");
  // Des jours grisés sans un mot laisseraient croire que tout est pris, ou que le site est en panne.
  const why = page.getByText(new RegExp(`En ligne, une date se réserve au moins ${offer.minLeadDays}\\sjours à l'avance\\.`));
  await expect(why).toBeVisible();
  await expect(why).toContainText(hasContact ? `Si c'est plus urgent, ${reachUs}` : /avance\.\s*$/);
  await expectContact(why);

  // Le calendrier s'ouvre sur le mois de la première date possible, et ne remonte pas avant.
  await expect(days(page).locator(`[data-date="${earliest}"]`)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Mois précédent" })).toBeDisabled();
  const shown = await days(page)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => ({ date: (button as HTMLElement).dataset.date!, off: (button as HTMLButtonElement).disabled })));
  expect(shown.length).toBeGreaterThanOrEqual(28);
  for (const { date, off } of shown.filter(({ date }) => date < earliest)) {
    expect(off, date).toBe(true);
    await expect(days(page).locator(`[data-date="${date}"]`)).toHaveAccessibleName(`${longDate(date)}, indisponible`);
  }
});

test("si la date vient d'être prise, le client le voit et revient au calendrier à jour", async ({ page, request }) => {
  const date = await reachDetails(page);
  const who = await fillDetails(page);
  // La date est prise pendant que le client remplit ses coordonnées. Prise par une date bloquée, qui ne prend aucune place
  // d'un palier : le prix que la page a lu reste celui du moment, et le serveur répond bien « date prise », jamais
  // `price_changed` (vérifié avant la date), quel que soit l'ordre des tests.
  await seed(request, "blocked", { date });

  const refreshed = page.waitForRequest((req) => isAvailability(new URL(req.url())));
  await send(page).click();
  await expect(page.getByRole("heading", { name: "Choisissez votre date" })).toBeVisible();
  await expect(page.getByText("Cette date vient d'être réservée par quelqu'un d'autre. Choisissez-en une autre : vos informations sont conservées.")).toBeVisible();
  await refreshed;
  const day = days(page).locator(`[data-date="${date}"]`);
  await expect(day).toBeDisabled();
  await expect(day).toHaveCSS("text-decoration-line", "line-through");
  await expect(day).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Aucune date choisie")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuer" })).toBeDisabled();

  // Une autre date, et rien n'est à ressaisir : la formule et les coordonnées sont gardées.
  await pickFreeDate(page);
  await expect(page.getByText("Cette date vient d'être réservée par quelqu'un d'autre")).toBeHidden();
  await page.getByRole("button", { name: "Continuer" }).click();
  await expectKept(page, who);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
});

test("une coupure réseau garde la saisie et donne le contact", async ({ page }) => {
  await reachDetails(page);
  const who = await fillDetails(page);
  const problem = page.getByRole("alert").filter({ hasText: "Votre demande n'a pas pu partir. Vos informations sont conservées : réessayez dans un instant." });

  // La connexion coupée, puis le serveur en panne : à chaque fois, la saisie reste et le contact apparaît.
  await page.route(REQUESTS, (route) => route.abort("internetdisconnected"));
  await send(page).click();
  await expect(problem).toBeVisible();
  await expectContact(problem);
  await expectKept(page, who);
  await expect(send(page)).toBeEnabled();

  await page.unroute(REQUESTS);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 503, json: { error: "server_error" } }));
  await send(page).click();
  await expect(problem).toBeVisible();
  await expectKept(page, who);

  await page.unroute(REQUESTS);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
});

test("un refus anti-robots ou trop de demandes s'expliquent, et un nouvel essai reste possible", async ({ page }) => {
  await reachDetails(page);
  const who = await fillDetails(page);
  // Trop de demandes en cours pour une adresse e-mail, ou trop de demandes parties d'une même connexion : deux phrases, car
  // la seconde ne dit rien des demandes de ce client, qui peut n'en avoir aucune.
  const MANY_REQUESTS = `Vous avez déjà ${offer.maxActivePerEmail} demande`;
  const SHARED_CONNECTION = "Nous ne pouvons pas enregistrer de nouvelle demande depuis cette connexion pour le moment. Réessayez demain";
  for (const [status, json, text, other] of [
    [403, { error: "bot" }, "La vérification de sécurité n'a pas abouti. Vos informations sont conservées", MANY_REQUESTS],
    [429, { error: "too_many", reason: "email" }, MANY_REQUESTS, SHARED_CONNECTION],
    [429, { error: "too_many", reason: "ip" }, SHARED_CONNECTION, MANY_REQUESTS],
  ] as const) {
    await page.route(REQUESTS, (route) => route.fulfill({ status, json }));
    await send(page).click();
    const problem = page.getByRole("alert").filter({ hasText: text });
    await expect(problem).toBeVisible();
    await expect(problem).not.toContainText(other, { useInnerText: true }); // les autres phrases sont dans la page, masquées
    await expectContact(problem);
    await expectKept(page, who);
    await expect(send(page)).toBeEnabled();
    await page.unroute(REQUESTS);
  }
  // La limite de la connexion ne reproche rien au client, et ne l'invite à nous contacter que si l'offre dit comment.
  const shared = page.locator('[data-problem="too_many_ip"]');
  await expect(shared).not.toContainText(/beaucoup|24 heures/i);
  if (hasContact) await expect(shared).toContainText("ou contactez-nous pour réserver dès maintenant.");
  else await expect(shared).toHaveText(/Réessayez demain\.$/);
  // La limite par adresse e-mail dit combien de demandes en cours elle permet, et quand en envoyer une autre. Une demande
  // en cours attend notre réponse, ou, acceptée, son acompte : la phrase ne promet ni délai de réponse ni acompte.
  const several = offer.maxActivePerEmail > 1;
  const limit = page.locator('[data-problem="too_many"]');
  await expect(limit).toHaveText(
    new RegExp(
      `^\\s*Vous avez déjà ${offer.maxActivePerEmail} demandes? en cours avec nous\\. Vous pourrez en envoyer une nouvelle ` +
        `${several ? "dès que l'une d'elles" : "dès qu'elle"} sera confirmée ou terminée\\s; la suite vous arrive par e-mail\\.\\s*$`,
    ),
  );
  await expect(limit).not.toContainText(/répondons|acompte|72/);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
});

test("une erreur de champ se voit à côté du champ", async ({ page }) => {
  await reachDetails(page);
  await fillDetails(page);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 422, json: { error: "invalid", fields: ["phone"] } }));
  await send(page).click();

  const phone = page.getByLabel("Téléphone");
  const message = page.getByText("Vérifiez votre numéro de téléphone");
  await expect(message).toBeVisible();
  await expect(phone).toBeFocused();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await expect(phone).toHaveAccessibleDescription(/Vérifiez votre numéro de téléphone/);
  // Juste sous le champ, aligné sur lui.
  const [field, text] = await Promise.all([phone.boundingBox(), message.boundingBox()]);
  expect(text!.y).toBeGreaterThanOrEqual(field!.y + field!.height);
  expect(text!.y - (field!.y + field!.height)).toBeLessThan(12);
  expect(Math.abs(text!.x - field!.x)).toBeLessThan(4);
  // Les autres champs ne sont pas mis en cause, et corriger le champ efface le message.
  await expect(page.getByLabel("Nom", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
  await phone.fill("06 98 76 54 32");
  await expect(message).toBeHidden();
  await expect(phone).not.toHaveAttribute("aria-invalid", "true");
});

test("un champ oublié est signalé avant l'envoi, sans rien envoyer", async ({ page }) => {
  await reachDetails(page);
  // Aucun type d'événement n'est choisi d'avance : un oubli n'envoie pas « Mariage » à la place du client.
  const type = page.getByLabel("Type d'événement");
  await expect(type).toHaveValue("");
  await expect(type.locator("option").first()).toHaveText("Choisir…");
  await fillDetails(page);
  await type.selectOption({ index: 0 });
  await page.getByLabel("Nom", { exact: true }).fill("");
  await terms(page).uncheck();
  let posts = 0;
  await page.route(REQUESTS, (route) => {
    posts++;
    return route.fulfill({ status: 201, json: { status: "created" } });
  });
  await send(page).click();
  await expect(type).toBeFocused();
  await expect(page.getByText("Choisissez le type d'événement.")).toBeVisible();
  await expect(type).toHaveAccessibleDescription("Choisissez le type d'événement.");
  await expect(page.getByText("Indiquez votre nom")).toBeVisible();
  await expect(page.getByText("Acceptez les conditions générales de vente")).toBeVisible();
  expect(posts).toBe(0);
});

test("si les disponibilités ne répondent pas, le contact remplace le calendrier", async ({ page }) => {
  await page.route(isAvailability, (route) => route.abort("internetdisconnected"));
  await page.goto("/reserver");
  const down = page.getByRole("alert").filter({ hasText: "Nous n'arrivons pas à afficher le calendrier pour le moment." });
  await expect(down).toBeVisible();
  await expectContact(down);
  await expect(days(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Mois suivant" })).toBeHidden();

  // Dès que le calendrier répond de nouveau, il revient.
  await page.unroute(isAvailability);
  await page.getByRole("button", { name: "Réessayer" }).click();
  await expect(down).toBeHidden();
  await expect(await pickFreeDate(page)).toHaveAttribute("aria-pressed", "true");
});

test("le bouton Précédent du navigateur revient à l'étape d'avant, sans rien perdre", async ({ page }) => {
  const date = await reachDetails(page);
  const who = await fillDetails(page);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await expect(boothButton(page, FIRST_PLAN.booth)).toHaveAttribute("aria-pressed", "true");
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Choisissez votre date" })).toBeVisible();
  await expect(days(page).locator(`[data-date="${date}"]`)).toHaveAttribute("aria-pressed", "true");

  await page.goForward();
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
  await expectKept(page, who);
  expect(new URL(page.url()).pathname).toMatch(/^\/reserver\/?$/); // toujours sur la page (servie en /reserver/)
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
});

test("si le script anti-robots ne se charge pas, un refus le redemande et l'envoi aboutit", async ({ page }) => {
  await withSiteKey(page, "/reserver");
  let scripts = 0;
  await page.route(isTurnstile, (route) =>
    ++scripts === 1 ? route.abort("internetdisconnected") : route.fulfill({ contentType: "text/javascript", body: fakeTurnstile() }),
  );
  // Le Worker refuse une demande sans jeton (siteverify répond « échec »), et accepte celle qui en porte un.
  const tokens: string[] = [];
  await page.route(REQUESTS, (route) => {
    const token = route.request().postDataJSON().turnstile_token;
    tokens.push(token);
    return token ? route.fulfill({ status: 201, json: { status: "created" } }) : route.fulfill({ status: 403, json: { error: "bot" } });
  });

  await reachDetails(page);
  await expect(page.locator("#turnstile")).toHaveAttribute("data-sitekey", TEST_SITE_KEY);
  await expect.poll(() => scripts).toBe(1);
  await fillDetails(page);
  await send(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "La vérification de sécurité n'a pas abouti" })).toBeVisible();
  await expect.poll(() => scripts).toBe(2);
  await page.waitForFunction(() => "turnstile" in window);

  // Revenir aux coordonnées ne charge pas le script une fois de plus.
  await page.getByRole("button", { name: "Retour" }).click();
  await page.getByRole("button", { name: "Continuer" }).click();
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  expect(tokens).toEqual(["", "jeton-de-test"]);
  expect(scripts).toBe(2);
});

test("une panne pendant l'envoi laisse le formulaire utilisable", async ({ page }) => {
  await withSiteKey(page, "/reserver");
  await page.route(isTurnstile, (route) => route.fulfill({ contentType: "text/javascript", body: fakeTurnstile({ failOnce: true }) }));
  let posts = 0;
  await page.route(REQUESTS, (route) => {
    posts++;
    return route.fulfill({ status: 201, json: { status: "created" } });
  });
  await reachDetails(page);
  await page.waitForFunction(() => "turnstile" in window);
  const who = await fillDetails(page);

  // La lecture du jeton lève : rien n'est parti, le client le sait, et le bouton répond de nouveau.
  await send(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Votre demande n'a pas pu partir" })).toBeVisible();
  await expect(send(page)).toBeEnabled();
  await expectKept(page, who);
  expect(posts).toBe(0);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  expect(posts).toBe(1);
});

test("un double clic n'envoie qu'une demande", async ({ page }) => {
  await reachDetails(page);
  await fillDetails(page);
  let posts = 0;
  let answer = () => {};
  const answered = new Promise<void>((resolve) => (answer = resolve));
  await page.route(REQUESTS, async (route) => {
    posts++;
    await answered;
    await route.fulfill({ status: 201, json: { status: "created" } });
  });
  await send(page).dblclick();
  // Pendant l'envoi, le bouton ne répond plus.
  await expect(send(page)).toBeDisabled();
  answer();
  await expect(confirmed(page)).toBeVisible();
  expect(posts).toBe(1);
});

test("la vidéo tourne derrière la carte, sans son", async ({ page }) => {
  const poster = page.waitForResponse(POSTER);
  await page.goto("/reserver");
  const video = page.locator("video");
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toBeVisible();
  expect((await poster).ok()).toBe(true);

  const playable = await video.evaluate((film: HTMLVideoElement) => film.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "");
  if (playable) {
    await expect.poll(() => video.evaluate((film: HTMLVideoElement) => !film.paused && film.currentTime > 0)).toBe(true);
  } else {
    // Ce navigateur ne lit pas le H.264 (le Chromium de Playwright) : l'image fixe reste, sans aucun message d'erreur,
    // ni bouton de pause pour une vidéo qui ne tourne pas.
    await expect(video).toHaveAttribute("poster", "/media/borne-boucle-poster.webp");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /vidéo/ })).toHaveCount(0);
  }

  // La carte est au-dessus de la vidéo : le centre de la carte appartient à la carte.
  const card = page.locator(".card");
  const box = (await card.boundingBox())!;
  expect(
    await card.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x, y)), [box.x + box.width / 2, box.y + box.height / 2]),
  ).toBe(true);
});

test("la vidéo se met en pause et repart, au clavier", async ({ page }) => {
  await page.goto("/reserver");
  const video = page.locator("video");
  test.skip(
    !(await video.evaluate((film: HTMLVideoElement) => film.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "")),
    "ce navigateur ne lit pas la vidéo : il n'y a rien à mettre en pause",
  );
  const pause = page.getByRole("button", { name: "Mettre la vidéo en pause" });
  const resume = page.getByRole("button", { name: "Relancer la vidéo" });
  await expect(pause).toBeVisible();
  // Discret : ni rose, ni sous la carte, et 44 px à toucher.
  await expect(pause).not.toHaveCSS("background-color", ROSE);
  const [box, card] = await Promise.all([pause.boundingBox(), page.locator(".card").boundingBox()]);
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  const overlaps = box!.x < card!.x + card!.width && card!.x < box!.x + box!.width && box!.y < card!.y + card!.height && card!.y < box!.y + box!.height;
  expect(overlaps).toBe(false);

  // Au clavier, dès le haut de la page.
  for (let step = 0; step < 6 && !(await pause.evaluate((button) => button === document.activeElement)); step++) await page.keyboard.press("Tab");
  await expect(pause).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => video.evaluate((film: HTMLVideoElement) => film.paused)).toBe(true);
  await expect(resume).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => video.evaluate((film: HTMLVideoElement) => !film.paused)).toBe(true);
  await expect(pause).toBeFocused();
});

test("avec réduction des animations ou économie de données, seule l'image fixe s'affiche", async ({ browser, viewport }) => {
  const saveData = () => Object.defineProperty(navigator, "connection", { value: { saveData: true } });
  for (const [label, reducedMotion, init] of [
    ["réduction des animations", "reduce", undefined],
    ["économie de données", "no-preference", saveData],
  ] as const) {
    const context = await browser.newContext({ viewport, reducedMotion });
    const page = await context.newPage();
    if (init) await page.addInitScript(init);
    const films: string[] = [];
    page.on("request", (req) => {
      if ([FILM, FILM_LARGE].includes(new URL(req.url()).pathname)) films.push(req.url());
    });
    const poster = page.waitForResponse(POSTER);
    await page.goto("/reserver");
    await page.waitForLoadState("networkidle");
    const video = page.locator("video");
    expect((await poster).ok(), label).toBe(true);
    await expect(video, label).toBeVisible();
    expect(await video.evaluate((film: HTMLVideoElement) => film.paused), label).toBe(true);
    expect(films, label).toEqual([]);
    // Rien ne bouge : pas de bouton pour mettre en pause.
    await expect(page.getByRole("button", { name: /vidéo/ }), label).toHaveCount(0);
    await context.close();
  }
});

test("un grand écran reçoit la vidéo nette, un téléphone la vidéo légère", async ({ page, request, viewport }) => {
  await page.goto("/reserver");
  const sources = page.locator("video source");
  expect(await sources.evaluateAll((all) => all.map((source) => [source.getAttribute("src"), source.getAttribute("media")]))).toEqual([
    [FILM_LARGE, LARGE_SCREEN],
    [FILM, null],
  ]);
  // Le navigateur prend la première source dont `media` convient à l'écran.
  const chosen = await sources.evaluateAll((all) =>
    all.find((source) => { const media = source.getAttribute("media"); return !media || matchMedia(media).matches; })?.getAttribute("src"),
  );
  expect(chosen).toBe(viewport!.width >= 1024 ? FILM_LARGE : FILM);

  // Les deux fichiers existent, à leur poids : 3 Mo au plus pour les téléphones, 8 Mo pour les grands écrans.
  for (const [path, maxBytes] of [[FILM, 3 * 1024 * 1024], [FILM_LARGE, 8 * 1024 * 1024]] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toBe("video/mp4");
    expect((await response.body()).byteLength, path).toBeLessThanOrEqual(maxBytes);
  }
});

test("tient sur un téléphone, sans débordement", async ({ page, viewport }) => {
  const card = page.locator(".card");
  const check = async (step: string) => {
    expect(await hasNoHorizontalOverflow(page), step).toBe(true);
    expect(await smallTargets(page.locator("body")), step).toEqual([]);
    const box = (await card.boundingBox())!;
    if (viewport!.width < 760) {
      // Sur un téléphone, la carte prend la largeur, entre les deux marges.
      expect(box.x, step).toBeGreaterThanOrEqual(16);
      expect(viewport!.width - (box.x + box.width), step).toBeGreaterThanOrEqual(16);
    } else {
      // Sur un ordinateur, elle se range à droite pour laisser voir la borne.
      expect(box.x, step).toBeGreaterThan(viewport!.width / 2);
    }
  };

  await page.goto("/reserver");
  await expect(days(page)).toHaveAttribute("aria-busy", "false");
  await check("date");
  await pickFreeDate(page);
  await page.getByRole("button", { name: "Continuer" }).click();
  await check("formule");
  await boothButton(page, FIRST_PLAN.booth).click();
  await check("nombre de tirages");
  await planButton(page, FIRST_PLAN).click();
  await page.getByRole("button", { name: "Continuer" }).click();
  await check("coordonnées");
  await page.route(REQUESTS, (route) => route.fulfill({ status: 201, json: { status: "created" } }));
  await fillDetails(page);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  await check("demande envoyée");
});

test("le calendrier s'utilise au clavier", async ({ page }) => {
  await page.goto("/reserver");
  await expect(days(page)).toHaveAttribute("aria-busy", "false");
  const next = page.getByRole("button", { name: "Mois suivant" });
  await next.focus();
  await page.keyboard.press("Enter"); // le mois suivant est tout entier au-delà du délai minimum
  await expect(next).toBeFocused();
  await expect(days(page)).toHaveAttribute("aria-busy", "false");

  await page.keyboard.press("Tab");
  const date = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.date);
  expect(date).toBeTruthy();
  const day = days(page).locator(`[data-date="${date}"]`);
  await expect(day).toBeFocused();
  await expect(day).toHaveCSS("outline-style", "solid");
  await expect(day).toHaveCSS("outline-color", ORANGE);
  await page.keyboard.press("Enter");
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(day).toBeFocused();

  const go = page.getByRole("button", { name: "Continuer" });
  for (let step = 0; step < 45 && !(await go.evaluate((button) => button === document.activeElement)); step++) await page.keyboard.press("Tab");
  await expect(go).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Choisissez votre formule" })).toBeFocused();
  // La borne : choisie au clavier, elle garde le focus.
  const booth = boothButton(page, FIRST_PLAN.booth);
  const focused = (locator: Locator) => locator.evaluate((element) => element.contains(document.activeElement));
  for (let step = 0; step < offer.booths.length && !(await focused(booth)); step++) await page.keyboard.press("Tab");
  await expect(booth).toBeFocused();
  await page.keyboard.press("Space");
  await expect(booth).toHaveAttribute("aria-pressed", "true");
  await expect(booth).toBeFocused();
  // Ses tirages viennent juste après les bornes : la première tabulation qui quitte les bornes arrive sur sa première formule.
  for (let step = 0; step < offer.booths.length && (await focused(booths(page))); step++) await page.keyboard.press("Tab");
  await expect(planButton(page, plansOf(offer, FIRST_PLAN.booth)[0])).toBeFocused();
  await page.keyboard.press("Space");
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
  await expect(go).toBeEnabled();
});

test("la barre se réduit au logo et à Accueil", async ({ page }) => {
  await page.goto("/reserver");
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("navigation", { name: "Menu principal" }).getByRole("link")).toHaveText(["Accueil"]);
  await expect(bar.getByRole("link", { name: "Accueil", exact: true })).toHaveAttribute("href", "/");
  await expect(bar.getByRole("link", { name: "Brotobooth, accueil" })).toHaveAttribute("href", "/");
  await expect(bar.getByRole("link")).toHaveCount(2);
  // Claire sur la vidéo ; voilée dès que la carte passe dessous, pour rester lisible.
  await expect(bar).toHaveCSS("background-color", CLEAR);
  await page.setViewportSize({ width: 375, height: 560 });
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(bar).not.toHaveCSS("background-color", CLEAR);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(bar).toHaveCSS("background-color", CLEAR);
});

test("chaque étape passe le contrôle d'accessibilité automatique", async ({ page }) => {
  const audit = async (step: string) => expect((await new AxeBuilder({ page }).analyze()).violations, step).toEqual([]);
  await page.goto("/reserver");
  await expect(days(page)).toHaveAttribute("aria-busy", "false");
  await audit("date");
  await pickFreeDate(page);
  await page.getByRole("button", { name: "Continuer" }).click();
  await audit("formule");
  await choosePlan(page, FIRST_PLAN);
  await audit("formule choisie");
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.route(REQUESTS, (route) => route.fulfill({ status: 422, json: { error: "invalid", fields: ["phone", "email"] } }));
  await fillDetails(page);
  await send(page).click();
  await expect(page.getByLabel("Téléphone")).toBeFocused();
  await audit("coordonnées, avec erreurs");
  await page.unroute(REQUESTS);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 201, json: { status: "created" } }));
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  await audit("demande envoyée");
});

test.describe("sans JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("sans JavaScript, la page donne le téléphone et l'e-mail", async ({ page }) => {
    await page.goto("/reserver");
    const notice = page.getByText("Le calendrier ne s'affiche pas sur votre navigateur. Essayez-en un autre.");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(hasContact ? `Pour réserver sans le calendrier, ${reachUs}` : /autre\.\s*$/);
    await expect(notice).not.toContainText("JavaScript");
    await expectContact(notice);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choisissez votre date");
    // Rien d'inutilisable : ni calendrier vide, ni bouton qui ne mène nulle part, ni commandes de la vidéo sous le voile.
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.locator("video")).toBeHidden();
    // L'image fixe de la borne reste derrière la carte.
    await expect(page.getByRole("main")).toHaveCSS("background-image", /\/media\/borne-boucle-poster\.webp/);
    expect((await page.request.get("/media/borne-boucle-poster.webp")).ok()).toBe(true);
  });
});
