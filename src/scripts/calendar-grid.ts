/**
 * La grille du calendrier de `/reserver`, sans rien afficher : quels jours dans quelles cases, et ce que vaut chaque jour.
 * Les jours sont des dates `AAAA-MM-JJ` et les mois `AAAA-MM`, comme ceux de l'API, sans heure ni fuseau.
 */

/** La réponse de `GET /api/availability` : les dates prises de la plage demandée, et la fenêtre où une demande est possible. */
export type Availability = { unavailable: readonly string[]; earliest: string; latest: string };

/** `out` : avant le délai minimum ou au-delà de l'horizon. Ce n'est pas une date prise, et le calendrier ne la barre pas. */
export type DayState = "free" | "taken" | "out";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Les cases du mois (`month` de 1 à 12), semaine commençant le lundi : `null` pour chaque case avant le 1er, puis chaque jour. */
export function monthCells(year: number, month: number): (string | null)[] {
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length }, (_, day) => `${year}-${pad(month)}-${pad(day + 1)}`),
  ];
}

export function dayState(date: string, { unavailable, earliest, latest }: Availability): DayState {
  if (date < earliest || date > latest) return "out";
  return unavailable.includes(date) ? "taken" : "free";
}

export const monthOf = (date: string): string => date.slice(0, 7);

/** Le mois `by` mois après `month` (avant, si `by` est négatif). */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, number - 1 + by, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/** Le dernier jour du mois. */
export function lastDayOf(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return `${month}-${pad(new Date(Date.UTC(year, number, 0)).getUTCDate())}`;
}
