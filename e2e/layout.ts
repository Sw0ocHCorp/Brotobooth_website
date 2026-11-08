import type { Locator, Page } from "@playwright/test";

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
