import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { FIRST_PLAN, SECOND_PLAN, addDays, cleanup, client, fillDetails, isoDate, offer, pickFreeDate, planButton, reachDetails, seed, showDay } from "./seed";

/** `/reserver` : la date, la formule et les coordonnées, dans la carte posée sur la vidéo de la borne (spec, sections 4 et 7). */

const ROSE = "rgb(242, 85, 155)";
const ORANGE = "rgb(255, 138, 61)";
const CLEAR = "rgba(0, 0, 0, 0)";
const REQUESTS = "**/api/requests";
const isAvailability = (url: URL) => url.pathname === "/api/availability";
const POSTER = /\/media\/borne-boucle-poster\.webp$/;
const FILM = "/media/borne-boucle.mp4";
/** La clé de test de Cloudflare : la page servie la reçoit à la place de la clé vide de la construction d'essai. */
const TEST_SITE_KEY = "1x00000000000000000000AA";
const isTurnstile = (url: URL) => url.hostname === "challenges.cloudflare.com";

const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** « samedi 12 décembre 2026 ». */
const longDate = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));

const days = (page: Page) => page.locator("#days");
const send = (page: Page) => page.getByRole("button", { name: "Envoyer ma demande" });
const terms = (page: Page) => page.getByLabel("J'accepte les conditions générales de vente");
const confirmed = (page: Page) => page.getByRole("heading", { name: "Merci, votre demande est envoyée !" });

/** Une zone donne le contact de l'offre : un lien par moyen renseigné, aucun pour un moyen encore vide. */
async function expectContact(zone: Locator) {
  const { phone, email } = offer.contact;
  await expect(zone.locator('a[href^="tel:"]')).toHaveCount(phone ? 1 : 0);
  await expect(zone.locator('a[href^="mailto:"]')).toHaveCount(email ? 1 : 0);
  if (phone) await expect(zone.getByRole("link", { name: phone })).toBeVisible();
  if (email) await expect(zone.getByRole("link", { name: email })).toBeVisible();
}

/** `/reserver` telle qu'une construction avec une clé anti-robots la servirait : la clé de test posée sur le widget. */
async function withSiteKey(page: Page) {
  await page.route(
    (url) => url.pathname === "/reserver",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("data-sitekey>", `data-sitekey="${TEST_SITE_KEY}">`);
      await route.fulfill({ response, body });
    },
  );
}

/**
 * Un faux script Turnstile, pour ne dépendre ni du réseau ni de Cloudflare : le widget rend « widget-1 » et donne le
 * jeton « jeton-de-test ». `failOnce` : la première lecture du jeton lève, comme un widget en panne.
 */
const fakeTurnstile = ({ failOnce = false } = {}) => `
  let failed = ${!failOnce};
  window.turnstile = {
    render: () => "widget-1",
    getResponse: () => {
      if (!failed) { failed = true; throw new Error("Turnstile en panne"); }
      return "jeton-de-test";
    },
    reset: () => {},
  };`;

/** Une phrase qui invite à nous contacter n'est écrite que si l'offre dit comment. */
const hasContact = Boolean(offer.contact.phone || offer.contact.email);

/** Ce que le client a saisi est toujours là. */
async function expectKept(page: Page, who: ReturnType<typeof client>) {
  await expect(page.getByLabel("Type d'événement")).toHaveValue("Anniversaire");
  await expect(page.getByLabel("Horaires de l'événement")).toHaveValue(who.hours);
  await expect(page.getByLabel("Lieu")).toHaveValue(who.venue);
  await expect(page.getByLabel("Nom")).toHaveValue(who.name);
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
  await expect(page.getByRole("button", { name: "Continuer" })).toBeDisabled();
  await planButton(page, FIRST_PLAN).click();
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continuer" }).click();

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

test("une formule présélectionnée passe directement aux coordonnées après la date", async ({ page }) => {
  await page.goto(`/reserver?formule=${SECOND_PLAN.id}`);
  await pickFreeDate(page);
  await page.getByRole("button", { name: "Continuer" }).click();
  await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();

  // Un retour montre la formule choisie, qui peut encore changer.
  await page.getByRole("button", { name: "Retour" }).click();
  await expect(planButton(page, SECOND_PLAN)).toHaveAttribute("aria-pressed", "true");
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Continuer" })).toBeEnabled();

  let sent: Record<string, unknown> | undefined;
  await page.route(REQUESTS, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { status: "created" } });
  });
  await page.getByRole("button", { name: "Continuer" }).click();
  await fillDetails(page);
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  expect(sent).toMatchObject({ plan: SECOND_PLAN.id, terms: true, turnstile_token: "" });
});

// Le client renvoie une demande déjà reçue (double envoi, autre onglet) : rien n'est en double, et il sait où lire la suite.
test("une demande déjà reçue rassure le client sans rien envoyer de plus", async ({ page }) => {
  const date = await reachDetails(page);
  await fillDetails(page);
  await page.route(REQUESTS, (route) => route.fulfill({ status: 200, json: { status: "already_requested" } }));
  await send(page).click();
  await expect(confirmed(page)).toBeVisible();
  const note = page.getByText("nous est déjà parvenue").filter({ visible: true });
  await expect(note).toHaveText(
    new RegExp(`^Bonne nouvelle\\s: votre demande pour le ${longDate(date)} nous est déjà parvenue, inutile de la renvoyer\\. Vous trouverez dans vos e-mails son récapitulatif, puis notre réponse\\.$`),
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
  await expect(why).toContainText(hasContact ? "Si c'est plus urgent, appelez-nous" : /avance\.\s*$/);
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
  // Un autre client demande la même date pendant que celui-ci remplit ses coordonnées.
  await seed(request, "pending", { date });

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
  // La limite par adresse e-mail dit combien de demandes en cours elle permet, et ce qui suit.
  await expect(page.locator('[data-problem="too_many"]')).toContainText(
    new RegExp(`déjà ${offer.maxActivePerEmail} demandes? en cours\\. Nous vous répondons d'abord sur celles?-ci, sous 72\\sh\\s; vous pourrez ensuite en envoyer une nouvelle\\.`),
  );
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
  await expect(page.getByLabel("Nom")).not.toHaveAttribute("aria-invalid", "true");
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
  await page.getByLabel("Nom").fill("");
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
  await withSiteKey(page);
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
  await withSiteKey(page);
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
      if (new URL(req.url()).pathname === FILM) films.push(req.url());
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
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(planButton(page, FIRST_PLAN)).toHaveAttribute("aria-pressed", "true");
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
  await planButton(page, FIRST_PLAN).click();
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
    await expect(notice).toContainText(hasContact ? "Pour réserver sans le calendrier, appelez-nous" : /autre\.\s*$/);
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
