import { formatEuros } from "../../worker/html";
import { normalTier, offer, pricesBody, type PricesBody } from "../../worker/offer";

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

/** Un élément `tag` dont le lecteur d'écran entend d'abord `spoken`, que l'écran tait, puis `shown`. */
function said(tag: "s" | "span", spoken: string, shown: string): HTMLElement {
  const element = document.createElement(tag);
  const hidden = document.createElement("span");
  hidden.className = "sr-only";
  hidden.textContent = spoken;
  element.append(hidden, shown);
  return element;
}

/**
 * `<b>150 €</b><s>, au lieu de 250 €</s>`, et avec `saving` la pastille `<span class="saving">, soit −100 €</span>` : le
 * lecteur d'écran entend « 150 €, au lieu de 250 €, soit −100 € », l'écran montre la pastille, le prix barré puis le prix.
 */
function showDiscount(amount: Element, priceCents: number, normalCents: number, saving: boolean): void {
  const price = document.createElement("b");
  price.textContent = formatEuros(priceCents);
  const parts = [price, said("s", ", au lieu de ", formatEuros(normalCents))];
  if (saving) {
    const pill = said("span", ", soit ", `\u2212${formatEuros(normalCents - priceCents)}`);
    pill.className = "saving";
    parts.push(pill);
  }
  amount.replaceChildren(...parts);
}

/** Les prix normaux, sans offre : ce que la page écrit d'avance, et ce qu'elle remontre sans réponse de `/api/prices`. */
const NORMAL_PRICES = pricesBody(offer, { tier: normalTier(offer), remaining: null, launch: false });

/**
 * Met à jour `root` ; hors offre, les prix normaux, rien de barré et `[data-launch]` caché. Avec `null`, de même, y compris
 * sur une page qui montrait l'offre : un prix que le serveur ne tient plus ne reste pas affiché.
 */
export function applyPrices(root: ParentNode, fetched: PricesBody | null): void {
  const body = fetched ?? NORMAL_PRICES;
  const launch = body.launch;
  for (const line of root.querySelectorAll<HTMLElement>("[data-launch]")) line.hidden = !launch;
  for (const places of root.querySelectorAll("[data-places]")) {
    places.textContent = launch && body.remaining != null ? placesLine(body.remaining) : "";
  }
  for (const [id, { priceCents, normalCents }] of Object.entries(body.plans)) {
    for (const amount of root.querySelectorAll(`[data-plan="${CSS.escape(id)}"] [data-amount]`)) {
      if (launch && priceCents !== normalCents) showDiscount(amount, priceCents, normalCents, true);
      else amount.textContent = formatEuros(priceCents);
    }
  }
  for (const refill of root.querySelectorAll("[data-refill]")) {
    if (launch && body.refillCents !== body.normalRefillCents) showDiscount(refill, body.refillCents, body.normalRefillCents, false);
    else refill.textContent = formatEuros(body.refillCents);
  }
}
