// Le site en local pour l'essayer : `npm run demo` (docs/essai-local.md).
// Construit le site, prépare la base d'essai (`.wrangler/demo`, gardée d'un lancement à l'autre ; `npm run demo:reset` la vide),
// y pose quelques réservations d'exemple si elle est vide, puis lance le site sur http://localhost:8790 avec le paiement simulé,
// les messages lisibles sur /demo et la tâche automatique déclenchable à la main. Rien ne sort de cette machine.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = 8790;
const ORIGIN = `http://localhost:${PORT}`;
const PERSIST = ".wrangler/demo";
const DAY_MS = 86_400_000;
const READY_TIMEOUT_MS = 90_000;

/** Le jeton de l'agenda change à chaque lancement : il ne protège que cet essai, et le lien à ouvrir est affiché au démarrage. */
const CALENDAR_TOKEN = randomBytes(16).toString("hex");
const SETTINGS = { FAKE_GATEWAYS: "1", PAYMENT_MODE: "simulated", ACCESS_AUD: "local-dev", BASE_URL: ORIGIN, CALENDAR_TOKEN };

/** Wrangler est lancé sans intermédiaire (ni `npx`, ni `npm exec`) : un arrêt demandé à ce script lui parvient directement. */
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const wranglerArgs = (args) => [WRANGLER, ...args];
/** Sans clé anti-robots, même si `.env.production` en porte une pour la publication : l'essai n'appelle aucun service extérieur. */
const NO_TURNSTILE = { ...process.env, PUBLIC_TURNSTILE_SITE_KEY: "" };

// ---------- la base ----------

/** `true` si la base n'a encore aucune réservation, donc si les exemples sont à poser. */
function isEmpty() {
  const answer = execFileSync(
    process.execPath,
    wranglerArgs(["d1", "execute", "DB", "--local", "--persist-to", PERSIST, "--command", "SELECT COUNT(*) AS n FROM bookings", "--json"]),
    { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
  );
  return JSON.parse(answer)[0].results[0].n === 0;
}

// ---------- les exemples ----------

/** Le premier samedi à `days` jours ou plus : des dates de fête, jamais trop proches pour le délai minimum. */
function saturdayAfter(days) {
  const date = new Date(Date.now() + days * DAY_MS);
  while (date.getUTCDay() !== 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Un appel au site, comme le ferait sa propre page : même origine, corps JSON. */
async function call(method, path, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} : ${response.status}`);
  return response.json();
}

/** Une demande de client sur la date, par le formulaire public (l'anti-robots d'essai laisse passer) ; renvoie la réservation créée. */
async function request(date, planId, client) {
  await call("POST", "/api/requests", { date, plan: planId, event_type: "Mariage", terms: true, turnstile_token: "", ...client });
  const { bookings } = await call("GET", `/api/admin/bookings?from=${date}&to=${date}`);
  return bookings.find((booking) => booking.client_email === client.email);
}

async function seedExamples() {
  const plans = JSON.parse(readFileSync("config/offer.json", "utf8")).plans;
  const [first, second = first] = plans.map((plan) => plan.id);
  const venue = "Domaine des Pins, Lyon";

  // Une demande à valider.
  await request(saturdayAfter(45), first, { name: "Camille Martin", phone: "06 12 34 56 78", email: "camille.martin@example.test", venue, event_hours: "18h-02h", message: "Un fond rose, si possible." });
  // Une demande validée, qui attend son acompte : le lien de paiement est dans le message lisible sur /demo.
  const awaiting = await request(saturdayAfter(60), second, { name: "Nadia Lefèvre", phone: "06 98 76 54 32", email: "nadia.lefevre@example.test", venue: "Salle des fêtes, Annecy", event_hours: "19h-01h" });
  await call("PATCH", `/api/admin/bookings/${awaiting.id}`, { price_cents: 90_000 }); // les formules d'essai sont à 0 € : un acompte à payer demande un prix
  await call("POST", `/api/admin/bookings/${awaiting.id}/validate`, {});
  // Une prestation déjà confirmée, et une date bloquée.
  await call("POST", "/api/admin/bookings", { kind: "manual", date: saturdayAfter(75), name: "Julien Moreau", phone: "06 55 44 33 22", email: "julien.moreau@example.test", event_type: "Entreprise", venue: "Hôtel du Parc, Grenoble", event_hours: "20h-02h", price_cents: 150_000, deposit_cents: 45_000, notes: "Rappeler avant la date." });
  await call("POST", "/api/admin/bookings", { kind: "blocked", date: saturdayAfter(90), notes: "Congés" });
}

// ---------- le site ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend que le site réponde, ou qu'il s'arrête (alors `server.exitCode` est posé). */
async function waitUntilReady(server) {
  for (const deadline = Date.now() + READY_TIMEOUT_MS; Date.now() < deadline && server.exitCode === null; await sleep(500)) {
    try {
      if ((await fetch(`${ORIGIN}/api/availability?from=2030-01-01&to=2030-01-02`)).ok) return true;
    } catch {
      // pas encore démarré
    }
  }
  return false;
}

console.log("Construction du site…");
execFileSync("npx", ["astro", "build"], { stdio: ["ignore", "inherit", "inherit"], env: NO_TURNSTILE });
console.log("Préparation de la base d'essai…");
execFileSync(process.execPath, wranglerArgs(["d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST]), { stdio: ["ignore", "inherit", "inherit"] });
const needsExamples = isEmpty();

const vars = Object.entries(SETTINGS).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
const server = spawn(process.execPath, wranglerArgs(["dev", "--port", String(PORT), "--persist-to", PERSIST, "--test-scheduled", ...vars]), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));

if (!(await waitUntilReady(server))) {
  server.kill();
  console.error("Le site d'essai n'a pas démarré : lisez les messages ci-dessus.");
  process.exit(1);
}
if (needsExamples) {
  await seedExamples().catch((error) => console.error(`Les exemples n'ont pas pu être posés (${error.message}). Le site fonctionne sans eux.`));
}

console.log(`
Le site d'essai est prêt.
  Le site                  ${ORIGIN}/
  L'administration         ${ORIGIN}/admin/
  Les messages « envoyés » ${ORIGIN}/demo
  La tâche automatique     ${ORIGIN}/cdn-cgi/handler/scheduled
  Le lien de l'agenda      ${ORIGIN}/agenda/${CALENDAR_TOKEN}.ics
Pour arrêter : Ctrl+C. Pour repartir d'une base vide : npm run demo:reset.
`);
