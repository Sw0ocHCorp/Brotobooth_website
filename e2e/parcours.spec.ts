import { expect, test } from "@playwright/test";
import { cleanup, client, fillDetails, ORIGIN, reachDetails, showDay } from "./seed";

/** Une réservation de bout en bout, comme le ferait le propriétaire en essayant le site (docs/essai-local.md). */

test.afterEach(({ request }) => cleanup(request));

test("une réservation de bout en bout", async ({ page, browser, viewport }) => {
  const who = { ...client(), name: "Léa Bernard" };

  // 1. Le client demande sa date sur /reserver.
  const date = await reachDetails(page);
  await fillDetails(page, who);
  await page.getByRole("button", { name: "Envoyer ma demande" }).click();
  await expect(page.getByRole("heading", { name: "Demande envoyée" })).toBeVisible();

  // 2. Le propriétaire fixe le prix et valide la demande dans /admin/.
  await page.goto("/admin/");
  await page.getByRole("button", { name: new RegExp(who.name) }).click();
  const sheet = page.getByRole("dialog", { name: who.name });
  await expect(sheet.getByText("À valider", { exact: true })).toBeVisible();
  const id = new URL(page.url()).hash.slice(1);

  await sheet.getByRole("button", { name: "Ajuster le prix" }).click();
  await page.getByRole("dialog", { name: "Ajuster le prix" }).getByLabel("Prix (€)").fill("900");
  await page.getByRole("button", { name: "Enregistrer le prix" }).click();
  await expect(sheet.getByText("270,00 €", { exact: true })).toBeVisible(); // 30 % du prix

  await sheet.getByRole("button", { name: "Valider" }).click();
  await expect(sheet.getByText("Attente d'acompte", { exact: true })).toBeVisible();

  // 3. Le message au client est lisible sur /demo ; son lien mène à la page de paiement. Il part juste après la validation.
  const message = page.locator("article.card").filter({ hasText: who.email }).filter({ hasText: "Votre acompte pour le" });
  await expect(async () => {
    await page.goto("/demo");
    await expect(message).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(message).toContainText("270,00 €");
  await message.getByRole("link", { name: new RegExp(`^${ORIGIN}/acompte/`) }).click();
  await expect(page.getByRole("heading", { name: "Votre acompte" })).toBeVisible();
  await expect(page.locator(".amount")).toHaveText("270,00 €");

  // 4. Le client paie en simulation, puis sa page confirme la date.
  await page.getByRole("button", { name: /Payer l'acompte/ }).click();
  await expect(page.getByRole("heading", { name: "Simulation" })).toBeVisible();
  await page.getByRole("button", { name: "Simuler un paiement réussi" }).click();
  await expect(page).toHaveURL(/\/acompte\/[^/]+\?paid=1$/);
  await expect(page.getByRole("heading", { name: "Votre date est confirmée" })).toBeVisible();

  // 5. La prestation est confirmée dans /admin/, avec son acompte payé dans l'historique.
  await page.goto(`/admin/#${id}`);
  const confirmed = page.getByRole("dialog", { name: who.name });
  await expect(confirmed.getByText("Confirmée", { exact: true })).toBeVisible();
  await expect(confirmed.getByRole("list", { name: "Historique" }).getByRole("listitem")).toContainText(["Demande reçue", "Prix ajusté", "Validée", "Paiement ouvert par le client", "Acompte payé"]);

  // 6. La date est barrée sur /reserver pour le visiteur suivant : plus personne ne peut la demander. Un nouveau visiteur,
  // car le navigateur garde les disponibilités 30 s (`Cache-Control`), le temps de ce parcours.
  const visitor = await browser.newContext({ viewport });
  const other = await visitor.newPage();
  await other.goto("/reserver");
  const day = await showDay(other, date);
  await expect(day).toBeDisabled();
  await expect(day).toHaveCSS("text-decoration-line", "line-through");
  await expect(day).toHaveAccessibleName(/, déjà réservée$/);
  await visitor.close();
});
