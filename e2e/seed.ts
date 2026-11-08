import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
// Le chargeur de Playwright n'importe un JSON qu'avec son attribut de type, d'où l'import direct plutôt que `worker/offer.ts`.
import offerJson from "../config/offer.json" with { type: "json" };
import type { Offer, Plan } from "../worker/offer";

/**
 * L'offre telle que le propriétaire l'écrit dans `config/offer.json`. Il y change les noms, les identifiants et les prix :
 * aucun essai ne suppose ceux d'aujourd'hui, ils passent par `FIRST_PLAN`, `SECOND_PLAN` et `planButton`.
 */
export const offer: Offer = offerJson;
export const [FIRST_PLAN, SECOND_PLAN] = offer.plans;

/**
 * L'acompte que l'offre prévoit pour ce prix : son pourcentage, arrondi à l'euro le plus proche. Écrit ici plutôt que repris de
 * `worker/bookings.ts`, que le chargeur de Playwright ne lit pas (il importe `config/offer.json` sans son attribut de type).
 */
export const depositFor = (priceCents: number): number => Math.round((priceCents * offer.depositPercent) / 10_000) * 100;

const EUROS = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
/** Un montant comme l'écran l'écrit (« 1 050,00 € »), avec des espaces ordinaires. */
export const euros = (cents: number): string => EUROS.format(cents / 100).replace(/\s/g, " ");

/** L'adresse du site d'essai : celle de `BASE_URL` dans `npm run dev:e2e`, avec laquelle l'API compare l'en-tête `Origin`. */
export const ORIGIN = "http://localhost:8798";

const ADMIN = "/api/admin/bookings";
const DAY_MS = 86_400_000;
/** Les dates d'essai commencent à 35 jours : jamais dans le mois affiché à l'ouverture, un mois comptant 31 jours au plus. */
const FIRST_OFFSET_DAYS = 35;
/** Une date choisie dans le calendrier est à 30 jours au moins : loin du délai minimum, quel que soit le jour du test. */
const PICK_OFFSET_DAYS = 30;
/** Les mois que `pickFreeDate` parcourt avant de renoncer. */
const PICK_MONTHS = 6;
/** Les mois que `showDay` parcourt avant de renoncer. */
const SHOW_MONTHS = 12;
const SEARCH_DAYS = 120;
const CLEANUP_DAYS = 400;

export type Kind = "pending" | "awaiting" | "confirmed" | "blocked" | "refused" | "cancelled";

/** `name` identifie la réservation à l'écran : le nom du client, ou les notes d'une date bloquée. */
export type Seeded = { id: string; token: string; date: string; name: string; phone: string };

/** Le bouton de `plan` à la deuxième étape de `/reserver`. */
export const planButton = (page: Page, plan: Plan): Locator => page.locator(`button[data-plan="${plan.id}"]`);

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string => isoDate(new Date(Date.parse(date) + days * DAY_MS));

/** Une écriture de l'API d'administration, telle que la page l'envoie : même origine, corps JSON. */
async function write(request: APIRequestContext, method: "post" | "patch", path: string, data: object) {
  const response = await request[method](path, { data, headers: { Origin: ORIGIN } });
  expect(response.ok(), `${method.toUpperCase()} ${path} : ${response.status()}`).toBe(true);
  return response.json();
}

/** La première date libre à partir de 35 jours. Chaque réservation créée en tient une : deux appels de suite donnent deux dates. */
export async function freeDate(request: APIRequestContext): Promise<string> {
  const from = addDays(isoDate(new Date()), FIRST_OFFSET_DAYS);
  const to = addDays(from, SEARCH_DAYS);
  const response = await request.get(`/api/availability?from=${from}&to=${to}`);
  const { unavailable } = (await response.json()) as { unavailable: string[] };
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!unavailable.includes(day)) return day;
  }
  throw new Error(`Aucune date libre entre ${from} et ${to}`);
}

/**
 * Sur `/reserver`, clique la première date libre du calendrier à 30 jours au moins, en avançant d'un mois tant qu'il n'y
 * en a pas : le test ne dépend pas du jour où il tourne. Renvoie le bouton du jour, dont `data-date` porte la date.
 */
export async function pickFreeDate(page: Page): Promise<Locator> {
  const from = addDays(isoDate(new Date()), PICK_OFFSET_DAYS);
  const days = page.locator("#days");
  for (let month = 0; month < PICK_MONTHS; month++) {
    await expect(days).toHaveAttribute("aria-busy", "false");
    const free = await days
      .getByRole("button", { disabled: false })
      .evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.date ?? ""));
    const date = free.find((day) => day >= from);
    if (date) {
      const day = days.locator(`[data-date="${date}"]`);
      await day.click();
      return day;
    }
    await page.getByRole("button", { name: "Mois suivant" }).click();
  }
  throw new Error(`Aucune date libre dans le calendrier à partir du ${from}`);
}

/** Avance le calendrier de `/reserver` jusqu'au mois de `date`, et renvoie le bouton de ce jour une fois ses disponibilités connues. */
export async function showDay(page: Page, date: string): Promise<Locator> {
  const days = page.locator("#days");
  const day = days.locator(`[data-date="${date}"]`);
  for (let month = 0; month < SHOW_MONTHS && (await day.count()) === 0; month++) {
    await page.getByRole("button", { name: "Mois suivant" }).click();
  }
  await expect(days).toHaveAttribute("aria-busy", "false");
  return day;
}

/** De l'arrivée sur `/reserver` à la troisième étape, avec une date libre et la première formule : renvoie la date. */
export async function reachDetails(page: Page): Promise<string> {
  await page.goto("/reserver");
  const day = await pickFreeDate(page);
  await page.getByRole("button", { name: "Continuer" }).click();
  await planButton(page, FIRST_PLAN).click();
  await page.getByRole("button", { name: "Continuer" }).click();
  await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
  return (await day.getAttribute("data-date"))!;
}

let clients = 0;
/** Un client, avec un e-mail propre à chaque appel : la limite de demandes par e-mail ne gêne aucun test. */
export const client = () => ({
  name: "Camille Durand",
  hours: "19 h - 1 h",
  venue: "Domaine des Pins, Lyon",
  phone: "06 12 34 56 78",
  email: `camille.durand.${Date.now()}.${++clients}@example.test`,
});

/** La troisième étape remplie comme un client le ferait, conditions de vente acceptées. */
export async function fillDetails(page: Page, who = client()) {
  await page.getByLabel("Événement").selectOption("Anniversaire");
  await page.getByLabel("Horaires").fill(who.hours);
  await page.getByLabel("Lieu").fill(who.venue);
  await page.getByLabel("Nom").fill(who.name);
  await page.getByLabel("Téléphone").fill(who.phone);
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("J'accepte les conditions générales de vente").check();
  return who;
}

let sequence = 0;

/**
 * Crée une réservation par l'API, sur une date libre (ou `date`), dans l'état demandé. Le nom change à chaque appel :
 * un test retrouve sa réservation sans la confondre avec une autre. Une demande passe par le formulaire public, comme un client.
 * Une réservation refusée ou annulée libère sa date : pour en créer plusieurs d'affilée, il faut leur donner chacune la leur.
 */
export async function seed(
  request: APIRequestContext,
  kind: Kind,
  over: { name?: string; venue?: string; date?: string } = {},
): Promise<Seeded> {
  const date = over.date ?? (await freeDate(request));
  const number = ++sequence;
  const name = over.name ?? `Camille Martin ${number}`;
  const phone = "06 12 34 56 78";
  const venue = over.venue ?? "Domaine des Pins, Lyon";
  const common = { name, phone, email: `camille.${number}@example.test`, event_type: "Mariage", venue, event_hours: "18h-02h" };

  let booking: { id: string; token: string };
  if (kind === "blocked") {
    ({ booking } = await write(request, "post", ADMIN, { kind: "blocked", date, notes: "Congés" }));
    return { id: booking.id, token: booking.token, date, name: "Congés", phone };
  }
  if (kind === "confirmed" || kind === "cancelled") {
    ({ booking } = await write(request, "post", ADMIN, {
      kind: "manual",
      date,
      ...common,
      price_cents: 150_000,
      deposit_cents: 45_000,
      notes: "Rappeler avant la date.",
    }));
    if (kind === "cancelled") await write(request, "post", `${ADMIN}/${booking.id}/cancel`, {});
  } else {
    const created = await request.post("/api/requests", {
      data: { date, plan: FIRST_PLAN.id, ...common, message: "Un fond rose, si possible.", terms: true, turnstile_token: "" },
    });
    expect(created.status(), "POST /api/requests").toBe(201);
    const { bookings } = await (await request.get(`${ADMIN}?from=${date}&to=${date}`)).json();
    booking = bookings.find((b: { client_name: string; status: string }) => b.client_name === name && b.status === "pending_review");
    if (kind === "awaiting") await write(request, "post", `${ADMIN}/${booking.id}/validate`, {});
    if (kind === "refused") await write(request, "post", `${ADMIN}/${booking.id}/refuse`, {});
  }
  return { id: booking.id, token: booking.token, date, name, phone };
}

/** Libère toutes les dates tenues : chaque test repart d'une base sans réservation en cours. */
export async function cleanup(request: APIRequestContext): Promise<void> {
  const from = isoDate(new Date());
  const response = await request.get(`${ADMIN}?from=${from}&to=${addDays(from, CLEANUP_DAYS)}`);
  const { bookings } = (await response.json()) as { bookings: { id: string; status: string }[] };
  for (const { id, status } of bookings) {
    if (status === "pending_review") await write(request, "post", `${ADMIN}/${id}/refuse`, {});
    else if (["awaiting_deposit", "confirmed", "blocked"].includes(status)) await write(request, "post", `${ADMIN}/${id}/cancel`, {});
  }
}
