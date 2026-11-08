import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { hasNoHorizontalOverflow, smallTargets } from "./layout";
import { addDays, cleanup, freeDate, ORIGIN, seed, type Kind } from "./seed";

test.afterEach(({ request }) => cleanup(request));

const sheetOf = (page: Page, title: string) => page.getByRole("dialog", { name: title });

/** Affiche le mois d'une date `AAAA-MM-JJ` dans le calendrier, en avançant ou en reculant mois par mois. */
async function showMonth(page: Page, date: string) {
  const title = page.locator("#calendar-title");
  const wanted = date.slice(0, 7);
  for (let step = 0; step < 6; step++) {
    const shown = (await title.getAttribute("data-month")) ?? "";
    if (shown === wanted) break;
    await page.getByRole("button", { name: shown < wanted ? "Mois suivant" : "Mois précédent" }).click();
  }
  await expect(title).toHaveAttribute("data-month", wanted);
}

const calendarCell = (page: Page, date: string) => page.locator(`#calendar td[data-date="${date}"]`);

/** Attend la fin de l'animation d'ouverture : axe mesurerait le contraste d'un panneau encore à moitié transparent. */
const settled = (page: Page) =>
  page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
  });

const historyOf = (sheet: Locator) => sheet.getByRole("list", { name: "Historique" });

test("traiter une demande depuis le téléphone", async ({ page, request, context, browserName }) => {
  // Chromium sans fenêtre n'accorde pas le presse-papiers de lui-même ; il faut aussi pouvoir y relire le lien.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const booking = await seed(request, "pending");
  await page.goto("/admin");
  await page.getByRole("button", { name: new RegExp(booking.name) }).click();

  const sheet = sheetOf(page, booking.name);
  await expect(sheet.getByRole("link", { name: /06 12 34 56 78/ })).toHaveAttribute("href", /^tel:/);
  await expect(page).toHaveURL(new RegExp(`#${booking.id}$`));

  // Le rose est réservé à l'action principale : un seul bouton plein, en gras et d'au moins 19 px.
  await expect(page.locator(".btn.primary:visible")).toHaveCount(1);
  const valider = sheet.getByRole("button", { name: "Valider" });
  expect(await valider.evaluate((button) => {
    const style = getComputedStyle(button);
    return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight), fill: style.backgroundColor };
  })).toMatchObject({ weight: 700, fill: "rgb(242, 85, 155)" });
  expect(await valider.evaluate((button) => parseFloat(getComputedStyle(button).fontSize))).toBeGreaterThanOrEqual(19);

  await valider.click();
  await expect(page.getByText("Attente d'acompte")).toBeVisible();

  // Le lien de paiement du client, à copier pour l'envoyer aussi par SMS.
  await expect(sheet.getByLabel("Lien de paiement")).toHaveValue(`${ORIGIN}/acompte/${booking.token}`);
  await sheet.getByRole("button", { name: "Copier le lien" }).click();
  // WebKit peut refuser le presse-papiers à une page sans fenêtre : le lien est alors sélectionné pour être copié à la main.
  await expect(sheet.getByRole("status")).toContainText(browserName === "chromium" ? "Lien copié" : /Lien copié|sélectionné/);
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/acompte/${booking.token}`);
  }

  // L'historique raconte la demande puis la validation.
  const history = sheet.getByRole("list", { name: "Historique" });
  await expect(history.getByRole("listitem")).toHaveText([/Demande reçue/, /Validée/]);
});

test("refuser demande une confirmation", async ({ page, request }) => {
  const booking = await seed(request, "pending");
  await page.goto("/admin");
  await page.getByRole("button", { name: new RegExp(booking.name) }).click();
  const sheet = sheetOf(page, booking.name);

  await sheet.getByRole("button", { name: "Refuser", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Refuser cette demande ?" });
  await expect(confirmation).toBeVisible();

  // Annuler referme le dialogue : la demande reste à valider, côté page comme côté serveur.
  await confirmation.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(sheet.getByText("À valider", { exact: true })).toBeVisible();
  const stillPending = await (await request.get(`/api/admin/bookings/${booking.id}`)).json();
  expect(stillPending.booking.status).toBe("pending_review");

  await sheet.getByRole("button", { name: "Refuser", exact: true }).click();
  await confirmation.getByRole("button", { name: "Refuser la demande" }).click();
  await expect(sheet.getByText("Refusée", { exact: true }).first()).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Valider" })).toHaveCount(0);
  const refused = await (await request.get(`/api/admin/bookings/${booking.id}`)).json();
  expect(refused.booking.status).toBe("refused");
});

test("ajuster le prix recalcule l'acompte", async ({ page, request }) => {
  const booking = await seed(request, "pending");
  // L'adresse du bouton « Ajuster le prix » du bot Telegram ouvre la fiche directement.
  await page.goto(`/admin#${booking.id}`);
  const sheet = sheetOf(page, booking.name);
  const price = page.getByRole("dialog", { name: "Ajuster le prix" });
  await sheet.getByRole("button", { name: "Ajuster le prix" }).click();

  await price.getByLabel("Prix (€)").fill("1500");
  await price.getByRole("button", { name: "Enregistrer le prix" }).click();
  await expect(price).toBeHidden();
  await expect(sheet.getByText("1 500,00 €", { exact: true })).toBeVisible();
  await expect(sheet.getByText("450,00 €", { exact: true })).toBeVisible(); // 30 % du prix
  await expect(sheet.getByText("1 050,00 €", { exact: true })).toBeVisible(); // le solde
  // L'historique garde la trace du changement, en français.
  await expect(historyOf(sheet).getByRole("listitem")).toHaveText([/Demande reçue/, /Prix ajusté.*Vous/]);
  await expect(historyOf(sheet)).not.toContainText("price_adjusted");

  // Un acompte saisi remplace le calcul.
  await sheet.getByRole("button", { name: "Ajuster le prix" }).click();
  await expect(price.getByLabel("Prix (€)")).toHaveValue("1500");
  await price.getByLabel("Acompte (€)").fill("500,50");
  await price.getByRole("button", { name: "Enregistrer le prix" }).click();
  await expect(sheet.getByText("500,50 €", { exact: true })).toBeVisible();
  await expect(historyOf(sheet).getByRole("listitem")).toHaveText([/Demande reçue/, /Prix ajusté/, /Prix ajusté/]);

  // Le serveur refuse un acompte plus grand que le prix, et le formulaire le dit.
  await sheet.getByRole("button", { name: "Ajuster le prix" }).click();
  await price.getByLabel("Prix (€)").fill("100");
  await price.getByLabel("Acompte (€)").fill("200");
  await price.getByRole("button", { name: "Enregistrer le prix" }).click();
  await expect(price.getByRole("alert")).toContainText("l'acompte");
  await expect(price.getByLabel("Acompte (€)")).toHaveAttribute("aria-invalid", "true");
});

test("le calendrier montre chaque état", async ({ page, request }) => {
  const states: [Kind, string][] = [
    ["pending", "À valider"],
    ["awaiting", "Attente d'acompte"],
    ["confirmed", "Confirmée"],
    ["blocked", "Date bloquée"],
    ["refused", "Refusée"],
    ["cancelled", "Annulée"],
  ];
  // Une réservation refusée ou annulée libère sa date : chaque état a donc la sienne.
  const first = await freeDate(request);
  const seeded = [];
  for (const [index, [kind, label]] of states.entries()) {
    seeded.push({ ...(await seed(request, kind, { date: addDays(first, index) })), label });
  }

  await page.goto("/admin");
  const looks = new Set<string>();
  for (const { date, label, name } of seeded) {
    await showMonth(page, date);
    const cell = calendarCell(page, date).getByRole("button");
    // Le libellé de l'état est dit à l'écran lu, le nom du client aussi.
    await expect(cell).toHaveAccessibleName(new RegExp(`${label}.*${name}|${name}.*${label}`));
    // Chaque état a son aspect : couleur, trait et fond, jamais la couleur seule.
    looks.add(
      await cell.locator(".mark").evaluate((mark) => {
        const style = getComputedStyle(mark);
        return [style.backgroundColor, style.backgroundImage, style.borderTopColor, style.borderTopStyle].join("|");
      }),
    );
    // La légende nomme les états du mois affiché.
    await expect(page.getByRole("list", { name: "Légende" }).getByText(label, { exact: true })).toBeVisible();
  }
  expect(looks.size).toBe(states.length);
});

test("un état expiré a son libellé et son aspect", async ({ page }) => {
  const date = await freeDate(page.request);
  await page.route("**/api/admin/bookings?*", (route) =>
    route.fulfill({
      json: {
        bookings: [
          {
            id: "expired-1", token: "t", event_date: date, status: "expired", source: "site", client_name: "Léa Durand",
            created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-04T10:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.goto("/admin");
  await showMonth(page, date);
  await expect(calendarCell(page, date).getByRole("button")).toHaveAccessibleName(/Expirée.*Léa Durand/);
  await expect(page.getByRole("list", { name: "Légende" }).getByText("Expirée", { exact: true })).toBeVisible();
});

test("ajouter une réservation et bloquer une date", async ({ page, request }) => {
  const first = await freeDate(request);
  const second = addDays(first, 1);
  await page.goto("/admin");

  await page.getByRole("button", { name: "Ajouter une réservation" }).click();
  const form = page.getByRole("dialog", { name: "Ajouter une réservation" });
  // Le prix est obligatoire : sans lui, le formulaire n'est pas envoyé.
  await form.getByLabel("Date").fill(first);
  await form.getByLabel("Nom").fill("Inès Lefèvre");
  await form.getByRole("button", { name: "Enregistrer la réservation" }).click();
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Prix (€)")).toBeFocused();

  await form.getByLabel("Téléphone").fill("07 98 76 54 32");
  await form.getByLabel("E-mail").fill("ines@example.test");
  await form.getByLabel("Type d'événement").selectOption("Anniversaire");
  await form.getByLabel("Lieu").fill("Salle des fêtes, Annecy");
  await form.getByLabel("Horaires").fill("20h-01h");
  // Un montant illisible est signalé sur le champ, sans rien envoyer ; corrigé, il passe.
  const prix = form.getByLabel("Prix (€)");
  await prix.fill("douze cents");
  await form.getByRole("button", { name: "Enregistrer la réservation" }).click();
  await expect(prix).toBeFocused();
  expect(await prix.evaluate((input: HTMLInputElement) => input.validationMessage)).toContain("Montant illisible");
  await prix.fill("1200");
  await form.getByLabel("Acompte (€)").fill("300");
  await form.getByLabel("Notes").fill("Paiement du solde en espèces.");
  await form.getByRole("button", { name: "Enregistrer la réservation" }).click();

  // La fiche de la réservation s'ouvre : confirmée, avec le solde restant dû.
  const sheet = sheetOf(page, "Inès Lefèvre");
  await expect(sheet.getByText("Confirmée", { exact: true })).toBeVisible();
  await expect(sheet.getByText("1 200,00 €", { exact: true })).toBeVisible();
  await expect(sheet.getByText("900,00 €", { exact: true })).toBeVisible();
  await expect(sheet.getByLabel("Notes")).toHaveValue("Paiement du solde en espèces.");
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await showMonth(page, first);
  await expect(calendarCell(page, first).getByRole("button")).toHaveAccessibleName(/Confirmée.*Inès Lefèvre/);

  // Une date prise ne se réserve pas deux fois.
  await page.getByRole("button", { name: "Bloquer une date" }).click();
  const block = page.getByRole("dialog", { name: "Bloquer une date" });
  await block.getByLabel("Date").fill(first);
  await block.getByRole("button", { name: "Bloquer la date" }).click();
  await expect(block.getByRole("alert")).toContainText("déjà prise");

  await block.getByLabel("Date").fill(second);
  await block.getByLabel("Notes").fill("Congés");
  await block.getByRole("button", { name: "Bloquer la date" }).click();
  const blocked = sheetOf(page, "Réservée pour vous");
  await expect(blocked.getByText("Date bloquée", { exact: true })).toBeVisible();
  await expect(blocked.getByLabel("Notes")).toHaveValue("Congés");

  // Retirer le blocage libère la date, après confirmation.
  await blocked.getByRole("button", { name: "Retirer le blocage" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Retirer le blocage" }).click();
  await expect(blocked.getByText("Annulée", { exact: true }).first()).toBeVisible();
  const free = await (await request.get(`/api/availability?from=${second}&to=${second}`)).json();
  expect(free.unavailable).not.toContain(second);
});

test("marquer le solde comme réglé", async ({ page, request }) => {
  const booking = await seed(request, "confirmed");
  await page.goto(`/admin#${booking.id}`);
  const sheet = sheetOf(page, booking.name);
  await expect(sheet.getByText("1 050,00 €", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Solde réglé" }).click();
  await expect(sheet.getByRole("button", { name: "Solde réglé" })).toHaveCount(0);
  await expect(sheet.getByText(/Solde réglé le/)).toBeVisible();
  await expect(historyOf(sheet).getByRole("listitem")).toHaveText([/Demande reçue/, /Solde réglé.*Vous/]);
  await expect(historyOf(sheet)).not.toContainText("balance_paid");
});

test("l'historique nomme chaque modification en français", async ({ page, request }) => {
  const booking = await seed(request, "awaiting");
  await page.goto(`/admin#${booking.id}`);
  const sheet = sheetOf(page, booking.name);
  const history = historyOf(sheet);

  await sheet.getByRole("button", { name: "Renvoyer le lien" }).click();
  await expect(history.getByRole("listitem")).toHaveText([/Demande reçue/, /Validée/, /Lien de paiement renvoyé.*Vous/]);

  // Le client ouvre la page de paiement : c'est lui qui agit.
  const opened = await request.post(`/acompte/${booking.token}`, { headers: { Origin: ORIGIN }, maxRedirects: 0 });
  expect(opened.status()).toBe(303);
  await page.reload();
  await expect(history.getByRole("listitem")).toHaveText([
    /Demande reçue/,
    /Validée/,
    /Lien de paiement renvoyé/,
    /Paiement ouvert par le client.*Client/,
  ]);

  await sheet.getByLabel("Notes").fill("Rappeler le client lundi.");
  await sheet.getByRole("button", { name: "Enregistrer les notes" }).click();
  await expect(history.getByRole("listitem").last()).toContainText(/Notes modifiées.*Vous/);

  // Aucun identifiant du Worker (`payment_link_resent`, `notes_updated`...) ne s'affiche.
  expect(await history.innerText()).not.toMatch(/[a-z]+_[a-z]+/);
});

test("un événement inconnu s'affiche comme une modification, sans son identifiant", async ({ page, request }) => {
  const booking = await seed(request, "confirmed");
  await page.route(`**/api/admin/bookings/${booking.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.history.push({ at: "2026-11-08T10:00:00.000Z", actor: "system", event: "futur_evenement", detail: "futur_detail" });
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/admin#${booking.id}`);
  const history = historyOf(sheetOf(page, booking.name));
  await expect(history.getByRole("listitem").last()).toContainText(/Modification.*Automatique/);
  await expect(history).not.toContainText("futur_evenement");
  await expect(history).not.toContainText("futur_detail");
});

test("la santé affiche le dernier passage", async ({ page, request }) => {
  // Wrangler en local : cette adresse déclenche un passage de la tâche automatique. Elle passe avant les fichiers du site,
  // contrairement à `/__scheduled` de `--test-scheduled`, que la page 404 intercepte.
  expect((await request.get("/cdn-cgi/handler/scheduled")).ok()).toBe(true);
  await page.goto("/admin");
  const health = page.getByRole("region", { name: "Santé" });
  await expect(health).toContainText("Dernier passage");
  await expect(health).toContainText(/il y a (moins d'une minute|\d+ min)/);
  await expect(health.getByText("À jour", { exact: true })).toBeVisible();
  await expect(health).toContainText("Aucune notification en échec");
});

test("la santé signale un passage absent, ancien ou des envois en échec", async ({ page }) => {
  const overview = (lastCronRun: string | null, failedNotifications: number) =>
    page.route("**/api/admin/overview", (route) =>
      route.fulfill({ json: { todo: [], health: { lastCronRun, failedNotifications } } }),
    );
  const health = page.getByRole("region", { name: "Santé" });

  await overview(null, 0);
  await page.goto("/admin");
  await expect(health).toContainText("Aucun passage enregistré");

  await page.unroute("**/api/admin/overview");
  await overview(new Date(Date.now() - 3 * 3_600_000).toISOString(), 2);
  await page.reload();
  await expect(health).toContainText("il y a 3 h");
  await expect(health.getByText("À vérifier", { exact: true })).toBeVisible();
  await expect(health).toContainText("2 notifications en échec");
});

test("les refus du serveur sont expliqués", async ({ page, request }) => {
  const booking = await seed(request, "pending");
  await page.goto(`/admin#${booking.id}`);
  const sheet = sheetOf(page, booking.name);

  await page.route(`**/api/admin/bookings/${booking.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: "payment_unavailable" } })
      : route.continue(),
  );
  await sheet.getByRole("button", { name: "Ajuster le prix" }).click();
  const price = page.getByRole("dialog", { name: "Ajuster le prix" });
  await price.getByLabel("Prix (€)").fill("900");
  await price.getByRole("button", { name: "Enregistrer le prix" }).click();
  await expect(price.getByRole("alert")).toContainText("service de paiement");

  await page.route(`**/api/admin/bookings/${booking.id}/validate`, (route) =>
    route.fulfill({ status: 409, json: { error: "stale" } }),
  );
  await price.getByRole("button", { name: "Fermer" }).click();
  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByRole("alert")).toContainText("a changé entre-temps");
});

test("sans connexion, la page demande de se connecter", async ({ page }) => {
  await page.route("**/api/admin/**", (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await page.goto("/admin");
  await expect(page.getByText("Connexion requise")).toBeVisible();
});

test("une fiche inconnue le dit", async ({ page }) => {
  await page.goto("/admin#inconnue");
  await expect(page.getByRole("alert")).toContainText("fiche");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("les cibles tactiles font 44 px au moins", async ({ page, request }) => {
  const pending = await seed(request, "pending");
  const awaiting = await seed(request, "awaiting");
  const confirmed = await seed(request, "confirmed");
  await page.goto("/admin");
  expect(await smallTargets(page.locator("main"))).toEqual([]);

  await page.getByRole("button", { name: "Ajouter une réservation" }).click();
  expect(await smallTargets(page.getByRole("dialog", { name: "Ajouter une réservation" }))).toEqual([]);
  await page.keyboard.press("Escape");

  for (const booking of [pending, awaiting, confirmed]) {
    await page.goto(`/admin#${booking.id}`);
    const sheet = sheetOf(page, booking.name);
    await expect(sheet).toBeVisible();
    expect(await smallTargets(sheet)).toEqual([]);
  }
  await sheetOf(page, confirmed.name).getByRole("button", { name: "Fermer" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("aucun débordement horizontal à 375 px", async ({ page, request }) => {
  await page.goto("/admin");
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  const long = "Camille-Anne-Sophie-de-la-Tour-d'Auvergne-Lefebvre-Montmorency-Beaumont-Delacroix";
  const booking = await seed(request, "awaiting", { name: long, venue: "Domaine-de-la-Grande-Fontaine-des-Trois-Chênes-et-du-Moulin" });
  await page.goto("/admin");
  expect(await hasNoHorizontalOverflow(page)).toBe(true);

  await page.getByRole("button", { name: new RegExp(long) }).click();
  const sheet = sheetOf(page, long);
  await expect(sheet).toBeVisible();
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
  expect(await sheet.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);

  await page.keyboard.press("Escape");
  await showMonth(page, booking.date);
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
});

test("aucune violation d'accessibilité détectée par axe", async ({ page, request }) => {
  const awaiting = await seed(request, "awaiting");
  await seed(request, "pending");
  await page.goto("/admin");
  await showMonth(page, awaiting.date);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await calendarCell(page, awaiting.date).getByRole("button").click();
  await expect(sheetOf(page, awaiting.name)).toBeVisible();
  await settled(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
