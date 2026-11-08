import { expect, type APIRequestContext } from "@playwright/test";

/** L'adresse du site d'essai : celle de `BASE_URL` dans `npm run dev:e2e`, avec laquelle l'API compare l'en-tête `Origin`. */
export const ORIGIN = "http://localhost:8788";

const ADMIN = "/api/admin/bookings";
const DAY_MS = 86_400_000;
/** Les dates d'essai commencent à 35 jours : jamais dans le mois affiché à l'ouverture, un mois comptant 31 jours au plus. */
const FIRST_OFFSET_DAYS = 35;
const SEARCH_DAYS = 120;
const CLEANUP_DAYS = 400;

export type Kind = "pending" | "awaiting" | "confirmed" | "blocked" | "refused" | "cancelled";

/** `name` identifie la réservation à l'écran : le nom du client, ou les notes d'une date bloquée. */
export type Seeded = { id: string; token: string; date: string; name: string; phone: string };

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

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
      data: { date, plan: "formule-1", ...common, message: "Un fond rose, si possible.", terms: true, turnstile_token: "" },
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
