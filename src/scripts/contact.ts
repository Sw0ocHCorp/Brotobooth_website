import { antiBot, fieldProblems, postJson, showProblem, type Reply } from "./form";

/**
 * Le formulaire de contact de l'accueil (`#contact`) : l'envoi du message et ce qui suit. Les textes sont dans la page
 * (`Contact.astro`) ; ce script ne fait que les montrer ou les cacher. Ce que le visiteur saisit reste dans les champs
 * quelle que soit l'erreur, et le bouton d'envoi revient toujours. L'anti-robots ne se charge qu'au premier champ touché,
 * jamais à l'arrivée sur l'accueil : un visiteur qui ne nous écrit pas ne contacte pas Cloudflare pour lui.
 */

/** Les champs, sous le nom que leur donne `POST /api/contact`, dans l'ordre du formulaire. */
const FIELDS = ["name", "email", "phone", "message"];

/** Le corps des réponses de `POST /api/contact`. */
type Answer = { status: string; error: string; fields: string[] };

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const form = $("contact-form") as HTMLFormElement;
const sendButton = $("send") as HTMLButtonElement;
const sent = $("sent");
const turnstile = antiBot($("turnstile"));
const { control, flag, unflag } = fieldProblems(form);
let sending = false;

/** Un envoi qui n'a pas abouti pour une raison qui ne tient pas à un champ : le message, et le contact qui l'accompagne. */
const sendProblem = (kind: "failed" | "bot" | "too_many"): void => showProblem($("send-problem"), kind);

/** Les champs refusés, chacun signalé sous lui, et le focus sur le premier. Aucun champ que la page connaisse : l'envoi a échoué. */
function showProblems(fields: string[]): void {
  const flagged = FIELDS.filter((name) => fields.includes(name) && flag(name) !== null);
  if (flagged.length === 0) return sendProblem("failed");
  control(flagged[0])!.focus();
}

/** Le message est parti : le remerciement prend la place du formulaire, et le focus, pour qu'un lecteur d'écran l'annonce. */
function done(): void {
  form.hidden = true;
  sent.hidden = false;
  sent.focus();
}

function answer({ status, data }: Reply<Answer>): void {
  const bot = status === 403 && data.error === "bot";
  turnstile.renew(bot);
  if (status === 201) return done();
  if (status === 422) return showProblems(data.fields ?? []);
  sendProblem(status === 429 ? "too_many" : bot ? "bot" : "failed");
}

async function submit(): Promise<void> {
  if (sending) return;
  $("send-problem").hidden = true;
  for (const name of FIELDS) unflag(name);
  const missing = FIELDS.filter((name) => !control(name)!.checkValidity());
  if (missing.length > 0) return showProblems(missing);

  sending = true;
  sendButton.disabled = true;
  try {
    const body = { ...Object.fromEntries(FIELDS.map((name) => [name, control(name)!.value])), turnstile_token: turnstile.token() };
    answer(await postJson<Answer>("/api/contact", body));
  } catch (error) {
    // Une panne de la page elle-même (le widget qui lève, par exemple) : le visiteur le sait et peut renvoyer ; l'erreur
    // reste dans la console.
    sendProblem("failed");
    throw error;
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
}

/** Le premier champ touché charge l'anti-robots ; un lien ou le bouton, non : le visiteur n'a pas commencé à écrire. */
function firstField(event: FocusEvent): void {
  if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
  form.removeEventListener("focusin", firstField);
  turnstile.start();
}

document.querySelector("#contact .no-js")?.remove();
form.addEventListener("focusin", firstField);
form.addEventListener("input", (event) => unflag((event.target as HTMLInputElement).name));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
