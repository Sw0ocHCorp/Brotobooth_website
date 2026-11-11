/**
 * Ce que partagent les deux formulaires publics, la réservation (`reservation.ts`) et le contact (`contact.ts`) : l'envoi
 * en JSON, le message d'un champ refusé posé à côté de lui, celui d'un envoi qui n'a pas abouti, et le widget anti-robots
 * de Cloudflare, chargé à la demande. Les textes sont dans la page : ces fonctions ne font que les montrer ou les cacher.
 */

/** La réponse d'un envoi : son statut HTTP (`0` sans réponse, réseau coupé), et son corps JSON, vide s'il n'en a pas. */
export type Reply<Body> = { status: number; data: Partial<Body> };

/** Envoie `body` en JSON, le seul corps qu'un envoi public peut porter. Ne lève jamais : une panne répond `0`. */
export async function postJson<Body>(url: string, body: object): Promise<Reply<Body>> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  } catch {
    return { status: 0, data: {} };
  }
}

/**
 * Les champs de `form`, sous le nom que leur donne l'API, et le message de chacun : l'élément `problem-<nom>` de la page,
 * qui peut aussi signaler ce qui n'est pas un champ du formulaire (la date de la réservation, par exemple).
 */
export function fieldProblems(form: HTMLFormElement) {
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  return {
    control,
    /** Montre le message de `name` et lie le champ à son message ; `null` s'il n'en a pas. */
    flag(name: string): HTMLElement | null {
      const problem = document.getElementById(`problem-${name}`);
      if (!problem) return null;
      problem.hidden = false;
      control(name)?.setAttribute("aria-invalid", "true");
      control(name)?.setAttribute("aria-describedby", problem.id);
      return problem;
    },
    unflag(name: string): void {
      const problem = document.getElementById(`problem-${name}`);
      if (problem) problem.hidden = true;
      control(name)?.removeAttribute("aria-invalid");
      control(name)?.removeAttribute("aria-describedby");
    },
  };
}

/** Montre dans `box` le seul message de `kind` (`data-problem`), et y place le focus pour qu'un lecteur d'écran l'annonce. */
export function showProblem(box: HTMLElement, kind: string): void {
  for (const text of box.querySelectorAll<HTMLElement>("[data-problem]")) text.hidden = text.dataset.problem !== kind;
  box.hidden = false;
  box.focus();
}

// ---------- l'anti-robots ----------

/** Le widget anti-robots de Cloudflare, chargé à la demande (`render=explicit`). */
type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  getResponse(widget: string): string | undefined;
  reset(widget: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Le widget anti-robots posé dans `box`, chargé une fois, au premier `start`. Sans clé (`data-sitekey` vide, essais), rien
 * n'est chargé. Un script injoignable est oublié : `renew` le redemande après un refus anti-robots, sans recharger la page.
 */
export function antiBot(box: HTMLElement) {
  let widget: string | null = null;
  /** Le script tant qu'il charge ou qu'il est chargé ; `null` avant, ou après un échec de chargement. */
  let script: HTMLScriptElement | null = null;

  function start(): void {
    const sitekey = box.dataset.sitekey;
    if (!sitekey || script !== null) return;
    const loading = (script = document.createElement("script"));
    loading.src = TURNSTILE_SCRIPT;
    loading.addEventListener("load", () => {
      widget = window.turnstile?.render(box, { sitekey, theme: "dark", language: "fr", size: "flexible" }) ?? null;
    });
    loading.addEventListener("error", () => {
      loading.remove();
      script = null;
    });
    document.head.append(loading);
  }

  return {
    start,
    /** Le jeton du widget, vide sans widget : le Worker tranche, et une panne du service ne coûte jamais un envoi. */
    token: (): string => (widget === null ? "" : (window.turnstile?.getResponse(widget) ?? "")),
    /**
     * Après chaque réponse : un jeton ne sert qu'une fois, le prochain envoi en demande un nouveau. Sans widget (son script
     * n'a pas pu se charger), un refus anti-robots (`bot`) redemande le script, pour que « réessayez » puisse aboutir.
     */
    renew(bot: boolean): void {
      if (widget !== null) window.turnstile?.reset(widget);
      else if (bot) start();
    },
  };
}
