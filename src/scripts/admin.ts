import offer from "../../config/offer.json";

/**
 * La page d'administration : tout vient de l'API `/api/admin`, derrière Cloudflare Access. Chaque texte du
 * propriétaire est posé par `textContent` ou `setAttribute` (jamais `innerHTML`) : un nom, un message ou des
 * notes écrits par un client ne peuvent pas devenir du code. L'heure vient de l'horloge reçue par `start`.
 */

// ---------- les données de l'API ----------

type Status = "pending_review" | "awaiting_deposit" | "confirmed" | "blocked" | "refused" | "expired" | "cancelled";

type Booking = {
  id: string;
  token: string;
  event_date: string;
  status: Status;
  plan: string | null;
  price_cents: number | null;
  deposit_cents: number | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  event_type: string | null;
  venue: string | null;
  event_hours: string | null;
  message: string | null;
  hold_until: string | null;
  deposit_paid_at: string | null;
  balance_paid_at: string | null;
  notes: string | null;
};

type HistoryEntry = { at: string; actor: string; event: string; detail: string | null };
type Health = { lastCronRun: string | null; failedNotifications: number };
type Problem = { error?: string; fields?: string[] };
type Reply<T = unknown> = { status: number; data: T & Problem };

const BOOKINGS = "/api/admin/bookings";

const STATUS_LABEL: Record<Status, string> = {
  pending_review: "À valider",
  awaiting_deposit: "Attente d'acompte",
  confirmed: "Confirmée",
  blocked: "Date bloquée",
  refused: "Refusée",
  expired: "Expirée",
  cancelled: "Annulée",
};

/** Les états qui tiennent une date : sur un jour, ils passent avant une réservation terminée. */
const HOLDING: Status[] = ["pending_review", "awaiting_deposit", "confirmed", "blocked"];

/** Les événements de l'historique que le propriétaire lit en clair ; les autres s'affichent tels quels. */
const EVENT_LABEL: Record<string, string> = {
  received: "Demande reçue",
  validated: "Validée",
  refused: "Refusée",
  paid: "Acompte payé",
  released: "Date libérée (délai dépassé)",
  cancelled: "Annulée",
};

const ACTOR_LABEL: Record<string, string> = { client: "Client", owner: "Vous", system: "Automatique", stripe: "Paiement" };

const FIELD_LABEL: Record<string, string> = {
  date: "la date",
  name: "le nom",
  phone: "le téléphone",
  email: "l'adresse e-mail",
  event_type: "le type d'événement",
  venue: "le lieu",
  event_hours: "les horaires",
  price_cents: "le prix",
  deposit_cents: "l'acompte",
  notes: "les notes",
};

// ---------- petits outils ----------

function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Élément manquant : ${selector}`);
  return element;
}

type Child = Node | string | false | null | undefined;
type Props = Record<string, string | boolean | undefined | ((event: Event) => void)>;

/** Crée un élément : une propriété `onclick` pose un écouteur, `false` ou `undefined` ne pose rien. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, "");
    else if (value !== false && value !== undefined) element.setAttribute(name, value);
  }
  element.append(...children.filter((child): child is Node | string => Boolean(child)));
  return element;
}

const EUROS = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAY_FORMAT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_FORMAT = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const MOMENT_FORMAT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
/** `en-CA` écrit le jour `AAAA-MM-JJ`. */
const PARIS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });

/** « 1 500,00 € ». */
const euros = (cents: number | null): string => (cents === null ? "—" : `${EUROS.format(cents / 100)} €`);

/** Des euros tapés (« 1500 », « 1 500,50 ») en centimes, ou `null` si ce n'est pas un montant. */
function parseEuros(text: string): number | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text.replace(/[\s€]/g, ""));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : null;
}

/** Le prix tel qu'on le retape : « 1500 » ou « 1500,5 », vide quand il n'est pas fixé. */
const euroInput = (cents: number | null): string => (cents ? String(cents / 100).replace(".", ",") : "");

const formatDay = (date: string): string => DAY_FORMAT.format(new Date(`${date}T00:00:00Z`));
const formatMoment = (iso: string): string => MOMENT_FORMAT.format(new Date(iso));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** « 2 j 5 h », « 5 h 20 min », « 12 min ». */
function duration(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days} j ${hours} h`;
  return hours > 0 ? `${hours} h ${minutes} min` : `${Math.max(minutes, 1)} min`;
}

/** « il y a 3 h » : une seule unité, la plus grande. */
function ago(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < MINUTE_MS) return "il y a moins d'une minute";
  if (ms < HOUR_MS) return `il y a ${Math.floor(ms / MINUTE_MS)} min`;
  return ms < DAY_MS ? `il y a ${Math.floor(ms / HOUR_MS)} h` : `il y a ${Math.floor(ms / DAY_MS)} j`;
}

/** Le temps qui reste avant l'échéance : `late` quand elle est dépassée, `soon` à moins d'un jour. */
function remaining(holdUntil: string | null, now: Date) {
  if (holdUntil === null) return null;
  const ms = new Date(holdUntil).getTime() - now.getTime();
  return { late: ms <= 0, soon: ms < DAY_MS, text: duration(Math.max(ms, 0)) };
}

const monthOf = (date: string): string => date.slice(0, 7);

function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number);
  return monthOf(new Date(Date.UTC(year, number - 1 + by, 1)).toISOString());
}

/** Le dernier jour du mois, `AAAA-MM-JJ`. */
function lastDayOf(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

/** Les semaines du mois, du lundi au dimanche : un jour `AAAA-MM-JJ`, ou `null` hors du mois. */
function monthWeeks(month: string): (string | null)[][] {
  const [year, number] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const days = Number(lastDayOf(month).slice(8));
  const cells = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

const planName = (id: string | null): string | null => offer.plans.find((plan) => plan.id === id)?.name ?? id;

// ---------- l'API ----------

async function call<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body: object = {}): Promise<Reply<T>> {
  try {
    const init: RequestInit =
      method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const response = await fetch(path, init);
    if (response.status === 403) showLogin();
    return { status: response.status, data: (await response.json().catch(() => ({}))) as Reply<T>["data"] };
  } catch {
    return { status: 0, data: {} as Reply<T>["data"] };
  }
}

/** Ce que dit la page quand le serveur refuse ou ne répond pas. */
function explain({ status, data }: Reply): string {
  if (status === 503) return "Le service de paiement ne répond pas. Rien n'a été modifié : réessayez dans un moment.";
  if (status === 409) return data.error === "date_taken" ? "Cette date est déjà prise." : "Cette réservation a changé entre-temps : la fiche vient d'être mise à jour.";
  if (status === 422) return `Vérifiez ${(data.fields ?? []).map((field) => FIELD_LABEL[field] ?? field).join(", ")}.`;
  return "L'opération a échoué. Vérifiez votre connexion, puis réessayez.";
}

// ---------- la page ----------

let clock: () => Date;
let month = "";

const todoZone = $("#todo");
const healthZone = $("#health");
const calendarZone = $("#calendar");
const legend = $("#legend");
const problemNotice = $("#problem");
const sheet = $<HTMLDialogElement>("#sheet");
const confirmation = $<HTMLDialogElement>("#confirm");

function problem(message: string | null): void {
  problemNotice.hidden = message === null;
  problemNotice.textContent = message;
}

function showLogin(): void {
  for (const zone of document.querySelectorAll<HTMLElement>(".zone")) zone.hidden = zone.id !== "login";
  for (const dialog of document.querySelectorAll("dialog")) dialog.close();
}

/** Un message de la fiche : `alert` pour un refus, `status` pour une réussite. */
function say(kind: "alert" | "status", text: string | null): void {
  const notice = $(`#sheet-${kind}`);
  notice.hidden = text === null;
  notice.textContent = text;
}

// ---------- à traiter ----------

const TODO_GROUPS: { status: Status; title: string }[] = [
  { status: "pending_review", title: "À valider" },
  { status: "awaiting_deposit", title: "Acompte attendu" },
];

function renderTodo(todo: Booking[], now: Date): void {
  const groups = TODO_GROUPS.flatMap(({ status, title }) => {
    const rows = todo.filter((booking) => booking.status === status);
    if (rows.length === 0) return [];
    return [h("div", { class: "group" }, h("h3", {}, title), h("ul", { class: "rows" }, ...rows.map((booking) => todoRow(booking, now))))];
  });
  const empty = h("p", { class: "sub", role: "status" }, "Rien à traiter pour le moment.");
  todoZone.replaceChildren(...(groups.length > 0 ? groups : [empty]));
}

function todoRow(booking: Booking, now: Date): HTMLElement {
  const left = remaining(booking.hold_until, now);
  const tone = left?.late ? "danger" : left?.soon ? "warn" : "";
  return h(
    "li",
    {},
    h(
      "button",
      { type: "button", class: "row", onclick: () => void openSheet(booking.id) },
      h("span", { class: "who" }, booking.client_name ?? "Sans nom"),
      h("span", { class: "meta" }, [formatDay(booking.event_date), booking.event_type].filter(Boolean).join(" · ")),
      left && h("span", { class: `pill ${tone}` }, left.late ? "Délai dépassé" : `Il reste ${left.text}`),
    ),
  );
}

// ---------- santé ----------

function renderHealth({ lastCronRun, failedNotifications }: Health, now: Date): void {
  // La tâche passe toutes les 5 minutes : au-delà de 15, elle a manqué des passages.
  const fresh = lastCronRun !== null && now.getTime() - new Date(lastCronRun).getTime() <= 15 * MINUTE_MS;
  const failing = failedNotifications > 0;
  healthZone.replaceChildren(
    h(
      "div",
      { class: "health-row" },
      h("strong", {}, "Dernier passage"),
      h("span", {}, lastCronRun ? ago(lastCronRun, now) : "Aucun passage enregistré"),
      h("span", { class: `pill ${fresh ? "ok" : "warn"}` }, fresh ? "À jour" : "À vérifier"),
      !fresh && h("p", { class: "sub" }, "La tâche automatique libère les dates expirées et envoie les rappels toutes les 5 minutes : sans passage récent, ils sont en retard."),
    ),
    h(
      "div",
      { class: "health-row" },
      h("span", {}, failing ? `${failedNotifications} ${failedNotifications > 1 ? "notifications" : "notification"} en échec` : "Aucune notification en échec"),
      failing && h("span", { class: "pill danger" }, "Alerte"),
      failing && h("p", { class: "sub" }, "Un e-mail ou un message Telegram n'est pas parti après 3 essais : vérifiez Resend et Telegram."),
    ),
  );
}

// ---------- calendrier ----------

/** La réservation à montrer sur un jour : celle qui tient la date, sinon la dernière. */
function featuredByDay(bookings: Booking[]): Map<string, Booking> {
  const byDay = new Map<string, Booking>();
  for (const booking of bookings) {
    const current = byDay.get(booking.event_date);
    if (!current || HOLDING.includes(booking.status) || !HOLDING.includes(current.status)) byDay.set(booking.event_date, booking);
  }
  return byDay;
}

function dayCell(date: string, booking: Booking | undefined, today: string): HTMLElement {
  const props = { "aria-current": date === today ? "date" : undefined };
  const number = String(Number(date.slice(8)));
  if (!booking) return h("td", { "data-date": date }, h("div", { class: "day", ...props }, h("span", { class: "num" }, number)));

  // Le nom du bouton est son contenu : la date entière, puis l'état et le nom, que l'écran étroit ne montre pas.
  const label = STATUS_LABEL[booking.status];
  const who = booking.client_name ?? booking.notes ?? "";
  return h(
    "td",
    { "data-date": date },
    h(
      "button",
      { type: "button", class: "day", ...props, onclick: () => void openSheet(booking.id) },
      h("span", { class: "sr-only" }, `${formatDay(date)} `),
      h("span", { class: "num", "aria-hidden": "true" }, number),
      h("span", { class: `mark st-${booking.status}`, "aria-hidden": "true" }),
      h("span", { class: "cal-label" }, label),
      h("span", { class: "cal-name" }, who),
    ),
  );
}

/** Le mois affiché ; `bookings` est `null` tant que le serveur n'a pas répondu. */
function renderCalendar(bookings: Booking[] | null, today: string): void {
  const title = $("#calendar-title");
  title.textContent = MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`));
  title.dataset.month = month;

  const featured = featuredByDay(bookings ?? []);
  const weekdays = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  calendarZone.replaceChildren(
    h(
      "table",
      { class: "cal", "aria-busy": String(bookings === null), "aria-labelledby": "calendar-title" },
      h("thead", {}, h("tr", {}, ...weekdays.map((day) => h("th", { scope: "col", "aria-label": day }, day[0].toUpperCase())))),
      h(
        "tbody",
        {},
        ...monthWeeks(month).map((week) =>
          h("tr", {}, ...week.map((date) => (date ? dayCell(date, featured.get(date), today) : h("td", {})))),
        ),
      ),
    ),
  );

  const present = (Object.keys(STATUS_LABEL) as Status[]).filter((status) => [...featured.values()].some((booking) => booking.status === status));
  legend.hidden = present.length === 0;
  legend.replaceChildren(...present.map((status) => h("li", {}, h("span", { class: `mark st-${status}` }), STATUS_LABEL[status])));
}

async function loadMonth(): Promise<void> {
  const asked = month;
  const today = PARIS_DAY.format(clock());
  renderCalendar(null, today);
  const reply = await call<{ bookings: Booking[] }>("GET", `${BOOKINGS}?from=${asked}-01&to=${lastDayOf(asked)}`);
  if (asked !== month) return; // le propriétaire a changé de mois entre-temps
  if (reply.status === 200) renderCalendar(reply.data.bookings, today);
  else problem("Impossible de charger le calendrier. Rechargez la page.");
}

async function loadOverview(): Promise<void> {
  const reply = await call<{ todo: Booking[]; health: Health }>("GET", "/api/admin/overview");
  if (reply.status !== 200) return problem("Impossible de charger les demandes en cours. Rechargez la page.");
  const now = clock();
  renderTodo(reply.data.todo, now);
  renderHealth(reply.data.health, now);
}

async function refreshBoard(): Promise<void> {
  problem(null);
  await Promise.all([loadOverview(), loadMonth()]);
}

// ---------- confirmation ----------

type Confirmation = { title: string; text: string; ok: string; keep?: string };

const REFUSE: Confirmation = {
  title: "Refuser cette demande ?",
  text: "Le client est prévenu par e-mail et la date est libérée.",
  ok: "Refuser la demande",
};
const CANCEL: Confirmation = {
  title: "Libérer cette date ?",
  text: "La réservation est annulée et la date libérée. Le client est prévenu s'il a une adresse e-mail. Un remboursement éventuel se fait depuis Stripe.",
  ok: "Annuler la réservation",
  keep: "Garder la réservation",
};
const UNBLOCK: Confirmation = {
  title: "Retirer ce blocage ?",
  text: "La date redevient réservable par les clients.",
  ok: "Retirer le blocage",
};

function confirmed({ title, text, ok, keep = "Annuler" }: Confirmation): Promise<boolean> {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  $("#confirm-keep").textContent = keep;
  confirmation.returnValue = "";
  return new Promise((resolve) => {
    confirmation.addEventListener("close", () => resolve(confirmation.returnValue === "ok"), { once: true });
    confirmation.showModal();
  });
}

// ---------- fiche ----------

type Act = { label: string; tone: "primary" | "ghost" | "danger"; run: (button: HTMLButtonElement) => void | Promise<void> };

const BUTTON_CLASS: Record<Act["tone"], string> = { primary: "primary", ghost: "ghost", danger: "ghost danger" };

/** Les actions d'une fiche selon son état ; la première est l'action principale, en rose. */
function actionsFor(b: Booking): Act[] {
  const adjust: Act = { label: "Ajuster le prix", tone: "ghost", run: () => openPrice(b) };
  switch (b.status) {
    case "pending_review":
      return [
        { label: "Valider", tone: "primary", run: post(b, "validate") },
        adjust,
        { label: "Refuser", tone: "danger", run: post(b, "refuse", { confirm: REFUSE }) },
      ];
    case "awaiting_deposit":
      return [
        { label: "Renvoyer le lien", tone: "primary", run: post(b, "resend-link", { notice: "Le lien de paiement a été renvoyé au client." }) },
        adjust,
        { label: "Annuler la réservation", tone: "danger", run: post(b, "cancel", { confirm: CANCEL }) },
      ];
    case "confirmed":
      return [
        ...(b.balance_paid_at ? [] : [{ label: "Solde réglé", tone: "primary" as const, run: post(b, "balance-paid") }]),
        { label: "Annuler la réservation", tone: "danger", run: post(b, "cancel", { confirm: CANCEL }) },
      ];
    case "blocked":
      return [{ label: "Retirer le blocage", tone: "danger", run: post(b, "cancel", { confirm: UNBLOCK }) }];
    default:
      return [];
  }
}

/** Une action de l'API sur la fiche, confirmée avant si besoin ; ensuite la fiche et le tableau sont relus. */
function post(b: Booking, path: string, options: { confirm?: Confirmation; notice?: string } = {}): Act["run"] {
  return async (button) => {
    if (options.confirm && !(await confirmed(options.confirm))) return;
    button.disabled = true;
    const reply = await call("POST", `${BOOKINGS}/${b.id}/${path}`);
    if (reply.status === 200) {
      await Promise.all([showSheet(b.id, { notice: options.notice }), refreshBoard()]);
    } else if (reply.status === 409) {
      await Promise.all([showSheet(b.id, { alert: explain(reply) }), refreshBoard()]);
    } else {
      button.disabled = false;
      say("alert", explain(reply));
    }
  };
}

function definitions(rows: [string, string | null][]): HTMLElement | null {
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));
  return shown.length === 0 ? null : h("dl", { class: "facts" }, ...shown.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
}

function paymentLink(b: Booking): HTMLElement {
  const input = h("input", { class: "field", id: "paylink", readonly: true, value: `${location.origin}/acompte/${b.token}` });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      say("status", "Lien copié.");
    } catch {
      input.select();
      say("status", "Le lien est sélectionné : copiez-le.");
    }
  };
  return h(
    "div",
    { class: "paylink" },
    h("div", { class: "fld" }, h("label", { for: "paylink" }, "Lien de paiement"), input, h("small", { class: "sub" }, "Le client l'a reçu par e-mail. Vous pouvez aussi le lui envoyer par SMS.")),
    h("button", { type: "button", class: "btn ghost", onclick: () => void copy() }, "Copier le lien"),
  );
}

function notesForm(b: Booking): HTMLElement {
  const notes = h("textarea", { class: "field", id: "sheet-notes", rows: "3", maxlength: "2000" });
  notes.value = b.notes ?? "";
  const form = h(
    "form",
    { class: "stack" },
    h("div", { class: "fld" }, h("label", { for: "sheet-notes" }, "Notes"), notes),
    h("button", { type: "submit", class: "btn ghost" }, "Enregistrer les notes"),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const reply = await call("PATCH", `${BOOKINGS}/${b.id}`, { notes: notes.value.trim() });
    if (reply.status === 200) await Promise.all([showSheet(b.id, { notice: "Notes enregistrées." }), refreshBoard()]);
    else say("alert", explain(reply));
  });
  return form;
}

function historyList(history: HistoryEntry[]): HTMLElement {
  return h(
    "div",
    {},
    h("h3", {}, "Historique"),
    h(
      "ol",
      { class: "history", "aria-label": "Historique" },
      ...history.map((entry) =>
        h(
          "li",
          {},
          h("time", { datetime: entry.at }, formatMoment(entry.at)),
          h("span", { class: "what" }, EVENT_LABEL[entry.event] ?? entry.event),
          h("span", { class: "by" }, [ACTOR_LABEL[entry.actor] ?? entry.actor, entry.detail].filter(Boolean).join(" · ")),
        ),
      ),
    ),
  );
}

function renderSheet(b: Booking, history: HistoryEntry[]): void {
  const now = clock();
  const pill = $("#sheet-pill");
  pill.className = `pill status st-${b.status}`;
  pill.textContent = STATUS_LABEL[b.status];
  $("#sheet-title").textContent = b.client_name ?? "Réservée pour vous";
  $("#sheet-date").textContent = formatDay(b.event_date);
  say("alert", null);
  say("status", null);

  const left = b.status === "pending_review" || b.status === "awaiting_deposit" ? remaining(b.hold_until, now) : null;
  const purpose = b.status === "pending_review" ? "pour répondre" : "pour payer l'acompte";
  const balance = b.price_cents === null ? null : b.balance_paid_at ? 0 : b.price_cents - (b.deposit_cents ?? 0);
  const phone = b.client_phone;
  const actions = actionsFor(b);

  $("#sheet-content").replaceChildren(
    ...[
      (phone || b.client_email) &&
        h(
          "div",
          { class: "contact" },
          phone && h("a", { class: "btn ghost", href: `tel:${phone.replace(/[^\d+]/g, "")}` }, `Appeler ${phone}`),
          b.client_email && h("a", { class: "btn ghost", href: `mailto:${encodeURIComponent(b.client_email)}` }, `Écrire à ${b.client_email}`),
        ),
      left && h("p", { class: "notice" }, left.late ? "Délai dépassé : la date va être libérée." : `Il reste ${left.text} ${purpose}.`),
      definitions([["Formule", planName(b.plan)], ["Type d'événement", b.event_type], ["Lieu", b.venue], ["Horaires", b.event_hours]]),
      b.message && h("div", {}, h("h3", {}, "Message du client"), h("p", { class: "quote" }, b.message)),
      b.price_cents !== null && definitions([["Prix", euros(b.price_cents)], ["Acompte", euros(b.deposit_cents)], ["Solde restant", euros(balance)]]),
      b.deposit_paid_at && h("p", {}, `Acompte payé le ${formatMoment(b.deposit_paid_at)}.`),
      b.balance_paid_at && h("p", {}, `Solde réglé le ${formatMoment(b.balance_paid_at)}.`),
      b.status === "awaiting_deposit" && paymentLink(b),
      actions.length > 0 &&
        h(
          "div",
          { class: "actions" },
          ...actions.map(({ label, tone, run }) =>
            h("button", { type: "button", class: `btn ${BUTTON_CLASS[tone]}`, onclick: (event) => void run(event.currentTarget as HTMLButtonElement) }, label),
          ),
        ),
      notesForm(b),
      historyList(history),
    ].filter((block): block is HTMLElement => Boolean(block)),
  );
}

/** Ouvre la fiche (relue au serveur), avec au besoin un message : `notice` pour une réussite, `alert` pour un refus. */
async function showSheet(id: string, messages: { notice?: string; alert?: string } = {}): Promise<void> {
  const reply = await call<{ booking: Booking; history: HistoryEntry[] }>("GET", `${BOOKINGS}/${encodeURIComponent(id)}`);
  if (reply.status !== 200) {
    sheet.close();
    clearHash();
    problem(reply.status === 404 ? "Cette fiche n'existe plus." : "Impossible d'ouvrir la fiche. Réessayez.");
    return;
  }
  renderSheet(reply.data.booking, reply.data.history);
  if (messages.notice) say("status", messages.notice);
  if (messages.alert) say("alert", messages.alert);
  if (!sheet.open) sheet.showModal();
}

const clearHash = (): void => {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
};

/** L'adresse `/admin#<id>` est celle de la fiche : celle de Telegram et des e-mails du propriétaire. */
async function openSheet(id: string): Promise<void> {
  history.replaceState(null, "", `#${id}`);
  await showSheet(id);
}

async function openFromHash(): Promise<void> {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) await showSheet(id);
  else sheet.close();
}

// ---------- formulaires : ajouter, bloquer, ajuster le prix ----------

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Le corps JSON d'un formulaire : champs vides omis, montants en centimes. `null` si un montant est illisible. */
function readForm(form: HTMLFormElement): Record<string, string | number> | null {
  const body: Record<string, string | number> = {};
  for (const control of form.querySelectorAll<Control>("[name]")) {
    control.setCustomValidity("");
    control.removeAttribute("aria-invalid");
    const text = control.value.trim();
    if (!text) continue;
    if (!control.hasAttribute("data-money")) {
      body[control.name] = text;
      continue;
    }
    const cents = parseEuros(text);
    if (cents === null) {
      control.setCustomValidity("Montant illisible, par exemple 1200 ou 1200,50.");
      control.reportValidity();
      return null;
    }
    body[control.name] = cents;
  }
  return body;
}

let priceTarget = "";

/** Ouvre un formulaire vide, sans l'erreur du précédent envoi. */
function openDialog(dialog: HTMLDialogElement): HTMLFormElement {
  const form = $<HTMLFormElement>("form", dialog);
  form.reset();
  $("[data-error]", form).hidden = true;
  for (const control of form.querySelectorAll<Control>("[name]")) control.removeAttribute("aria-invalid");
  dialog.showModal();
  return form;
}

function openPrice(b: Booking): void {
  const form = openDialog($<HTMLDialogElement>("#price"));
  $<HTMLInputElement>("[name=price_cents]", form).value = euroInput(b.price_cents);
  priceTarget = b.id;
}

/**
 * Ce que chaque formulaire envoie. Une fois la réservation créée (`jump`), le calendrier montre son mois ;
 * dans tous les cas la fiche de la réservation s'ouvre.
 */
const FORMS: Record<string, { send: (body: Record<string, string | number>) => Promise<Reply<{ booking: Booking }>>; jump: boolean }> = {
  add: { send: (body) => call("POST", BOOKINGS, { kind: "manual", ...body }), jump: true },
  block: { send: (body) => call("POST", BOOKINGS, { kind: "blocked", ...body }), jump: true },
  price: { send: (body) => call("PATCH", `${BOOKINGS}/${priceTarget}`, body), jump: false },
};

function wireForm(form: HTMLFormElement): void {
  const dialog = form.closest("dialog")!;
  const error = $("[data-error]", form);
  // Un montant illisible bloque l'envoi tant que son message reste posé : il s'efface dès que le champ change.
  form.addEventListener("input", (event) => (event.target as Control).setCustomValidity(""));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = readForm(form);
    if (!body) return;
    const submit = $<HTMLButtonElement>("[type=submit]", form);
    submit.disabled = true;
    error.hidden = true;
    const { send, jump } = FORMS[form.dataset.form!];
    const reply = await send(body);
    submit.disabled = false;
    if (reply.status === 200 || reply.status === 201) {
      dialog.close();
      if (jump) month = monthOf(reply.data.booking.event_date);
      await Promise.all([openSheet(reply.data.booking.id), refreshBoard()]);
      return;
    }
    error.textContent = explain(reply);
    error.hidden = false;
    const invalid = (reply.data.fields ?? []).flatMap((name) => form.querySelector<Control>(`[name=${name}]`) ?? []);
    for (const control of invalid) control.setAttribute("aria-invalid", "true");
    invalid[0]?.focus();
  });
}

// ---------- démarrage ----------

function start(now: () => Date): void {
  clock = now;
  month = monthOf(PARIS_DAY.format(clock()));

  $("#month-prev").addEventListener("click", () => {
    month = shiftMonth(month, -1);
    void loadMonth();
  });
  $("#month-next").addEventListener("click", () => {
    month = shiftMonth(month, 1);
    void loadMonth();
  });
  for (const button of document.querySelectorAll<HTMLElement>("[data-open]")) {
    button.addEventListener("click", () => openDialog($<HTMLDialogElement>(`#${button.dataset.open}`)));
  }
  for (const form of document.querySelectorAll<HTMLFormElement>("form[data-form]")) wireForm(form);

  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog || dialog === confirmation) return;
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
    });
  }
  for (const button of document.querySelectorAll<HTMLElement>("[data-close]")) button.addEventListener("click", () => button.closest("dialog")!.close());
  $("#confirm-keep").addEventListener("click", () => confirmation.close("keep"));
  $("#confirm-ok").addEventListener("click", () => confirmation.close("ok"));
  $("[data-reload]").addEventListener("click", () => location.reload());

  sheet.addEventListener("close", clearHash);
  addEventListener("hashchange", () => void openFromHash());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshBoard();
  });

  void refreshBoard();
  if (location.hash) void openFromHash();
}

start(() => new Date());
