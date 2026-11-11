import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { socialLabel, socialName, telHref } from "../worker/offer";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { TEST_SITE_KEY, eraseContacts, expectContact, fakeTurnstile, isTurnstile, offer, withSiteKey } from "./seed";

/**
 * La section « Contact » de l'accueil (`#contact`) et ce que la politique de confidentialité en dit (spec de la rubrique de
 * contact, sections 2 et 4). Les moyens directs sont ceux de l'offre réelle, lue dans `offer` ; leur rendu avec des numéros
 * et une adresse est vérifié par `test/components/contact-links.test.ts`, sur une offre d'essai.
 */

const CONTACT = "**/api/contact";
const SENT = "Merci, votre message est bien parti. Nous vous répondons par e-mail.";
const FAILED = "Votre message n'est pas parti. Vérifiez votre connexion, puis réessayez.";
const BOT = "La vérification anti-robots n'a pas abouti. Réessayez.";
const TOO_MANY = "Beaucoup de messages sont partis de cette connexion aujourd'hui. Réessayez demain";
const PRIVACY =
  "Brotobooth utilise votre nom, votre e-mail, votre téléphone et votre message uniquement pour vous répondre, et les efface au bout de 12 mois. " +
  "Vos droits et le détail : politique de confidentialité.";
/** Chaque champ, son libellé et le message qui le signale. */
const FIELDS = [
  { name: "name", label: "Votre nom", problem: "Indiquez votre nom." },
  { name: "email", label: "Votre e-mail", problem: "Vérifiez votre adresse e-mail." },
  { name: "phone", label: "Votre téléphone (facultatif)", problem: "Vérifiez votre numéro de téléphone." },
  { name: "message", label: "Votre message", problem: "Écrivez votre message." },
];

const section = (page: Page) => page.getByRole("region", { name: "Contact" });
const send = (page: Page) => page.getByRole("button", { name: "Envoyer le message" });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

let visitors = 0;
/** Un visiteur, avec un nom propre à chaque appel : un test retrouve son message parmi ceux de la base. */
const visitor = () => ({
  name: `Lou Martin ${Date.now()}-${++visitors}`,
  email: "lou.martin@example.test",
  phone: "06 12 34 56 78",
  message: "Êtes-vous libres le 12 juin ?\nNous serons une centaine.",
});

async function fillMessage(page: Page, who = visitor()) {
  await field(page, "Votre nom").fill(who.name);
  await field(page, "Votre e-mail").fill(who.email);
  await field(page, "Votre téléphone (facultatif)").fill(who.phone);
  await field(page, "Votre message").fill(who.message);
  return who;
}

/** Ce que le visiteur a saisi est toujours là. */
async function expectKept(page: Page, who: ReturnType<typeof visitor>) {
  await expect(field(page, "Votre nom")).toHaveValue(who.name);
  await expect(field(page, "Votre e-mail")).toHaveValue(who.email);
  await expect(field(page, "Votre téléphone (facultatif)")).toHaveValue(who.phone);
  await expect(field(page, "Votre message")).toHaveValue(who.message);
}

// Sans l'ouverture du logo, qui couvre l'accueil et prend les clics pendant ses deux secondes.
test.use({ reducedMotion: "reduce" });
test.afterEach(({ request }) => eraseContacts(request));

test("le menu mène à la section Contact, qui donne les moyens renseignés, et rien pour un moyen vide", async ({ page }) => {
  await page.goto("/");
  const link = page.getByRole("navigation", { name: "Menu principal" }).getByRole("link", { name: "Contact" });
  await expect(link).toHaveAttribute("href", "/#contact");
  await link.click();
  await expect(section(page).getByRole("heading", { level: 2, name: "Contact" })).toBeInViewport();
  await expect(section(page)).toHaveAttribute("id", "contact");
  await expect(section(page).getByText("Une question sur la borne ou sur votre événement ?")).toHaveText(
    "Une question sur la borne ou sur votre événement ? Écrivez-nous, nous vous répondons par e-mail.",
  );

  const { phones, email, social } = offer.contact;
  await expect(section(page).locator('a[href^="tel:"]:visible')).toHaveCount(phones.length);
  for (const { name, number } of phones) {
    await expect(section(page).getByRole("link", { name: `Appeler ${name}`, exact: true })).toHaveAttribute("href", telHref(number));
  }
  await expect(section(page).locator('a[href^="mailto:"]:visible')).toHaveCount(email ? 1 : 0);
  if (email) await expect(section(page).getByRole("link", { name: email, exact: true })).toHaveAttribute("href", `mailto:${email}`);
  for (const url of social) {
    const network = section(page).getByRole("link", { name: socialName(url), exact: true });
    await expect(network).toHaveAttribute("href", url);
    await expect(network).toHaveText(socialLabel(url));
  }
  // Aucun moyen de joindre Brotobooth par Telegram.
  await expect(page.locator('a[href*="t.me"], a[href*="telegram"]')).toHaveCount(0);
});

test("la section parle au visiteur : aucun vocabulaire interne, aucun délai de réponse promis", async ({ page }) => {
  await page.goto("/#contact");
  // Tous ses textes, y compris les messages encore cachés.
  const text = (await section(page).textContent()) ?? "";
  expect(text).toContain("Envoyer le message");
  expect(text).not.toMatch(/palier|bloqu|valid|statut|propriétaire|empreinte|telegram|délai|en attente|sous \d+\s*h|dans les \d+/i);
});

test("le formulaire : quatre champs, le téléphone seul facultatif, aucune case", async ({ page }) => {
  await page.goto("/#contact");
  const form = section(page).locator("form");
  await expect(form.locator("input:visible, textarea:visible, select:visible")).toHaveCount(4);
  for (const { label } of FIELDS) await expect(field(page, label)).toBeVisible();
  await expect(field(page, "Votre nom")).toHaveAttribute("maxlength", "120");
  await expect(field(page, "Votre message")).toHaveAttribute("maxlength", "2000");
  for (const label of ["Votre nom", "Votre e-mail", "Votre message"]) await expect(field(page, label)).toHaveAttribute("required", "");
  await expect(field(page, "Votre téléphone (facultatif)")).not.toHaveAttribute("required");
  await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
});

test("l'information sur les données est sous le formulaire, avec son lien vers la politique", async ({ page }) => {
  await page.goto("/#contact");
  const notice = section(page).getByText("Brotobooth utilise votre nom");
  await expect(notice).toHaveText(PRIVACY);
  const link = notice.getByRole("link", { name: "politique de confidentialité" });
  await expect(link).toHaveAttribute("href", "/confidentialite#contact");
  const [button, text] = await Promise.all([send(page).boundingBox(), notice.boundingBox()]);
  expect(text!.y).toBeGreaterThanOrEqual(button!.y + button!.height);

  await link.click();
  await expect(page).toHaveURL(/\/confidentialite\/?#contact$/);
  await expect(page.getByRole("heading", { level: 2, name: "Le formulaire de contact" })).toBeInViewport();
});

test("l'anti-robots ne se charge qu'au premier champ touché", async ({ page }) => {
  await withSiteKey(page, "/");
  const scripts: string[] = [];
  await page.route(isTurnstile, (route) => {
    scripts.push(route.request().url());
    return route.fulfill({ contentType: "text/javascript", body: fakeTurnstile() });
  });
  const tokens: string[] = [];
  await page.route(CONTACT, (route) => {
    tokens.push(route.request().postDataJSON().turnstile_token);
    return route.fulfill({ status: 201, json: { status: "sent" } });
  });

  await page.goto("/");
  await expect(page.locator("#turnstile")).toHaveAttribute("data-sitekey", TEST_SITE_KEY);
  await section(page).scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(scripts).toEqual([]);
  // Ni le lien vers la politique ni le bouton, qui sont dans le formulaire : le visiteur n'a pas commencé à écrire. Le
  // script serait ajouté à la page dès le focus, sans attendre.
  const turnstileTags = () => page.locator('script[src^="https://challenges.cloudflare.com/"]').count();
  await section(page).getByRole("link", { name: "politique de confidentialité" }).focus();
  await send(page).focus();
  expect(await turnstileTags()).toBe(0);
  expect(scripts).toEqual([]);

  await field(page, "Votre nom").focus();
  await expect.poll(() => scripts.length).toBe(1);
  await page.waitForFunction(() => "turnstile" in window);
  // Les autres champs ne le chargent pas une fois de plus, et le jeton part avec le message.
  await fillMessage(page);
  await send(page).click();
  await expect(page.getByText(SENT)).toBeVisible();
  expect(scripts).toHaveLength(1);
  expect(tokens).toEqual(["jeton-de-test"]);
});

test("si le script de la page ne se charge pas, le formulaire reste caché, et rien ne part dans une adresse", async ({ page }) => {
  // JavaScript tourne, mais le script de l'accueil n'arrive pas (réseau, ancienne version après une mise en ligne, bloqueur).
  await page.route(/\/_astro\/.*\.js$/, (route) => route.abort());
  await page.goto("/#contact");
  await expect(section(page).getByRole("heading", { level: 2, name: "Contact" })).toBeVisible();
  await expect(field(page, "Votre nom")).toBeHidden();
  await expect(send(page)).toBeHidden();

  // Même envoyé par le navigateur lui-même, le formulaire part en POST : ni nom, ni e-mail, ni message dans l'adresse.
  const native = page.waitForRequest((request) => request.resourceType() === "document" && request.frame() === page.mainFrame());
  await page.evaluate(() => {
    const form = document.getElementById("contact-form") as HTMLFormElement;
    for (const [name, value] of [["name", "Lou Martin"], ["email", "lou.martin@example.test"], ["message", "Bonjour"]]) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    setTimeout(() => form.requestSubmit());
  });
  const request = await native;
  expect(request.method()).toBe("POST");
  expect(new URL(request.url()).search).toBe("");
});

test("un message envoyé : le remerciement remplace le formulaire, et le message est enregistré", async ({ page, request }) => {
  await page.goto("/#contact");
  const who = await fillMessage(page);
  await send(page).click();

  const thanks = section(page).getByText(SENT);
  await expect(thanks).toHaveText(SENT);
  await expect(thanks).toBeFocused();
  await expect(field(page, "Votre nom")).toBeHidden();
  await expect(send(page)).toBeHidden();

  const { messages } = await (await request.get("/api/admin/contact")).json();
  expect(messages).toContainEqual(expect.objectContaining({ name: who.name, email: who.email, phone: who.phone, message: who.message }));
});

test("le téléphone est facultatif", async ({ page }) => {
  await page.goto("/#contact");
  const bodies: Record<string, string>[] = [];
  await page.route(CONTACT, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { status: "sent" } });
  });
  const who = await fillMessage(page);
  await field(page, "Votre téléphone (facultatif)").fill("");
  await send(page).click();
  await expect(page.getByText(SENT)).toBeVisible();
  expect(bodies).toEqual([{ name: who.name, email: who.email, phone: "", message: who.message, turnstile_token: "" }]);
});

test("un champ oublié est signalé avant l'envoi, sans rien envoyer", async ({ page }) => {
  await page.goto("/#contact");
  let posts = 0;
  await page.route(CONTACT, (route) => {
    posts++;
    return route.fulfill({ status: 201, json: { status: "sent" } });
  });
  await field(page, "Votre e-mail").fill("lou.martin@");
  await send(page).click();

  await expect(field(page, "Votre nom")).toBeFocused();
  for (const { label, problem } of FIELDS.filter(({ name }) => name !== "phone")) {
    await expect(field(page, label)).toHaveAccessibleDescription(problem);
    await expect(section(page).getByText(problem)).toBeVisible();
  }
  await expect(section(page).getByText("Vérifiez votre numéro de téléphone.")).toBeHidden();
  expect(posts).toBe(0);
});

test("un champ refusé par le serveur : son message sous lui, et le corriger l'efface", async ({ page }) => {
  await page.goto("/#contact");
  const who = await fillMessage(page);
  await page.route(CONTACT, (route) => route.fulfill({ status: 422, json: { error: "invalid", fields: FIELDS.map(({ name }) => name) } }));
  await send(page).click();

  await expect(field(page, "Votre nom")).toBeFocused();
  for (const { label, problem } of FIELDS) {
    const input = field(page, label);
    const message = section(page).getByText(problem);
    await expect(message).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(problem);
    // Juste sous le champ, aligné sur lui.
    const [box, text] = await Promise.all([input.boundingBox(), message.boundingBox()]);
    expect(text!.y, label).toBeGreaterThanOrEqual(box!.y + box!.height);
    expect(text!.y - (box!.y + box!.height), label).toBeLessThan(12);
    expect(Math.abs(text!.x - box!.x), label).toBeLessThan(4);
  }
  await expectKept(page, who);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  expect(await smallTargets(section(page))).toEqual([]);
  expect((await new AxeBuilder({ page }).include("#contact").analyze()).violations).toEqual([]);

  await field(page, "Votre téléphone (facultatif)").fill("06 98 76 54 32");
  await expect(section(page).getByText("Vérifiez votre numéro de téléphone.")).toBeHidden();
  await expect(field(page, "Votre téléphone (facultatif)")).not.toHaveAttribute("aria-invalid", "true");
});

test("anti-robots refusé, trop de messages, panne : chaque fois le texte qui convient, et les champs gardés", async ({ page }) => {
  await page.goto("/#contact");
  const who = await fillMessage(page);
  const cases = [
    { text: BOT, contact: false, answer: { status: 403, json: { error: "bot" } } },
    { text: TOO_MANY, contact: true, answer: { status: 429, json: { error: "too_many" } } },
    { text: FAILED, contact: true, answer: { status: 503, json: { error: "server_error" } } },
    { text: FAILED, contact: true, answer: null },
  ];
  for (const { text, contact, answer } of cases) {
    await page.route(CONTACT, (route) => (answer ? route.fulfill(answer) : route.abort("internetdisconnected")));
    await send(page).click();
    const problem = page.getByRole("alert").filter({ hasText: text });
    await expect(problem).toBeVisible();
    await expect(problem).toBeFocused();
    for (const other of [FAILED, BOT, TOO_MANY].filter((sentence) => sentence !== text)) {
      await expect(problem).not.toContainText(other, { useInnerText: true }); // les autres phrases sont dans la page, masquées
    }
    // Le contact suit la phrase montrée ; celui de l'autre phrase, masquée, ne compte pas.
    if (contact) await expectContact(problem.locator("[data-problem]:visible"));
    else await expect(problem.getByRole("link")).toHaveCount(0);
    await expectKept(page, who);
    await expect(send(page)).toBeEnabled();
    expect(await smallTargets(section(page))).toEqual([]);
    await page.unroute(CONTACT);
  }
  expect((await new AxeBuilder({ page }).include("#contact").analyze()).violations).toEqual([]);

  await send(page).click();
  await expect(page.getByText(SENT)).toBeVisible();
});

test.describe("sans JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("la section donne les moyens directs, et le formulaire renvoie vers l'adresse e-mail", async ({ page }) => {
    await page.goto("/#contact");
    await expect(section(page).getByRole("heading", { name: "Contact" })).toBeVisible();
    for (const url of offer.contact.social) await expect(section(page).getByRole("link", { name: socialName(url), exact: true })).toBeVisible();
    // Le formulaire ne peut pas partir sans script : il cède la place à une phrase, et rien n'est à remplir.
    await expect(field(page, "Votre nom")).toBeHidden();
    await expect(send(page)).toBeHidden();
    const fallback = section(page).getByText("Le formulaire ne s'affiche pas sur votre navigateur.");
    await expect(fallback).toBeVisible();
    const { email } = offer.contact;
    if (email) await expect(fallback.getByRole("link", { name: email })).toHaveAttribute("href", `mailto:${email}`);
    else await expect(fallback).toHaveText("Le formulaire ne s'affiche pas sur votre navigateur. Essayez-en un autre.");
  });
});

test("la politique de confidentialité dit ce que devient un message", async ({ page }) => {
  await page.goto("/confidentialite");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /nous écrivez/);
  await expect(page.locator(".meta")).toContainText("nous envoyez un message");

  const form = page.getByRole("region", { name: "Le formulaire de contact" });
  for (const text of [
    "votre nom",
    "votre adresse e-mail",
    "votre numéro de téléphone si vous le donnez",
    "votre message",
    "une version brouillée de votre adresse IP",
    `${offer.maxPerIpPer24h} messages en 24 h`,
    "vous répondre",
    "Ni prospection, ni lettre d'information, ni publicité",
    "intérêt légitime",
    "6.1.f",
    "6.1.b",
    "pas de case à cocher",
    "12 mois après leur réception",
    "24 h",
    "Cloudflare",
    "Resend",
    "Telegram n'en reçoit rien",
  ]) {
    await expect(form, text).toContainText(text);
  }
  await expect(form).not.toContainText(/empreinte/);

  // La liste des prestataires dit ce que chacun reçoit des messages.
  const recipients = page.getByRole("region", { name: "Qui reçoit vos données" });
  await expect(recipients.getByRole("listitem").filter({ hasText: "Resend" })).toContainText("les messages que vous nous écrivez par le formulaire de contact");
  await expect(recipients.getByRole("listitem").filter({ hasText: "Telegram" })).toContainText("ne reçoit rien des messages que vous nous écrivez");
});
