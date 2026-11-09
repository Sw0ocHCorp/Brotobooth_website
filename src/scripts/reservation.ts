import { bookingWindow } from "../../worker/bookings";
import { dayState, lastDayOf, monthCells, monthOf, shiftMonth, type Availability, type DayState } from "./calendar-grid";

/**
 * La réservation (`/reserver`) : le calendrier, les trois étapes et l'envoi de la demande. Les textes sont dans la page ;
 * ce script ne fait que les montrer ou les cacher, et y poser les dates. Ce que le client saisit reste dans les champs
 * d'un bout à l'autre : ni un aller-retour entre étapes (boutons de la carte ou du navigateur), ni une erreur ne les
 * vide, et le bouton d'envoi revient toujours. Le calendrier charge le mois affiché et le suivant ; la vidéo de la borne tourne derrière la carte, sauf
 * si le visiteur a demandé de réduire les animations ou d'économiser ses données. L'heure vient de l'horloge reçue
 * par `start`.
 */

type Step = 1 | 2 | 3 | 4;
type Reply = { status: number; data: { status?: string; error?: string; reason?: string; fields?: string[] } };

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
/** Les champs de la troisième étape, sous le nom que leur donne l'API. */
const FIELDS = ["event_type", "event_hours", "venue", "name", "phone", "email", "terms"];

const DAY_FORMAT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_FORMAT = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
/** Ce que le nom d'un jour dit de lui, sans jamais dire pourquoi une date est prise. */
const STATE_LABEL: Record<DayState, string> = { free: "libre", taken: "déjà réservée", out: "indisponible" };

/** « samedi 12 décembre 2026 ». */
const longDate = (date: string): string => DAY_FORMAT.format(new Date(`${date}T00:00:00Z`));
const capitalized = (text: string): string => text.replace(/^./, (letter) => letter.toUpperCase());

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const days = $("days");
const picked = $("picked");
const goDate = $<HTMLButtonElement>("go-date");
const goPlan = $<HTMLButtonElement>("go-plan");
const prev = $<HTMLButtonElement>("prev");
const next = $<HTMLButtonElement>("next");
const form = $<HTMLFormElement>("step-3");
const sendButton = $<HTMLButtonElement>("send");
const prints = $("prints");
const boothChoices = [...$("booths").querySelectorAll<HTMLButtonElement>(".choice")];
const planChoices = [...prints.querySelectorAll<HTMLButtonElement>(".choice")];
const NO_DATE = picked.textContent ?? "";

// ---------- l'état de la page ----------

/** Le mois affiché, `AAAA-MM`. */
let shown = "";
/** Les dates prises connues et la fenêtre réservable : `null` tant que le serveur n'a pas répondu une première fois. */
let availability: Availability | null = null;
/** Les mois dont les dates prises sont connues, et ceux demandés au serveur (réponse reçue ou attendue). */
const known = new Set<string>();
const asked = new Set<string>();
let chosenDate: string | null = null;
let chosenBooth: string | null = null;
let chosenPlan: string | null = null;
let sending = false;
let widget: string | null = null;
/** Le script du widget anti-robots tant qu'il charge ou qu'il est chargé ; `null` avant, ou après un échec de chargement. */
let turnstileScript: HTMLScriptElement | null = null;

// ---------- le calendrier ----------

/** Les boutons du mois affiché, reconstruits quand il change. Leur état est posé par `renderDays`. */
function renderMonth(): void {
  const [year, month] = shown.split("-").map(Number);
  $("month-name").textContent = capitalized(MONTH_FORMAT.format(new Date(`${shown}-01T00:00:00Z`)));
  days.replaceChildren(
    ...monthCells(year, month).map((date) => {
      if (date === null) return document.createElement("span");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "day";
      button.dataset.date = date;
      button.textContent = String(Number(date.slice(8)));
      return button;
    }),
  );
  renderDays();
}

/**
 * L'état de chaque jour affiché, mis à jour sur place pour que le focus reste où il est : un jour n'est à prendre
 * que libre et connu, et son nom dit sa date entière et son état. Tant que le mois n'est pas connu, rien n'est à prendre.
 */
function renderDays(): void {
  const ready = availability !== null && known.has(shown);
  days.setAttribute("aria-busy", String(!ready));
  prev.disabled = availability === null || shown <= monthOf(availability.earliest);
  next.disabled = availability === null || shown >= monthOf(availability.latest);
  for (const button of days.querySelectorAll<HTMLButtonElement>(".day")) {
    const date = button.dataset.date!;
    const state = ready ? dayState(date, availability!) : null;
    button.disabled = state !== "free";
    button.classList.toggle("taken", state === "taken");
    button.setAttribute("aria-pressed", String(date === chosenDate));
    button.setAttribute("aria-label", state ? `${longDate(date)}, ${STATE_LABEL[state]}` : longDate(date));
  }
}

/**
 * Demande au serveur les dates prises du mois affiché et du suivant, sauf celles déjà demandées. `fresh` les redemande
 * toutes deux, sans le cache du navigateur : une date vient d'être prise. Si le serveur ne répond pas, le contact
 * remplace le calendrier.
 */
async function load(fresh = false): Promise<void> {
  const months = [shown, shiftMonth(shown, 1)].filter((month) => fresh || !asked.has(month));
  if (months.length === 0) return;
  for (const month of months) asked.add(month);
  const from = `${months[0]}-01`;
  const to = lastDayOf(months.at(-1)!);
  let reply: Availability;
  try {
    const response = await fetch(`/api/availability?from=${from}&to=${to}`, { cache: fresh ? "no-cache" : "default" });
    if (!response.ok) throw new Error(`disponibilités : ${response.status}`);
    reply = (await response.json()) as Availability;
  } catch {
    for (const month of months) asked.delete(month);
    calendarDown(true);
    return;
  }
  const elsewhere = availability?.unavailable.filter((date) => date < from || date > to) ?? [];
  availability = { ...reply, unavailable: [...elsewhere, ...reply.unavailable] };
  for (const month of months) known.add(month);
  calendarDown(false);

  // La fenêtre est celle du serveur : le calendrier ne s'ouvre pas sur un mois où rien n'est à prendre.
  const bounded = [monthOf(availability.earliest), shown, monthOf(availability.latest)].sort()[1];
  if (bounded !== shown) return moveTo(bounded);
  renderDays();
}

function moveTo(month: string): void {
  shown = month;
  renderMonth();
  void load();
}

function calendarDown(down: boolean): void {
  $("calendar").hidden = down;
  $("calendar-down").hidden = !down;
}

/** Le jour choisi, ou aucun : le pied de l'étape le dit, et « Continuer » n'est possible qu'avec une date. */
function choose(date: string | null): void {
  chosenDate = date;
  picked.textContent = date ? capitalized(longDate(date)) : NO_DATE;
  goDate.disabled = date === null;
  $("problem-taken").hidden = true;
  $("problem-date").hidden = true;
  renderDays();
}

/** La date demandée ne peut plus l'être : retour au calendrier rechargé, avec `problem` à la place du choix. */
function backToCalendar(problem: HTMLElement, taken: boolean): void {
  const date = chosenDate;
  if (date && taken && availability) availability = { ...availability, unavailable: [...availability.unavailable, date] };
  if (date) shown = monthOf(date);
  choose(null);
  renderMonth();
  problem.hidden = false;
  go(1, problem);
  void load(true);
}

// ---------- les étapes ----------

/** Montre l'étape et y place le focus (son titre, ou `focus`), pour qu'un lecteur d'écran l'annonce. */
function show(step: Step, focus: HTMLElement = $(`step-${step}-title`)): void {
  for (const n of [1, 2, 3, 4]) $(`step-${n}`).hidden = n !== step;
  const crumbs = $("crumbs");
  crumbs.hidden = step === 4;
  [...crumbs.children].forEach((crumb, index) =>
    index + 1 === step ? crumb.setAttribute("aria-current", "step") : crumb.removeAttribute("aria-current"),
  );
  if (step === 3) startTurnstile();
  scrollTo(0, 0);
  focus.focus({ preventScroll: true });
}

/** Passe à l'étape avec une entrée d'historique : le bouton Précédent du navigateur ramène à l'étape d'avant. */
function go(step: Step, focus?: HTMLElement): void {
  history.pushState({ step }, "");
  show(step, focus);
}

/** L'étape d'une entrée d'historique, ou la plus avancée encore possible : pas de formule sans date, ni de coordonnées sans formule. */
function reachable(step: Step): Step {
  if (step > 1 && chosenDate === null) return 1;
  if (step > 2 && chosenPlan === null) return 2;
  return step;
}

/**
 * La borne choisie, ou aucune : seuls ses nombres de tirages apparaissent, juste dessous, et le focus reste où il est.
 * Une autre borne efface le nombre de tirages choisi.
 */
function chooseBooth(choice: HTMLButtonElement | null): void {
  const booth = choice?.dataset.booth ?? null;
  if (booth !== chosenBooth) choosePlan(null);
  chosenBooth = booth;
  for (const other of boothChoices) other.setAttribute("aria-pressed", String(other === choice));
  for (const plan of planChoices) plan.hidden = plan.dataset.booth !== booth;
  prints.hidden = booth === null;
}

function choosePlan(choice: HTMLButtonElement | null): void {
  chosenPlan = choice?.dataset.plan ?? null;
  for (const other of planChoices) other.setAttribute("aria-pressed", String(other === choice));
  goPlan.disabled = choice === null;
  $("problem-plan").hidden = true;
}

// ---------- les erreurs à côté de leur champ ----------

const control = (name: string): HTMLInputElement | HTMLSelectElement | null =>
  form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;

/** Montre le message de `name` (un champ, la date ou la formule) et lie le champ à son message ; `null` s'il n'en a pas. */
function flag(name: string): HTMLElement | null {
  const problem = document.getElementById(`problem-${name}`);
  if (!problem) return null;
  problem.hidden = false;
  control(name)?.setAttribute("aria-invalid", "true");
  control(name)?.setAttribute("aria-describedby", problem.id);
  return problem;
}

function unflag(name: string): void {
  const problem = document.getElementById(`problem-${name}`);
  if (problem) problem.hidden = true;
  control(name)?.removeAttribute("aria-invalid");
  control(name)?.removeAttribute("aria-describedby");
}

/**
 * Les champs refusés, chacun signalé à côté de lui. Une date refusée ramène au calendrier, une formule refusée à son
 * étape ; sinon, le focus va au premier champ à reprendre. Aucun champ que la page connaisse : l'envoi a échoué.
 */
function showProblems(fields: string[]): void {
  const flagged = fields.filter((name) => (name === "date" || name === "plan" || FIELDS.includes(name)) && flag(name) !== null);
  if (flagged.length === 0) return sendProblem("failed");
  if (flagged.includes("date")) return backToCalendar($("problem-date"), false);
  if (flagged.includes("plan")) {
    choosePlan(null);
    $("problem-plan").hidden = false;
    return go(2, $("problem-plan"));
  }
  control(FIELDS.find((name) => flagged.includes(name))!)!.focus();
}

/** Un envoi qui n'a pas abouti pour une raison qui ne tient pas à un champ : le message, et le contact qui l'accompagne. */
function sendProblem(kind: "failed" | "bot" | "too_many" | "too_many_ip"): void {
  const box = $("send-problem");
  for (const text of box.querySelectorAll<HTMLElement>("[data-problem]")) text.hidden = text.dataset.problem !== kind;
  box.hidden = false;
  box.focus();
}

// ---------- l'envoi ----------

/**
 * Le widget anti-robots, chargé une fois, à la première arrivée sur les coordonnées. Sans clé (essais), rien n'est
 * chargé. Un script injoignable est oublié : un refus anti-robots le redemande (`answer`), sans recharger la page.
 */
function startTurnstile(): void {
  const box = $("turnstile");
  const sitekey = box.dataset.sitekey;
  if (!sitekey || turnstileScript !== null) return;
  const script = (turnstileScript = document.createElement("script"));
  script.src = TURNSTILE_SCRIPT;
  script.addEventListener("load", () => {
    widget = window.turnstile?.render(box, { sitekey, theme: "dark", language: "fr", size: "flexible" }) ?? null;
  });
  script.addEventListener("error", () => {
    script.remove();
    turnstileScript = null;
  });
  document.head.append(script);
}

/** Le jeton du widget, vide sans widget : le Worker tranche, et une panne du service ne coûte jamais une demande. */
const turnstileToken = (): string => (widget === null ? "" : (window.turnstile?.getResponse(widget) ?? ""));

async function post(body: object): Promise<Reply> {
  try {
    const response = await fetch("/api/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  } catch {
    return { status: 0, data: {} };
  }
}

function done(outcome: string): void {
  for (const date of document.querySelectorAll("[data-chosen]")) date.textContent = longDate(chosenDate!);
  for (const text of document.querySelectorAll<HTMLElement>("[data-outcome]")) text.hidden = text.dataset.outcome !== outcome;
  go(4);
}

function answer({ status, data }: Reply): void {
  // Un jeton ne sert qu'une fois : le prochain envoi en demande un nouveau. Sans widget (son script n'a pas pu se
  // charger), un refus anti-robots redemande le script, pour que « réessayez » puisse aboutir.
  const bot = status === 403 && data.error === "bot";
  if (widget !== null) window.turnstile?.reset(widget);
  else if (bot) startTurnstile();
  if (status === 201) return done("created");
  if (status === 200 && data.status === "already_requested") return done("already_requested");
  if (status === 409) return backToCalendar($("problem-taken"), true);
  if (status === 422) return showProblems(data.fields ?? []);
  // Deux limites répondent 429 : celle des demandes en cours de ce client, et celle des demandes parties de sa connexion.
  sendProblem(status === 429 ? (data.reason === "ip" ? "too_many_ip" : "too_many") : bot ? "bot" : "failed");
}

/** Le corps de `POST /api/requests`, sous les noms de l'API. */
function request(): object {
  return {
    ...Object.fromEntries(FIELDS.map((name) => [name, control(name)!.value])),
    date: chosenDate,
    plan: chosenPlan,
    terms: ($("f-terms") as HTMLInputElement).checked,
    turnstile_token: turnstileToken(),
  };
}

async function submit(): Promise<void> {
  if (sending || chosenDate === null || chosenPlan === null) return;
  $("send-problem").hidden = true;
  for (const name of FIELDS) unflag(name);
  const missing = FIELDS.filter((name) => !control(name)!.checkValidity());
  if (missing.length > 0) return showProblems(missing);

  sending = true;
  sendButton.disabled = true;
  try {
    answer(await post(request()));
  } catch (error) {
    // Une panne de la page elle-même (le widget qui lève, par exemple) : le client le sait et peut renvoyer ; l'erreur
    // reste dans la console.
    sendProblem("failed");
    throw error;
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
}

// ---------- la vidéo ----------

/**
 * La vidéo tourne sauf si le visiteur a demandé de réduire les animations ou d'économiser ses données. Son bouton de
 * pause n'apparaît qu'une fois qu'elle tourne : une vidéo que ce navigateur ne lit pas garde l'image fixe, sans bouton.
 */
function startFilm(): void {
  const film = document.querySelector<HTMLVideoElement>(".film");
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  if (!film || saveData || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const toggle = $<HTMLButtonElement>("film-toggle");
  const label = () => {
    toggle.toggleAttribute("data-paused", film.paused);
    toggle.setAttribute("aria-label", (film.paused ? toggle.dataset.play : toggle.dataset.pause) ?? "");
  };
  for (const type of ["play", "pause"]) film.addEventListener(type, label);
  film.addEventListener("playing", () => (toggle.hidden = false), { once: true });
  toggle.addEventListener("click", () => {
    if (film.paused) film.play().catch(() => {});
    else film.pause();
  });
  film.muted = true;
  film.play().catch(() => {});
}

// ---------- démarrage ----------

function start(now: () => Date): void {
  $("no-js").remove();
  shown = monthOf(bookingWindow(now()).earliest);

  prev.addEventListener("click", () => moveTo(shiftMonth(shown, -1)));
  next.addEventListener("click", () => moveTo(shiftMonth(shown, 1)));
  days.addEventListener("click", (event) => {
    const day = (event.target as Element).closest<HTMLButtonElement>(".day");
    if (day && !day.disabled) choose(day.dataset.date!);
  });
  $("retry").addEventListener("click", () => {
    calendarDown(false);
    $("step-1-title").focus();
    void load();
  });

  goDate.addEventListener("click", () => go(chosenPlan ? 3 : 2));
  goPlan.addEventListener("click", () => go(reachable(3)));
  for (const choice of boothChoices) choice.addEventListener("click", () => chooseBooth(choice));
  for (const choice of planChoices) choice.addEventListener("click", () => choosePlan(choice));
  for (const back of document.querySelectorAll<HTMLElement>("[data-back]")) {
    back.addEventListener("click", () => go(Number(back.dataset.back) as Step));
  }
  history.scrollRestoration = "manual";
  history.replaceState({ step: 1 }, "");
  addEventListener("popstate", (event) => show(reachable((event.state as { step?: Step } | null)?.step ?? 1)));
  form.addEventListener("input", (event) => unflag((event.target as HTMLInputElement).name));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  // Aucune formule au départ, quel que soit l'état que le navigateur a gardé du bouton « Continuer » (Firefox le garde).
  choosePlan(null);
  // « Choisir le … » sur une borne de l'accueil : `?borne=<id>`. Une borne à venir ne se choisit pas, même par l'adresse.
  const wanted = new URLSearchParams(location.search).get("borne");
  chooseBooth(boothChoices.find((choice) => choice.dataset.booth === wanted && !choice.disabled) ?? null);

  renderMonth();
  void load();
  startFilm();
}

start(() => new Date());
