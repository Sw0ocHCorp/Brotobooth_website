import { expect, type Locator, type Page } from "@playwright/test";
import { contactLinks, offer } from "../worker/offer";

/** Les éléments à toucher de `root` plus petits que 44 px, décrits par leur texte. */
export const smallTargets = (root: Locator): Promise<string[]> =>
  root.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")]
      .filter((target) => target.getClientRects().length > 0 && !(target instanceof HTMLInputElement && target.type === "hidden"))
      .map((target) => ({ target, ...target.getBoundingClientRect().toJSON() }))
      .filter(({ width, height }) => Math.round(width) < 44 || Math.round(height) < 44)
      .map(({ target, width, height }) => `${target.tagName} ${target.getAttribute("aria-label") ?? target.textContent?.trim().slice(0, 30)} ${width}x${height}`),
  );

/** Rien ne dépasse la largeur de la fenêtre : la page ne défile pas de côté. */
export const hasNoHorizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/**
 * Les moyens de contact de l'offre qui ont une icône (WhatsApp, Instagram), tels que `root` les montre : un lien vers sa cible,
 * sans texte visible, à son nom accessible et en info-bulle, avec un SVG caché aux lecteurs d'écran, blanc comme le texte, dans
 * une cible d'au moins 44 px. Renvoie leur nombre, pour que l'essai ne passe pas à vide.
 */
export async function expectIconLinks(root: Locator): Promise<number> {
  const icons = contactLinks(offer.contact, () => "").filter(({ icon }) => icon);
  for (const { href, name } of icons) {
    const link = root.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("title", name!);
    await expect(link).toHaveText("");
    await expect(link.locator('svg[aria-hidden="true"]')).toHaveCSS("fill", "rgb(255, 255, 255)");
    const box = (await link.boundingBox())!;
    expect(Math.round(box.width), name).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.height), name).toBeGreaterThanOrEqual(44);
  }
  return icons.length;
}
