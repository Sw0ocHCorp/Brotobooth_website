import { formatEuros } from "../../worker/html";
import type { PricesBody } from "../../worker/offer";

/**
 * Les prix du moment, lus sur `GET /api/prices` : l'accueil les pose sur la carte du BrotoBooth, la réservation sur ses
 * choix de formule. `applyPrices` ne connaît que des attributs (`data-launch`, `data-places`, `data-plan` avec un
 * `data-amount` dedans, `data-refill`), jamais la page qui l'appelle. Chaque texte est posé par `textContent`.
 */

/** La réponse de `/api/prices`, ou `null` sur toute erreur : la page garde alors ses prix normaux. `fresh` ignore le cache. */
export async function fetchPrices(fresh = false): Promise<PricesBody | null> {
  try {
    const response = await fetch("/api/prices", fresh ? { cache: "no-cache" } : undefined);
    return response.status === 200 ? ((await response.json()) as PricesBody) : null;
  } catch {
    return null;
  }
}

export const placesLine = (remaining: number): string =>
  remaining === 1 ? "Plus qu'une place à ce prix" : `Plus que ${remaining} places à ce prix`;

/** `<b>150 €</b><s><span class="sr-only">, au lieu de </span>250 €</s>` : le lecteur d'écran entend « 150 €, au lieu de 250 € ». */
function showDiscount(amount: Element, priceCents: number, normalCents: number): void {
  const price = document.createElement("b");
  price.textContent = formatEuros(priceCents);
  const struck = document.createElement("s");
  const spoken = document.createElement("span");
  spoken.className = "sr-only";
  spoken.textContent = ", au lieu de ";
  struck.append(spoken, formatEuros(normalCents));
  amount.replaceChildren(price, struck);
}

/** Met à jour `root` ; avec `null`, ou hors offre, les prix normaux, rien de barré et `[data-launch]` caché. */
export function applyPrices(root: ParentNode, body: PricesBody | null): void {
  const launch = Boolean(body?.launch);
  for (const line of root.querySelectorAll<HTMLElement>("[data-launch]")) line.hidden = !launch;
  for (const places of root.querySelectorAll("[data-places]")) {
    places.textContent = launch && body?.remaining != null ? placesLine(body.remaining) : "";
  }
  if (!body) return;
  for (const [id, { priceCents, normalCents }] of Object.entries(body.plans)) {
    for (const amount of root.querySelectorAll(`[data-plan="${CSS.escape(id)}"] [data-amount]`)) {
      if (launch && priceCents !== normalCents) showDiscount(amount, priceCents, normalCents);
      else amount.textContent = formatEuros(priceCents);
    }
  }
  for (const refill of root.querySelectorAll("[data-refill]")) refill.textContent = formatEuros(body.refillCents);
}
