# Site Brotobooth : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** construire le site de Brotobooth : une vitrine bâtie sur les vrais supports, et un calendrier de réservation qui rend impossibles deux prestations le même jour, jusqu'à être prêt à publier.

**Architecture :** pages statiques Astro servies sans passer par le Worker ; un Worker TypeScript sans framework porte l'API, le paiement, l'administration et une tâche automatique toutes les 5 minutes ; D1 est la seule source de vérité, et un index unique garantit une réservation par date. Les services externes passent par un objet `Deps` injecté, remplacé par des doublures dans les tests.

**Tech Stack :** Node 24, TypeScript, Astro 7, Wrangler 4, D1, Vitest 5 avec `@cloudflare/vitest-plugin`, Playwright et `@axe-core/playwright`, SDK `stripe`. Resend, Telegram et Turnstile passent par `fetch`, sans SDK.

**Spec :** [`docs/superpowers/specs/2026-11-07-site-reservations-design.md`](../specs/2026-11-07-site-reservations-design.md). **Maquette :** [`docs/superpowers/specs/2026-11-07-maquette-site.html`](../specs/2026-11-07-maquette-site.html), qui fixe les textes et la mise en page, et contient le code d'animation à porter.

**Ce plan s'arrête avant la publication :** la mise en ligne demande les comptes et les contenus du propriétaire. La tâche 19 livre la procédure et le contrôle qui bloque une publication incomplète.

**Paiement réel en dernier (demande du propriétaire, 2026-11-07) :** le propriétaire veut vérifier le fonctionnement du site avant de brancher le vrai système de règlement. Les tâches 1 à 19 utilisent donc un paiement simulé. Après la tâche 19 et la relecture de la branche, l'exécution **s'arrête** pour que le propriétaire essaie le site en local (`npm run demo`). La tâche 20 (Stripe réel) ne démarre qu'avec son accord.

## Global Constraints

- Identifiants de code et de base en anglais, adresses visibles par les clients en français (`/reserver`, `/acompte`, `/agenda`, `/cgv`).
- Chaque phrase visible s'adresse au client qui réserve (« vous »), les invités à la troisième personne. Jamais de vocabulaire interne : ni bloquer, ni valider, ni statut.
- Aucune image de banque ni illustration générique : médias issus de `/home/sw0och/Spot_pub_Brotobooth` et de `brand/` uniquement.
- DA « Sunset » : noir nuit `#0B0B0F`, rose `#F2559B` pour l'action et au plus un bouton plein par écran, orange `#FF8A3D` pour le choix fait et toujours en anneau, texte blanc, jamais de couleur de marque en texte, pas de relief hors de l'animation du logo.
- Polices : Unbounded 800 pour les titres, 700 pour les boutons d'action, Outfit 400 et 600 pour le reste.
- Règles de réservation : une date par prestation, 72 h pour valider, 72 h pour payer, 7 jours minimum avant l'événement, 24 mois maximum, rappels à 9 h heure de Paris.
- Enregistrer une demande ne dépend que du Worker et de D1 : une panne de Resend, Telegram, Stripe ou du service Turnstile ne fait jamais échouer une demande.
- Toute date ou heure passe par `now` injecté, jamais par `new Date()` dans la logique.
- Aucune donnée personnelle dans les journaux. Aucun cookie de suivi. Aucun secret dans le dépôt.
- Le dépôt `/home/sw0och/BrotoBooth`, son bot, son projet Supabase et sa page Netlify ne sont pas modifiés.
- Cibles tactiles de 44 px au moins. Animations désactivées avec `prefers-reduced-motion`.
- Dépendances minimales : pas de framework d'interface, pas de routeur HTTP, pas de bibliothèque de dates.

## Review Focus

1. **Le même formulaire envoyé deux fois** (double clic, retour arrière) : même date et même e-mail donnent une réussite, pas « cette date vient d'être prise ». Test en tâche 5.
2. **Un texte inattendu dans le nom, le lieu ou le message** (`<b>`, `&`, retours à la ligne, virgules, points-virgules, emoji) : affiché tel quel partout, sans casser Telegram, l'e-mail, l'agenda ni `/acompte`. Tests en tâches 7, 9 et 11.
3. **Un bouton Telegram touché deux fois ou après un changement d'état** : aucun second e-mail, et un message clair indiquant que c'est déjà traité. Test en tâche 10.
4. **Le lien d'acompte ouvert dans tous les états** (déjà payé, expiré, annulé, prix ajusté, double clic sur payer) : une page compréhensible, jamais un second paiement. Tests en tâche 7.
5. **Une coupure réseau à l'envoi du formulaire** : la saisie reste à l'écran, et le téléphone et l'e-mail s'affichent. Test en tâche 17.

---

### Task 1: Socle du dépôt

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `astro.config.mjs`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`, `worker/index.ts`, `worker/env.ts`, `src/pages/index.astro`, `test/apply-migrations.ts`, `test/worker/health.test.ts`, `migrations/0000_empty.sql`

**Interfaces:**
- Produces: `Env` (`worker/env.ts`) avec `DB: D1Database`, `ASSETS: Fetcher`, `BASE_URL`, `OWNER_EMAIL`, `FROM_EMAIL`, `ACCESS_AUD`, `TURNSTILE_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CHAT_IDS`, `CALENDAR_TOKEN`, `IP_HASH_SALT` (toutes `string`), `FAKE_GATEWAYS?: string`.

- [ ] **Step 1: Créer le dépôt et un premier commit des fichiers existants**

`.gitignore` : `node_modules/`, `dist/`, `.wrangler/`, `.astro/`, `.dev.vars*` sauf `.dev.vars.example`, `.superpowers/`, `test-results/`, `playwright-report/`.

```bash
git init -b main
git add .gitignore README.md logo-blanc.svg logo-noir.svg brand fonts templates docs
git commit -m "docs: spec, plan et identité de Brotobooth"
git switch -c feat/site
```

Expected : `git status` propre, `.superpowers/` absent du commit.

- [ ] **Step 2: Installer les dépendances**

```bash
npm init -y
npm install --save-dev astro@7 wrangler@4 typescript vitest@5 @cloudflare/vitest-plugin @cloudflare/workers-types @playwright/test @axe-core/playwright
npm install stripe@23
```

Scripts : `test` = `vitest run` (avec `pretest` = `mkdir -p dist`), `build` = `astro build`, `dev` = `astro build && wrangler dev`, `db:migrate:local` = `wrangler d1 migrations apply DB --local`.

- [ ] **Step 3: Configurer Wrangler, Vitest et Astro**

`wrangler.jsonc` : `main: worker/index.ts`, `compatibility_date: 2026-11-07`, `assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "404-page", run_worker_first: ["/api/*", "/acompte/*", "/agenda/*"] }`, `triggers: { crons: ["*/5 * * * *"] }`, `d1_databases: [{ binding: "DB", database_name: "brotobooth", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }]`, `vars: { BASE_URL: "https://brotobooth.fr" }`, `access: { dev: { aud: "local-dev", identity: { email: "owner@example.test" } } }`.

`vitest.config.ts` : plugin `cloudflareTest` lisant `wrangler.jsonc`, `readD1Migrations("./migrations")` exposé dans `TEST_MIGRATIONS`, `setupFiles: ["./test/apply-migrations.ts"]`, qui appelle `applyD1Migrations`.

`astro.config.mjs` : sortie statique par défaut, `site: "https://brotobooth.fr"`.

- [ ] **Step 4: Écrire le test qui échoue**

```ts
// test/worker/health.test.ts
import { exports } from "cloudflare:workers";
it("répond 404 en JSON sur une route d'API inconnue", async () => {
  const res = await exports.default.fetch("https://brotobooth.fr/api/inconnue");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
```

- [ ] **Step 5: Lancer le test pour le voir échouer**

Run : `npx vitest run test/worker/health.test.ts`. Expected : FAIL, car `worker/index.ts` n'existe pas.

- [ ] **Step 6: Implémenter `worker/index.ts`**

`export default { fetch, scheduled }` : `fetch` renvoie ce 404 en JSON, `scheduled` ne fait rien pour l'instant. `src/pages/index.astro` contient juste un `<h1>`.

- [ ] **Step 7: Vérifier le test et la génération**

Run : `npm test && npm run build`. Expected : PASS, puis `dist/index.html` existe.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: socle Astro, Worker, D1 et tests"
```

### Task 2: Règles de réservation (code pur)

**Files:**
- Create: `config/offer.json`, `worker/offer.ts`, `worker/bookings.ts`, `test/worker/bookings.test.ts`

**Interfaces:**
- Produces, `worker/offer.ts` : `offer: Offer`, type des champs de `config/offer.json`, `planById(id: string): Plan | undefined`.
- Produces, `worker/bookings.ts` :
  - `type BookingStatus = "pending_review" | "awaiting_deposit" | "confirmed" | "blocked" | "refused" | "expired" | "cancelled"`
  - `type BookingAction = "validate" | "refuse" | "pay" | "expire" | "cancel"`
  - `ACTIVE_STATUSES: readonly BookingStatus[]` (les quatre qui tiennent une date)
  - `nextStatus(status, action): BookingStatus | null`, `null` si l'action est interdite
  - `parisToday(now: Date): string`, `addDays(date: string, days: number): string`, `parisInstant(date: string, hour: number): Date`, `parisWeekday(now: Date): number` (lundi = 1), `parisHour(now: Date): number`
  - `checkDate(date: string, now: Date): "ok" | "too_soon" | "too_far" | "invalid"`
  - `depositCents(priceCents: number, percent: number): number`

- [ ] **Step 1: Créer `config/offer.json`**

```json
{
  "draft": true,
  "depositPercent": 30,
  "reviewHours": 72,
  "paymentHours": 72,
  "minLeadDays": 7,
  "horizonMonths": 24,
  "maxActivePerEmail": 2,
  "maxPerIpPer24h": 5,
  "reminderHourParis": 9,
  "termsVersion": "2026-11-07",
  "eventTypes": ["Mariage", "Anniversaire", "Entreprise", "Autre"],
  "contact": { "phone": "", "email": "", "social": [] },
  "plans": [
    { "id": "formule-1", "name": "Formule 1", "priceCents": 0, "includes": [] },
    { "id": "formule-2", "name": "Formule 2", "priceCents": 0, "includes": [] },
    { "id": "formule-3", "name": "Formule 3", "priceCents": 0, "includes": [] }
  ]
}
```

`draft: true` signale des contenus provisoires. La tâche 19 refuse de publier dans cet état.

- [ ] **Step 2: Écrire les tests qui échouent**

```ts
it.each([
  ["pending_review", "validate", "awaiting_deposit"], ["pending_review", "refuse", "refused"],
  ["pending_review", "expire", "expired"], ["pending_review", "pay", null],
  ["awaiting_deposit", "pay", "confirmed"], ["awaiting_deposit", "expire", "expired"],
  ["awaiting_deposit", "cancel", "cancelled"], ["awaiting_deposit", "validate", null],
  ["confirmed", "cancel", "cancelled"], ["confirmed", "pay", null], ["confirmed", "expire", null],
  ["blocked", "cancel", "cancelled"], ["refused", "validate", null],
  ["expired", "pay", null], ["cancelled", "cancel", null],
])("%s + %s donne %s", (s, a, e) => expect(nextStatus(s, a)).toBe(e));

it("calcule le jour à Paris, pas en UTC", () => {
  expect(parisToday(new Date("2026-11-07T23:30:00Z"))).toBe("2026-11-08");
});
it("place 9 h de Paris selon la saison", () => {
  expect(parisInstant("2026-11-07", 9).toISOString()).toBe("2026-11-07T08:00:00.000Z");
  expect(parisInstant("2026-07-01", 9).toISOString()).toBe("2026-07-01T07:00:00.000Z");
  expect(parisInstant("2026-03-29", 9).toISOString()).toBe("2026-03-29T07:00:00.000Z");
  expect(parisInstant("2026-10-25", 9).toISOString()).toBe("2026-10-25T08:00:00.000Z");
});
it("applique le délai minimum et l'horizon en heure de Paris", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  expect(checkDate("2026-11-13", now)).toBe("too_soon");
  expect(checkDate("2026-11-14", now)).toBe("ok");
  expect(checkDate("2028-11-07", now)).toBe("ok");
  expect(checkDate("2028-11-08", now)).toBe("too_far");
  expect(checkDate("2026-11-14", new Date("2026-11-07T23:30:00Z"))).toBe("too_soon");
});
it.each(["2026-02-30", "abc", "2026-13-01", ""])("refuse la date %s", d =>
  expect(checkDate(d, new Date("2026-11-07T10:00:00Z"))).toBe("invalid"));
it("arrondit l'acompte à l'euro", () => {
  expect(depositCents(100000, 30)).toBe(30000);
  expect(depositCents(12345, 30)).toBe(3700);
  expect(depositCents(0, 30)).toBe(0);
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/bookings.test.ts`. Expected : FAIL, module introuvable.

- [ ] **Step 4: Implémenter `worker/offer.ts` et `worker/bookings.ts`**

Dates via `Intl.DateTimeFormat` avec `timeZone: "Europe/Paris"`. `parisInstant` : partir de la date à l'heure voulue en UTC, mesurer l'écart de Paris à cet instant, le retrancher, puis remesurer une fois pour couvrir un changement d'heure. L'horizon compte `horizonMonths` mois à partir du jour à Paris.

- [ ] **Step 5: Vérifier**

Run : `npx vitest run test/worker/bookings.test.ts`. Expected : PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: règles de réservation et offre"
```

### Task 3: Schéma et accès à D1

**Files:**
- Create: `migrations/0001_init.sql`, `worker/repository.ts`, `test/support.ts`, `test/worker/repository.test.ts`
- Remove: `migrations/0000_empty.sql`

**Interfaces:**
- Consumes : `BookingStatus`, `ACTIVE_STATUSES`.
- Produces, `worker/repository.ts` :
  - `Booking` (forme exacte d'une ligne, colonnes de la spec, section 3), `NewBooking` (sans `created_at`, `updated_at`)
  - `NotificationSpec = { booking_id: string | null; dedupe_key: string; channel: "email" | "telegram"; recipient: "owner" | "client"; template: string; due_at: string }`, `NotificationRow = NotificationSpec & { id: number; sent_at: string | null; cancelled_at: string | null; attempts: number; last_error: string | null }`
  - `insertBooking(db, b: NewBooking, specs: NotificationSpec[], nowIso: string): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "date_taken" }>`
  - `applyTransition(db, t: { id: string; from: BookingStatus; to: BookingStatus; patch?: Partial<Booking>; actor: string; event: string; detail?: string; cancelPending?: boolean; notifications?: NotificationSpec[]; nowIso: string }): Promise<Booking | null>`, `null` si l'état a changé entre-temps
  - `patchBooking(db, id, patch: Partial<Booking>, actor: string, event: string, nowIso: string): Promise<Booking | null>`
  - `getBooking(db, id)`, `getBookingByToken(db, token)`, `findActiveByDateAndEmail(db, date, email)`, `listUnavailableDates(db, from, to): Promise<string[]>`, `countActiveByEmail(db, email)`, `countRecentByIp(db, ipHash, sinceIso)`, `listDueHolds(db, nowIso)`, `listUpcoming(db, fromDate, statuses)`, `listRange(db, from, to)`, `listTodo(db)`, `getHistory(db, id)`, `anonymizeOld(db, beforeIso): Promise<number>`
  - `enqueue(db, specs)` (`INSERT OR IGNORE`), `listDueNotifications(db, nowIso, limit)`, `markSent(db, id, nowIso)`, `markFailed(db, id, error)`, `listFailedNotifications(db)`, `getState(db, key)`, `setState(db, key, value)`
- Produces, `test/support.ts` : `T0 = "2026-11-07T10:00:00.000Z"`, `newBooking(over?: Partial<NewBooking>): NewBooking` (date par défaut `2026-12-19`, statut `pending_review`, source `site`, identifiants aléatoires), `insert(nb: NewBooking): Promise<{ booking: Booking }>`, `spec(key: string, bookingId?: string): NotificationSpec` (e-mail au propriétaire, dû à `T0`), `resetDb(db)`, appelé avant chaque test.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("refuse une deuxième réservation active sur la même date", async () => {
  expect((await insertBooking(env.DB, newBooking(), [], T0)).ok).toBe(true);
  expect(await insertBooking(env.DB, newBooking(), [], T0)).toEqual({ ok: false, reason: "date_taken" });
});
it("ne laisse passer qu'une demande sur deux envoyées en même temps", async () => {
  const r = await Promise.all([insertBooking(env.DB, newBooking(), [], T0), insertBooking(env.DB, newBooking(), [], T0)]);
  expect(r.filter(x => x.ok)).toHaveLength(1);
});
it.each(["refused", "expired", "cancelled"])("une réservation %s libère la date", async status => {
  await insertBooking(env.DB, newBooking({ status }), [], T0);
  expect((await insertBooking(env.DB, newBooking(), [], T0)).ok).toBe(true);
});
it.each(["pending_review", "awaiting_deposit", "confirmed", "blocked"])("une réservation %s tient la date", async status => {
  await insertBooking(env.DB, newBooking({ status }), [], T0);
  expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual(["2026-12-19"]);
});
it("une transition sur un état périmé ne change rien et n'écrit rien", async () => {
  const { booking } = await insert(newBooking({ status: "confirmed" }));
  const r = await applyTransition(env.DB, { id: booking.id, from: "pending_review", to: "refused", actor: "owner", event: "refused",
    notifications: [spec("k1")], nowIso: T0 });
  expect(r).toBeNull();
  expect((await getBooking(env.DB, booking.id))!.status).toBe("confirmed");
  expect(await getHistory(env.DB, booking.id)).toHaveLength(0);
  expect(await listDueNotifications(env.DB, T0, 10)).toHaveLength(0);
});
it("une transition valide écrit l'historique, annule les envois en attente et planifie les suivants", async () => {
  const nb = newBooking();
  await insertBooking(env.DB, nb, [spec("avant", nb.id)], T0);
  const r = await applyTransition(env.DB, { id: nb.id, from: "pending_review", to: "awaiting_deposit", actor: "owner",
    event: "validated", cancelPending: true, notifications: [spec("apres", nb.id)], nowIso: T0 });
  expect(r!.status).toBe("awaiting_deposit");
  expect(await getHistory(env.DB, nb.id)).toHaveLength(1);
  expect((await listDueNotifications(env.DB, T0, 10)).map(n => n.dedupe_key)).toEqual(["apres"]);
});
it("une même clé de notification n'est enregistrée qu'une fois", async () => {
  await enqueue(env.DB, [spec("x"), spec("x")]);
  expect(await listDueNotifications(env.DB, T0, 10)).toHaveLength(1);
});
it("anonymise les refus et expirations anciens, pas les prestations", async () => {
  // refused et expired créés il y a 13 mois, confirmed de même : seuls les deux premiers perdent nom, e-mail, téléphone, lieu, message, ip_hash
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/repository.test.ts`. Expected : FAIL.

- [ ] **Step 3: Écrire `migrations/0001_init.sql`**

Le schéma de la spec, section 3, plus les index sur `bookings(hold_until)`, `bookings(client_email)`, `bookings(ip_hash)` et `notifications(due_at)`.

- [ ] **Step 4: Implémenter `worker/repository.ts`**

`insertBooking` : un `db.batch` qui insère la réservation et les notifications ; une erreur contenant `one_booking_per_day` donne `date_taken`, toute autre erreur est relancée. `applyTransition` : un seul `db.batch`, où le `UPDATE ... WHERE id = ? AND status = ?` fixe `updated_at = nowIso`, et où chaque instruction suivante porte `WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = ? AND updated_at = ?)`. Ainsi rien n'est écrit si l'état a changé. `cancelPending` remplit `cancelled_at` sur les notifications non envoyées de cette réservation. `listDueNotifications` exclut `sent_at`, `cancelled_at` et les lignes à 288 tentatives ou plus (24 h de reprises), triées par `due_at`.

- [ ] **Step 5: Vérifier**

Run : `npx vitest run test/worker/repository.test.ts`. Expected : PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: schéma D1 et accès aux données"
```

### Task 4: Planification des notifications et dépendances injectées

**Files:**
- Create: `worker/deps.ts`, `worker/notifications.ts`, `test/worker/notifications-plan.test.ts`
- Modify: `test/support.ts`

**Interfaces:**
- Produces, `worker/deps.ts` :
  - `EmailMessage = { to: string; subject: string; text: string; html: string }`, `EmailGateway = { send(m: EmailMessage): Promise<void> }`
  - `Button = { text: string; data?: string; url?: string }`, `TelegramGateway = { send(chatId: string, html: string, buttons?: Button[][]): Promise<void>; edit(chatId: string, messageId: number, html: string, buttons?: Button[][]): Promise<void>; answer(callbackId: string, text?: string): Promise<void> }`
  - `StripeSession = { id: string; url: string | null; status: "open" | "complete" | "expired"; paymentStatus: "paid" | "unpaid" | "no_payment_required"; expiresAt: number; bookingId: string | null }`
  - `StripeGateway = { createSession(a: { bookingId: string; token: string; email: string | null; amountCents: number; label: string; expiresAt: number }): Promise<StripeSession>; retrieveSession(id: string): Promise<StripeSession>; expireSession(id: string): Promise<void>; verifyWebhook(rawBody: string, signature: string): Promise<{ type: string; session: StripeSession | null }> }`
  - `Deps = { env: Env; now(): Date; stripe: StripeGateway; email: EmailGateway; telegram: TelegramGateway; verifyTurnstile(token: string, ip: string | null): Promise<"pass" | "fail" | "unavailable">; isOwner(ctx: ExecutionContext): boolean }`
  - `makeDeps(env: Env): Deps` : les passerelles réelles arrivent en tâches 7 et 9 ; d'ici là, leurs méthodes lèvent une erreur à l'appel, et non à la création
- Produces, `worker/notifications.ts` : `type PlanEvent = "requested" | "validated" | "refused" | "paid" | "manual_confirmed" | "released" | "cancelled"`, `plan(event: PlanEvent, b: Booking, now: Date): NotificationSpec[]`, `isRelevant(template: string, b: Booking | null): boolean`.
- Produces, `test/support.ts` : `fakeDeps(over?: Partial<Deps>)` qui renvoie `Deps` plus `emails: EmailMessage[]`, `telegrams: { chatId; html; buttons }[]`, `edits: { chatId; messageId; html; buttons }[]`, `answers: string[]`, `answerTexts: (string | undefined)[]`, `setNow(iso)`. Son `stripe` est une doublure en mémoire qui expose `sessions: Map<string, StripeSession>`, `completeSession(id)` et `failNext(method)`.

- [ ] **Step 1: Écrire les tests qui échouent**

Les modèles sont ceux de la spec, section 5. Clés : `b<id>:<modèle>[:<repère>]:<canal>`.

```ts
const keys = (s: NotificationSpec[]) => s.map(n => `${n.template}|${n.channel}|${n.due_at}`).sort();
it("nouvelle demande : alertes immédiates, deux rappels au propriétaire, accusé au client", () => {
  expect(keys(plan("requested", b, new Date(T0)))).toEqual([
    `client_received|email|${T0}`, `owner_new_request|email|${T0}`, `owner_new_request|telegram|${T0}`,
    "owner_review_reminder|telegram|2026-11-08T10:00:00.000Z", "owner_review_reminder|telegram|2026-11-09T10:00:00.000Z",
  ].sort());
});
it("validation : lien de paiement tout de suite, rappel 24 h avant l'échéance", () => {
  const v = { ...b, status: "awaiting_deposit", hold_until: "2026-11-10T10:00:00.000Z" };
  expect(keys(plan("validated", v, new Date(T0)))).toEqual([`client_deposit_link|email|${T0}`, "client_deposit_reminder|email|2026-11-09T10:00:00.000Z"].sort());
});
it("paiement : alerte, confirmation, puis J-7 et J-1 à 9 h de Paris", () => {
  const p = plan("paid", { ...b, event_date: "2026-12-19", status: "confirmed" }, new Date(T0));
  expect(keys(p)).toEqual(expect.arrayContaining([
    "owner_d7|telegram|2026-12-12T08:00:00.000Z", "owner_d7|email|2026-12-12T08:00:00.000Z",
    "owner_d1|telegram|2026-12-18T08:00:00.000Z", "owner_d1|email|2026-12-18T08:00:00.000Z",
    "client_d7|email|2026-12-12T08:00:00.000Z", `client_confirmed|email|${T0}`,
    `owner_deposit_paid|telegram|${T0}`, `owner_deposit_paid|email|${T0}`,
  ]));
});
it("ne crée pas un rappel dont l'heure est déjà passée", () => {
  const p = plan("paid", { ...b, event_date: "2026-11-10", status: "confirmed" }, new Date(T0));
  expect(p.map(n => n.template)).not.toContain("owner_d7");
  expect(p.map(n => n.template)).toContain("owner_d1");
});
it("sans e-mail client, seul le propriétaire est prévenu", () => {
  const p = plan("manual_confirmed", { ...b, client_email: null, status: "confirmed" }, new Date(T0));
  expect(p.every(n => n.recipient === "owner")).toBe(true);
});
it("la libération prévient les deux parties", () => {
  expect(plan("released", b, new Date(T0)).map(n => n.template).sort()).toEqual(["client_released", "owner_released", "owner_released"]);
});
it.each([
  ["owner_review_reminder", "pending_review", true], ["owner_review_reminder", "awaiting_deposit", false],
  ["client_deposit_reminder", "awaiting_deposit", true], ["client_deposit_reminder", "confirmed", false],
  ["owner_d7", "confirmed", true], ["owner_d1", "cancelled", false], ["client_d7", "cancelled", false],
])("%s en état %s : pertinent = %s", (t, status, e) => expect(isRelevant(t, { ...b, status })).toBe(e));
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/notifications-plan.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `plan`, `isRelevant`, `deps.ts` et `fakeDeps`**

`plan` est pure. `requested`, `validated`, `refused` et `cancelled` n'ajoutent rien pour le client sans e-mail. Une réservation `blocked` ne planifie rien.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/notifications-plan.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: planification des notifications et dépendances injectées"
```

### Task 5: API publique (disponibilités et demandes)

**Files:**
- Create: `worker/http.ts`, `worker/router.ts`, `worker/api.ts`, `worker/operations.ts`, `test/worker/api.test.ts`
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes : `checkDate`, `planById`, `insertBooking`, `findActiveByDateAndEmail`, `countActiveByEmail`, `countRecentByIp`, `listUnavailableDates`, `plan`, `Deps`.
- Produces :
  - `handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response>` (`worker/router.ts`)
  - `json(data, status?)`, `readJson(req, maxBytes)` (`worker/http.ts`), avec `Cache-Control: no-store` et `X-Robots-Tag: noindex` par défaut sur les réponses du Worker
  - `RequestInput = { date; plan; event_type; event_hours; venue; name; phone; email; message?; terms: boolean; turnstile_token }`
  - `createRequest(deps, input: unknown, ip: string | null): Promise<{ kind: "created" | "already_requested"; booking: Booking } | { kind: "date_taken" | "too_many" | "bot" } | { kind: "invalid"; fields: string[] }>` (`worker/operations.ts`)
- Réponses : `POST /api/requests` donne 201 `created`, 200 `already_requested`, 409 `date_taken`, 422 `invalid` avec `fields`, 429 `too_many`, 403 `bot`, 413 au-delà de 16 Ko. `GET /api/availability?from&to` donne `{ unavailable: string[], earliest: string, latest: string }`, 400 si les dates sont invalides ou séparées de plus de 400 jours, `Cache-Control: public, max-age=30`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
const body = (o = {}) => ({ date: "2026-12-19", plan: "formule-1", event_type: "Mariage", event_hours: "19 h - 1 h",
  venue: "Salle des fêtes", name: "Camille Durand", phone: "06 12 34 56 78", email: "camille@example.test", terms: true, turnstile_token: "t", ...o });
const post = (b: unknown, d = deps) => handle(new Request("https://brotobooth.fr/api/requests", { method: "POST", body: JSON.stringify(b),
  headers: { "CF-Connecting-IP": "203.0.113.5" } }), d, ctx);

it("enregistre la demande, tient la date 72 h et planifie les alertes", async () => {
  expect((await post(body())).status).toBe(201);
  const [b] = await listRange(env.DB, "2026-12-19", "2026-12-19");
  expect(b.status).toBe("pending_review");
  expect(b.hold_until).toBe("2026-11-10T10:00:00.000Z");
  expect(b.terms_version).toBe("2026-11-07");
  expect(b.price_cents).toBe(planById("formule-1")!.priceCents);
  expect(await listDueNotifications(env.DB, T0, 20)).not.toHaveLength(0);
});
it("répond date_taken si un autre client a pris la date", async () => {
  await post(body());
  const r = await post(body({ email: "autre@example.test" }));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "date_taken" });
});
it("traite un second envoi identique comme une réussite", async () => {  // Review Focus 1
  await post(body());
  const r = await post(body({ email: "CAMILLE@example.test " }));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "already_requested" });
  expect(await listRange(env.DB, "2026-12-19", "2026-12-19")).toHaveLength(1);
});
it("limite à 2 demandes actives par e-mail, sans tenir compte de la casse", async () => {
  await post(body({ date: "2026-12-19" })); await post(body({ date: "2026-12-20" }));
  expect((await post(body({ date: "2026-12-21", email: "Camille@Example.test" }))).status).toBe(429);
});
it("limite à 5 demandes par adresse IP sur 24 h", async () => { /* 5 e-mails et dates différents passent, le 6e donne 429 */ });
it.each([
  [{ date: "2026-11-10" }, "date"], [{ date: "2029-01-01" }, "date"], [{ plan: "inconnue" }, "plan"],
  [{ event_type: "Autre chose" }, "event_type"], [{ name: "" }, "name"], [{ name: "x".repeat(121) }, "name"],
  [{ venue: "x".repeat(301) }, "venue"], [{ phone: "abc" }, "phone"], [{ email: "pas-un-mail" }, "email"],
  [{ message: "x".repeat(2001) }, "message"], [{ terms: false }, "terms"],
])("refuse %j", async (over, field) => {
  const r = await post(body(over));
  expect(r.status).toBe(422);
  expect((await r.json()).fields).toContain(field);
});
it("refuse un robot", async () => {
  expect((await post(body(), fakeDeps({ verifyTurnstile: async () => "fail" }))).status).toBe(403);
});
it("accepte la demande si le service Turnstile est injoignable", async () => {
  expect((await post(body(), fakeDeps({ verifyTurnstile: async () => "unavailable" }))).status).toBe(201);
});
it("ne perd pas la demande si l'envoi immédiat échoue", async () => {
  const d = fakeDeps(); d.email.send = async () => { throw new Error("panne"); };
  expect((await post(body(), d)).status).toBe(201);
});
it("les disponibilités ne donnent que des dates", async () => {
  await post(body());
  const r = await handle(new Request("https://brotobooth.fr/api/availability?from=2026-12-01&to=2026-12-31"), deps, ctx);
  expect(await r.json()).toEqual({ unavailable: ["2026-12-19"], earliest: "2026-11-14", latest: "2028-11-07" });
});
it("conserve seulement une empreinte de l'adresse IP", async () => {
  await post(body());
  const [b] = await listRange(env.DB, "2026-12-19", "2026-12-19");
  expect(b.ip_hash).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/api.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `http.ts`, `router.ts`, `api.ts`, `createRequest`**

Ordre dans `createRequest` : valider les champs (e-mail en minuscules et sans espaces autour), Turnstile, doublon identique (`findActiveByDateAndEmail`), limites, insertion avec `plan("requested", ...)`. `token` et `id` via `crypto.randomUUID()` et `crypto.getRandomValues` (au moins 128 bits). `ip_hash` : SHA-256 de `IP_HASH_SALT + ip`. L'envoi immédiat des notifications sera branché en tâche 9. `worker/index.ts` appelle `handle(req, makeDeps(env), ctx)`.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/api.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: API des disponibilités et des demandes"
```

### Task 6: Opérations sur une réservation

**Files:**
- Modify: `worker/operations.ts`
- Test: `test/worker/operations.test.ts`

**Interfaces:**
- Consumes : `nextStatus`, `applyTransition`, `patchBooking`, `plan`, `depositCents`, `StripeGateway`.
- Produces, tous dans `worker/operations.ts`, avec `type Actor = "owner" | "system" | "stripe"` et `type OpResult = { ok: true; booking: Booking } | { ok: false; reason: "not_found" | "stale" | "date_taken" }` :
  - `validateBooking(deps, id, actor)`, `refuseBooking(deps, id, actor)`, `cancelBooking(deps, id, actor)`
  - `confirmDeposit(deps, id, actor)`, `expireHold(deps, b: Booking)`
  - `adjustPrice(deps, id, a: { priceCents: number; depositCents?: number })`
  - `resendPaymentLink(deps, id)`, `markBalancePaid(deps, id)`
  - `createManual(deps, a: { date; name; phone?; email?; eventType?; venue?; hours?; priceCents; depositCents; notes? })`, `blockDate(deps, date, notes?)`

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("valider fixe l'échéance à 72 h et prépare le lien de paiement", async () => {
  const r = await validateBooking(deps, b.id, "owner");
  expect(r.ok && r.booking.status).toBe("awaiting_deposit");
  expect(r.ok && r.booking.hold_until).toBe("2026-11-10T10:00:00.000Z");
  const due = await listDueNotifications(env.DB, T0, 20);
  expect(due.map(n => n.template)).toContain("client_deposit_link");
});
it("valider annule les rappels de validation", async () => { /* owner_review_reminder a cancelled_at rempli */ });
it("valider deux fois ne change rien la seconde fois", async () => {
  await validateBooking(deps, b.id, "owner");
  expect(await validateBooking(deps, b.id, "owner")).toEqual({ ok: false, reason: "stale" });
});
it("refuser libère la date", async () => {
  await refuseBooking(deps, b.id, "owner");
  expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual([]);
});
it("annuler une prestation confirmée annule ses rappels et prévient le client", async () => { /* owner_d7 annulé, client_cancelled dû */ });
it("confirmer l'acompte enregistre le paiement et supprime l'échéance", async () => {
  const v = await validate(); const r = await confirmDeposit(deps, v.id, "stripe");
  expect(r.ok && r.booking.status).toBe("confirmed");
  expect(r.ok && r.booking.hold_until).toBeNull();
  expect(r.ok && r.booking.deposit_paid_at).toBe(T0);
});
it("ajuster le prix recalcule l'acompte et ferme une session ouverte", async () => {
  const v = await validateWithOpenSession("cs_1");
  const r = await adjustPrice(deps, v.id, { priceCents: 150000 });
  expect(r.ok && r.booking.deposit_cents).toBe(45000);
  expect(r.ok && r.booking.stripe_session).toBeNull();
  expect(deps.stripe.sessions.get("cs_1")!.status).toBe("expired");
});
it("garde un acompte saisi à la main", async () => { /* depositCents: 20000 reste 20000 */ });
it("n'ajuste plus le prix après le paiement", async () => { /* confirmed : { ok: false, reason: "stale" } */ });
it("une réservation manuelle est confirmée sans délai minimum, et sans e-mail client", async () => {
  const r = await createManual(deps, { date: "2026-11-09", name: "Camille", priceCents: 50000, depositCents: 0 });
  expect(r.ok && r.booking.status).toBe("confirmed");
  expect(r.ok && r.booking.source).toBe("manual");
  expect((await listDueNotifications(env.DB, "2030-01-01T00:00:00Z", 20)).every(n => n.recipient === "owner")).toBe(true);
});
it("une réservation manuelle sur une date prise est refusée", async () => { /* date_taken */ });
it("bloquer puis retirer une date la libère", async () => { /* blockDate, cancelBooking, disponibilités vides */ });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/operations.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter les opérations**

Chaque transition lit la réservation, demande `nextStatus`, puis appelle `applyTransition` avec `cancelPending: true` et les notifications de `plan`. `nextStatus` à `null` ou `applyTransition` à `null` donnent `stale`. `resendPaymentLink` ajoute une notification `client_deposit_link` avec une clé horodatée, et ne prolonge pas l'échéance.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/operations.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: opérations sur les réservations"
```

### Task 7: Paiement de l'acompte, en simulation

**Files:**
- Create: `worker/simulated-payment.ts`, `worker/payments.ts`, `worker/html.ts`, `public/styles/tokens.css`, `test/worker/payments.test.ts`, `test/worker/simulated-payment.test.ts`
- Modify: `worker/router.ts`, `worker/deps.ts`, `worker/env.ts`

**Interfaces:**
- Consumes : `confirmDeposit`, `patchBooking`, `getBookingByToken`, `StripeGateway`.
- Produces :
  - `PAYMENT_MODE?: string` dans `Env`. `simulatedGateway(env: Env): StripeGateway` (`worker/simulated-payment.ts`), utilisée par `makeDeps` seulement si `PAYMENT_MODE === "simulated"`. Sans cette valeur, les méthodes de paiement continuent de lever une erreur à l'appel, jusqu'à la tâche 20
  - `GET` et `POST /acompte/<jeton>/simulation?session=<id>` : page de paiement factice, 404 hors du mode simulé
  - `escapeHtml(s: string): string`, `page(title: string, bodyHtml: string): string` (`worker/html.ts`), page sombre qui charge `/styles/tokens.css`, fichier repris des jetons de `templates/_theme.css`, sans `@font-face`
  - `paymentPage(req, deps, token): Promise<Response>`, `startPayment(req, deps, token): Promise<Response>`, `stripeWebhook(req, deps): Promise<Response>` (`worker/payments.ts`)

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
const open = (t: string, init?: RequestInit) => handle(new Request(`https://brotobooth.fr/acompte/${t}`, init), deps, ctx);

it("affiche le récapitulatif avec le montant de l'acompte", async () => {
  const html = await (await open(v.token)).text();
  expect(html).toContain("450,00 €");
  expect(html).toContain("19 décembre");
});
it("crée une session de 30 minutes et tient la date jusqu'à sa fin plus 5 minutes", async () => {
  deps.setNow("2026-11-10T09:50:00.000Z");  // 10 minutes avant l'échéance
  const r = await open(v.token, { method: "POST" });
  expect(r.status).toBe(303);
  const b = await getBooking(env.DB, v.id);
  expect(b!.stripe_session_expires).toBe("2026-11-10T10:20:00.000Z");
  expect(b!.hold_until).toBe("2026-11-10T10:25:00.000Z");
});
it("réutilise une session encore ouverte", async () => {  // Review Focus 4
  const a = await open(v.token, { method: "POST" }); const b = await open(v.token, { method: "POST" });
  expect(a.headers.get("location")).toBe(b.headers.get("location"));
  expect(deps.stripe.sessions.size).toBe(1);
});
it("le webhook confirme, et le rejouer ne change rien", async () => {
  const s = await start(); deps.stripe.completeSession(s);
  await hook(s); await hook(s);
  expect((await getBooking(env.DB, v.id))!.status).toBe("confirmed");
  expect((await getHistory(env.DB, v.id)).filter(h => h.event === "deposit_paid")).toHaveLength(1);
});
it("refuse un webhook mal signé", async () => { /* verifyWebhook lève : 400, rien ne change */ });
it("un paiement sur une réservation expirée n'écrase rien et alerte le propriétaire", async () => {
  await expireHold(deps, v); await hookFor(sessionOf(v));
  expect((await getBooking(env.DB, v.id))!.status).toBe("expired");
  expect((await listDueNotifications(env.DB, T0, 20)).map(n => n.template)).toContain("owner_late_payment");
});
it("le retour de Stripe confirme même si le webhook n'est pas encore arrivé", async () => {
  const s = await start(); deps.stripe.completeSession(s);
  const html = await (await open(`${v.token}?paid=1`)).text();
  expect((await getBooking(env.DB, v.id))!.status).toBe("confirmed");
  expect(html).toContain("date est confirmée");
});
it.each([   // Review Focus 4
  ["pending_review", "bientôt"], ["confirmed", "date est confirmée"], ["expired", "plus réservée"],
  ["cancelled", "annulée"], ["refused", "pas pu"],
])("en état %s, la page l'explique et ne propose pas de payer", async (status, text) => {
  const html = await (await open(withStatus(status).token)).text();
  expect(html).toContain(text);
  expect(html).not.toContain('method="post"');
});
it("un jeton inconnu donne une page 404 lisible", async () => { /* 404, contient le téléphone de contact */ });
it("si Stripe est indisponible, la date reste tenue et un message s'affiche", async () => {
  deps.stripe.failNext("createSession");
  const r = await open(v.token, { method: "POST" });
  expect(r.status).toBe(503);
  expect((await getBooking(env.DB, v.id))!.status).toBe("awaiting_deposit");
});
it("échappe le nom et le lieu", async () => {  // Review Focus 2
  const html = await (await open(withVenue('<img src=x onerror=alert(1)> & Co').token)).text();
  expect(html).toContain("&lt;img src=x");
  expect(html).not.toContain("<img src=x");
});
```

`test/worker/simulated-payment.test.ts`, avec `simulatedGateway(env)` et D1 :

```ts
it("le parcours complet fonctionne sans Stripe", async () => {
  // validée, POST /acompte/<jeton> : redirection vers /acompte/<jeton>/simulation?session=...
  // la page affiche clairement « Simulation » et « aucun paiement réel »
  // POST « paiement réussi » : réservation confirmed, redirection vers /acompte/<jeton>?paid=1
});
it("abandonner laisse la date tenue et le lien réutilisable", async () => { /* awaiting_deposit, nouvelle tentative possible */ });
it("retrieveSession et expireSession gardent leur état entre deux requêtes", async () => { /* état lu dans D1 : open, complete, expired */ });
it("expireSession lève une erreur sur une session déjà payée, comme Stripe", async () => {});
it("la page de simulation répond 404 si PAYMENT_MODE n'est pas simulated", async () => {});
it("une session d'une autre réservation est refusée", async () => { /* jeton A, session de B : 404, rien ne change */ });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/payments.test.ts test/worker/simulated-payment.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `simulated-payment.ts`, `html.ts`, `payments.ts`**

`simulated-payment.ts` respecte l'interface `StripeGateway`, garde l'état de chaque session dans `system_state` (clé `sim_session:<id>`) et se comporte comme Stripe, y compris l'erreur sur `expireSession` d'une session non ouverte. `verifyWebhook` y lève une erreur : la route `/api/stripe/webhook` existe et sa logique est testée avec la doublure de `fakeDeps`. Seul `checkout.session.completed` avec `paymentStatus: "paid"` déclenche une confirmation. `startPayment` n'agit qu'en `awaiting_deposit` et avant l'échéance : session ouverte réutilisée, sinon `expires_at = now + 30 min`, puis `hold_until = max(hold_until, expires + 5 min)`. Un paiement arrivé hors `awaiting_deposit` met en file `owner_late_payment` sur Telegram et par e-mail, avec une clé propre à la session. Brancher `simulatedGateway` dans `makeDeps`.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/payments.test.ts test/worker/simulated-payment.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: paiement de l'acompte, en simulation"
```

### Task 8: Tâche automatique

**Files:**
- Create: `worker/cron.ts`, `test/worker/cron.test.ts`
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes : `listDueHolds`, `expireHold`, `confirmDeposit`, `enqueue`, `anonymizeOld`, `setState`, `parisWeekday`, `parisHour`, `parisToday`, `parisInstant`.
- Produces : `runCron(deps: Deps): Promise<void>`, `releaseDueHolds(deps): Promise<void>`, `enqueueWeeklyDigest(deps): Promise<void>`. `processDue` s'y ajoute en tâche 9.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("libère une demande sans réponse après 72 h", async () => {
  const b = await request(); deps.setNow("2026-11-10T10:00:00.000Z");
  await releaseDueHolds(deps);
  expect((await getBooking(env.DB, b.id))!.status).toBe("expired");
  expect(await listUnavailableDates(env.DB, "2026-12-01", "2026-12-31")).toEqual([]);
});
it("ne libère pas avant l'échéance", async () => { /* 2026-11-10T09:59:00Z : toujours pending_review */ });
it("confirme au lieu de libérer si Stripe dit que c'est payé", async () => {
  const v = await validatedWithSession(); deps.stripe.completeSession(v.stripe_session!);
  deps.setNow(afterHold(v)); await releaseDueHolds(deps);
  expect((await getBooking(env.DB, v.id))!.status).toBe("confirmed");
});
it("expire une session encore ouverte avant de libérer", async () => {
  const v = await validatedWithSession(); deps.setNow(afterHold(v)); await releaseDueHolds(deps);
  expect(deps.stripe.sessions.get(v.stripe_session!)!.status).toBe("expired");
  expect((await getBooking(env.DB, v.id))!.status).toBe("expired");
});
it("si le client paie pendant la fermeture de sa session, il est confirmé", async () => {
  // expireSession lève, et retrieveSession indique alors payé : confirmed
});
it("si Stripe ne répond pas, la date reste tenue jusqu'au prochain passage, et les autres sont traitées", async () => {
  // deux réservations échues, Stripe en panne pour la première : la première reste awaiting_deposit, la seconde est libérée
});
it("prépare le point du lundi à partir de 9 h de Paris, une seule fois", async () => {
  deps.setNow("2026-11-09T07:59:00.000Z"); await enqueueWeeklyDigest(deps);
  expect(await digests()).toHaveLength(0);
  deps.setNow("2026-11-09T08:00:00.000Z"); await enqueueWeeklyDigest(deps); await enqueueWeeklyDigest(deps);
  expect((await digests()).map(n => n.channel).sort()).toEqual(["email", "telegram"]);
});
it("runCron écrit son dernier passage, même si une étape échoue", async () => {
  deps.stripe.failNext("retrieveSession"); await runCron(deps);
  expect(await getState(env.DB, "last_cron_run")).toBe(T0);
});
it("anonymise les refus et expirations de plus de 12 mois", async () => { /* via runCron */ });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/cron.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `cron.ts`**

Chaque étape et chaque réservation s'exécutent dans leur propre `try/catch`, et l'erreur est journalisée sans donnée personnelle (identifiant seulement). `worker/index.ts` : `scheduled(_, env, ctx) { ctx.waitUntil(runCron(makeDeps(env))); }`.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/cron.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: tâche automatique de libération et point du lundi"
```

### Task 9: Envoi des messages

**Files:**
- Create: `worker/templates.ts`, `worker/email.ts`, `worker/telegram.ts`, `test/worker/delivery.test.ts`, `test/worker/templates.test.ts`
- Modify: `worker/notifications.ts`, `worker/cron.ts`, `worker/api.ts`, `worker/deps.ts`

**Interfaces:**
- Consumes : `listDueNotifications`, `markSent`, `markFailed`, `enqueue`, `isRelevant`, `escapeHtml`, `listUpcoming`.
- Produces :
  - `processDue(deps: Deps, limit?: number): Promise<{ sent: number; failed: number }>` (`worker/notifications.ts`)
  - `renderEmail(template: string, b: Booking | null, ctx: { baseUrl: string; upcoming?: Booking[] }): { subject: string; text: string; html: string }`, `renderTelegram(template, b, ctx): { html: string; buttons?: Button[][] }` (`worker/templates.ts`)
  - `resendGateway(env, fetchFn?): EmailGateway` (`worker/email.ts`), `telegramGateway(env, fetchFn?): TelegramGateway` et `chatIds(env): string[]` (`worker/telegram.ts`), `verifyTurnstile` réel dans `worker/deps.ts`

**Messages au client** (écrits pour lui, sans vocabulaire interne) :

| Modèle | Objet | Contenu |
|---|---|---|
| `client_received` | Votre demande pour le {date} | Nous gardons la date et répondons sous 72 h. Rien à payer pour l'instant |
| `client_refused` | Votre demande pour le {date} | Nous ne pouvons pas assurer cette date, avec nos excuses, et comment nous joindre |
| `client_deposit_link` | Votre acompte pour le {date} | Montant de l'acompte, lien `/acompte/<jeton>`, date limite. La date est confirmée au paiement |
| `client_deposit_reminder` | Plus que 24 h pour votre acompte | Rappel, lien, date limite |
| `client_confirmed` | C'est confirmé pour le {date} | Récapitulatif, formule, solde restant, contact |
| `client_released` | Votre demande pour le {date} | Le délai est passé, la date n'est plus réservée, comment refaire une demande |
| `client_cancelled` | Votre réservation du {date} | Annulation, et comment nous joindre |
| `client_d7` | Votre photobooth arrive dans une semaine | Récapitulatif, lieu, horaires, solde restant, contact |

**Messages au propriétaire :** `owner_new_request` (date, type, formule, lieu, client, téléphone ; boutons Telegram `Valider` avec `v:<id>`, `Refuser` avec `r:<id>`, `Ajuster le prix` vers `<BASE_URL>/admin#<id>`), `owner_review_reminder`, `owner_deposit_paid`, `owner_released`, `owner_d7` et `owner_d1` (lieu, horaires, téléphone, solde restant), `owner_digest` (toutes les prestations à venir, avec statut), `owner_late_payment`, `owner_email_failed`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("envoie une notification due une seule fois", async () => {
  await enqueue(env.DB, [mail("client_received")]);
  await processDue(deps); await processDue(deps);
  expect(deps.emails).toHaveLength(1);
});
it("n'envoie pas avant l'heure ni après annulation", async () => { /* due_at futur et cancelled_at rempli : 0 envoi */ });
it("saute un rappel devenu inutile sans échec", async () => {
  // owner_d7 sur une réservation cancelled : sent 0, failed 0, marqué annulé
});
it("reprend un envoi après un échec", async () => {
  const d = fakeDeps(); let fail = true;
  d.email.send = async m => { if (fail) { fail = false; throw new Error("panne"); } d.emails.push(m); };
  await enqueue(env.DB, [mail("client_received")]);
  expect(await processDue(d)).toEqual({ sent: 0, failed: 1 });
  expect(await processDue(d)).toEqual({ sent: 1, failed: 0 });
});
it("alerte le propriétaire après 3 échecs d'envoi au client", async () => {
  // e-mail toujours en panne, 3 passages : owner_email_failed sur telegram, une seule fois
});
it("bascule sur e-mail quand Telegram échoue", async () => {
  // telegram en panne : au premier échec, le même modèle est mis en file par e-mail, clé <clé>:fallback, et l'e-mail part
});
it("envoie à chaque chat configuré", async () => { /* TELEGRAM_CHAT_IDS="1,2" : deux envois */ });
it("une panne d'envoi n'empêche pas les notifications suivantes", async () => { /* première en échec, seconde envoyée */ });
it("le point du lundi liste les prestations à venir", async () => { /* renderTelegram("owner_digest") contient chaque date confirmée */ });
```

```ts
// test/worker/templates.test.ts
const hostile = { client_name: 'A<b>&"C', venue: "Salle, n°3; étage\n2 🎉", message: "<script>x</script>" };
it.each(ALL_TEMPLATES)("%s échappe les champs libres", t => {   // Review Focus 2
  const tg = renderTelegram(t, booking(hostile), ctx).html;
  expect(tg).not.toContain("<script>"); expect(tg).not.toMatch(/<b>&/);
  const m = renderEmail(t, booking(hostile), ctx);
  expect(m.html).not.toContain("<script>");
  expect(m.subject).not.toMatch(/[\r\n]/);
});
it.each(CLIENT_TEMPLATES)("%s ne contient aucun vocabulaire interne", t => {
  const { text, subject } = renderEmail(t, booking(), ctx);
  expect(subject + text).not.toMatch(/bloqu|valid|statut|pending|awaiting|hold/i);
});
it("le lien de paiement contient le jeton, jamais l'identifiant", () => {
  expect(renderEmail("client_deposit_link", booking(), ctx).text).toContain(`https://brotobooth.fr/acompte/${booking().token}`);
});
it("l'alerte de demande porte les trois boutons", () => {
  expect(renderTelegram("owner_new_request", booking(), ctx).buttons!.flat().map(b => b.text)).toEqual(["Valider", "Refuser", "Ajuster le prix"]);
});
it("formate les dates et les montants en français", () => {
  expect(renderEmail("client_confirmed", booking({ event_date: "2026-12-19", price_cents: 150000 }), ctx).text)
    .toMatch(/samedi 19 décembre[\s\S]*1\s?500,00\s?€/);
});
```

Avec un `fetchFn` factice : `resendGateway` envoie vers `https://api.resend.com/emails` et lève sur une réponse non 2xx ; `telegramGateway` appelle `sendMessage` avec `parse_mode: "HTML"` et un `inline_keyboard`, et lève sur une réponse non 2xx ; `verifyTurnstile` donne `pass` ou `fail` selon `success`, et `unavailable` si `fetch` lève ou répond en 5xx.

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/delivery.test.ts test/worker/templates.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `templates.ts`, `email.ts`, `telegram.ts`, `processDue`**

Dans `processDue`, chaque notification a son `try/catch`, et le corps est rendu juste avant l'envoi à partir de la réservation à jour. Après `markFailed`, si `attempts` atteint 3 pour un e-mail client, enqueue `owner_email_failed` (clé `<clé>:alert`). Pour un échec Telegram, enqueue le même modèle en e-mail (clé `<clé>:fallback`).

Brancher : `processDue` dans `runCron` et, après une demande réussie, via `ctx.waitUntil(processDue(deps).catch(...))` ; les passerelles réelles dans `makeDeps` ; `FAKE_GATEWAYS === "1"` y donne des passerelles qui répondent `pass` et gardent les 50 derniers messages (destinataire, objet, texte, boutons) dans `system_state`, clé `demo_messages`. `GET /demo` les affiche, liens cliquables, pour lire ce qui aurait été envoyé, et répond 404 sans cette variable (à tester, avec l'échappement des messages). Cette variable n'apparaît jamais dans `wrangler.jsonc`.

- [ ] **Step 4: Vérifier**

Run : `npm test`. Expected : tout passe, y compris « ne perd pas la demande si l'envoi immédiat échoue ».

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: envoi des e-mails et messages Telegram"
```

### Task 10: Bot Telegram

**Files:**
- Modify: `worker/telegram.ts`, `worker/router.ts`
- Create: `scripts/set-telegram-webhook.mjs`
- Test: `test/worker/telegram.test.ts`

**Interfaces:**
- Consumes : `validateBooking`, `refuseBooking`, `getBooking`, `chatIds`.
- Produces : `telegramWebhook(req: Request, deps: Deps): Promise<Response>`. Boutons : `v:<id>` valider, `r:<id>` demander confirmation du refus, `rc:<id>` refuser, `x:<id>` renoncer. Réponse 200 même sur une action ignorée, pour que Telegram ne réessaie pas.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
const tap = (data: string, chat = 111, secret = "s") => telegramWebhook(new Request("https://brotobooth.fr/api/telegram/webhook", {
  method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
  body: JSON.stringify({ update_id: 1, callback_query: { id: "cb", data, message: { message_id: 9, chat: { id: chat } } } }) }), deps);

it("Valider envoie le lien au client et met à jour le message", async () => {
  await tap(`v:${b.id}`);
  expect((await getBooking(env.DB, b.id))!.status).toBe("awaiting_deposit");
  expect(deps.answers).toHaveLength(1);
  expect(deps.edits.at(-1)!.html).toContain("Validée");
});
it("Refuser demande d'abord confirmation et ne change rien", async () => {
  await tap(`r:${b.id}`);
  expect((await getBooking(env.DB, b.id))!.status).toBe("pending_review");
  expect(deps.edits.at(-1)!.buttons!.flat().map(x => x.data)).toEqual([`rc:${b.id}`, `x:${b.id}`]);
});
it("confirmer le refus libère la date", async () => { /* rc : refused, et la date est libre */ });
it("Renoncer remet les boutons d'origine", async () => { /* x : pending_review, et le message reprend les trois boutons */ });
it("toucher Valider deux fois n'envoie rien de plus", async () => {   // Review Focus 3
  await tap(`v:${b.id}`); const before = await pending(); await tap(`v:${b.id}`);
  expect(await pending()).toEqual(before);
  expect(deps.answerTexts.at(-1)).toMatch(/déjà traitée/i);
});
it("toucher Valider après l'expiration ne ressuscite pas la demande", async () => {   // Review Focus 3
  await expireHold(deps, b); await tap(`v:${b.id}`);
  expect((await getBooking(env.DB, b.id))!.status).toBe("expired");
  expect(deps.answerTexts.at(-1)).toMatch(/plus disponible|déjà traitée/i);
});
it("ignore un chat non autorisé", async () => {
  await tap(`v:${b.id}`, 999);
  expect((await getBooking(env.DB, b.id))!.status).toBe("pending_review");
});
it("rejette un mauvais secret", async () => {
  expect((await tap(`v:${b.id}`, 111, "faux")).status).toBe(401);
});
it("ignore une donnée inconnue et un identifiant inconnu sans erreur", async () => {
  expect((await tap("nimporte")).status).toBe(200); expect((await tap("v:inconnu")).status).toBe(200);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/telegram.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `telegramWebhook` et le script**

Comparer le secret en temps constant. Toujours appeler `answer`. `scripts/set-telegram-webhook.mjs` appelle `setWebhook` avec `url`, `secret_token` et `allowed_updates: ["callback_query"]`, en lisant le jeton et le secret dans l'environnement.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/telegram.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: boutons du bot Telegram"
```

### Task 11: Flux d'agenda

**Files:**
- Create: `worker/calendar.ts`, `test/worker/calendar.test.ts`
- Modify: `worker/router.ts`

**Interfaces:**
- Consumes : `listUpcoming`, `parisToday`.
- Produces : `renderCalendar(bookings: Booking[], now: Date): string`, `calendarFeed(deps, token: string): Promise<Response>`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("donne un événement sur la journée par prestation confirmée et par demande à valider", () => {
  const ics = renderCalendar([confirmed("2026-12-19"), pending("2027-01-09")], new Date(T0));
  expect(ics).toContain("DTSTART;VALUE=DATE:20261219");
  expect(ics).toContain("DTEND;VALUE=DATE:20261220");
  expect(ics).toMatch(/SUMMARY:Prestation/);
  expect(ics).toMatch(/SUMMARY:À valider/);
  expect(ics).toContain("BEGIN:VALARM");
  expect(ics.split("\r\n").length).toBeGreaterThan(5);
});
it("échappe les champs libres", () => {   // Review Focus 2
  const ics = renderCalendar([confirmed("2026-12-19", { venue: "Salle, n°3; étage\n2" })], new Date(T0));
  expect(ics).toContain("Salle\\, n°3\\; étage\\n2");
});
it("replie les lignes à 75 octets sans couper un caractère", () => {
  const lines = renderCalendar([confirmed("2026-12-19", { venue: "é".repeat(200) })], new Date(T0)).split("\r\n");
  const enc = new TextEncoder();
  expect(lines.every(l => enc.encode(l).length <= 75)).toBe(true);
  expect(new TextDecoder().decode(enc.encode(lines.join("\r\n")))).not.toContain("�");
});
it("garde le même identifiant d'événement d'une lecture à l'autre", () => { /* UID:<id>@brotobooth.fr */ });
it("exclut les états libérés et les dates passées", () => { /* via la route : ni expired, ni cancelled, ni hier */ });
it("n'inclut pas les dates bloquées sans nom", () => { /* blocked : SUMMARY:Date bloquée */ });
it("répond 404 à un mauvais jeton", async () => { /* /agenda/faux.ics : 404, sans détail */ });
it("sert le bon type de contenu", async () => { /* text/calendar; charset=utf-8, no-store, noindex */ });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/calendar.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `calendar.ts`**

Fins de ligne CRLF, `VALARM` à 1 jour avant, statuts `pending_review`, `awaiting_deposit`, `confirmed` et `blocked` à partir d'aujourd'hui à Paris. Comparaison du jeton en temps constant.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/calendar.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: flux d'agenda privé"
```

### Task 12: API d'administration

**Files:**
- Create: `worker/admin.ts`, `test/worker/admin.test.ts`
- Modify: `worker/router.ts`, `worker/deps.ts`

**Interfaces:**
- Consumes : toutes les opérations de la tâche 6, `listTodo`, `listRange`, `getHistory`, `getState`, `listFailedNotifications`.
- Produces : `adminApi(req, deps, ctx, path: string): Promise<Response>`. `isOwner` réel : `ctx.access?.aud === env.ACCESS_AUD`.

| Route | Effet |
|---|---|
| `GET /api/admin/overview` | `{ todo: Booking[], health: { lastCronRun: string \| null, failedNotifications: number } }` |
| `GET /api/admin/bookings?from&to` | Réservations de la période |
| `GET /api/admin/bookings/:id` | `{ booking, history }` |
| `POST /api/admin/bookings` | `{ kind: "manual", ... }` ou `{ kind: "blocked", date, notes? }` ; 409 si la date est prise |
| `POST /api/admin/bookings/:id/:action` | `validate`, `refuse`, `cancel`, `resend-link`, `balance-paid` ; 409 si `stale` |
| `PATCH /api/admin/bookings/:id` | `{ price_cents?, deposit_cents?, notes? }` |

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("répond 403 sans authentification Access", async () => {
  const d = fakeDeps({ isOwner: () => false });
  expect((await api("GET", "/api/admin/overview", undefined, d)).status).toBe(403);
});
it("isOwner exige le bon public", () => {
  const d = makeDeps({ ...env, ACCESS_AUD: "aud" });
  expect(d.isOwner({ access: { aud: "aud" } } as any)).toBe(true);
  expect(d.isOwner({ access: { aud: "autre" } } as any)).toBe(false);
  expect(d.isOwner({} as any)).toBe(false);
});
it("refuse une modification venant d'une autre origine", async () => {
  expect((await api("POST", `/api/admin/bookings/${b.id}/refuse`, {}, deps, "https://ailleurs.test")).status).toBe(403);
});
it("À traiter liste les demandes et les acomptes attendus, par échéance", async () => { /* confirmed absent ; hold_until croissant */ });
it("la santé donne le dernier passage et les envois en échec", async () => { /* attempts >= 3 comptés */ });
it("valide, refuse, annule et marque le solde", async () => { /* statut et balance_paid_at attendus */ });
it("répond 409 sur une action périmée", async () => { /* valider deux fois */ });
it("ajoute une réservation manuelle, et répond 409 si la date est prise", async () => {});
it("bloque une date", async () => { /* disponibilités : date présente */ });
it("rejette un prix négatif ou non entier", async () => { /* 422 */ });
it("donne l'historique de chaque changement", async () => { /* validated, puis deposit_paid, avec auteur et date */ });
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/admin.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `admin.ts`**

Pour tout `POST` et `PATCH`, `Origin` doit égaler `BASE_URL`, et `Content-Type` être `application/json`.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/admin.test.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: API d'administration"
```

### Task 13: Interface d'administration

**Files:**
- Create: `src/pages/admin.astro`, `src/scripts/admin.ts`, `src/styles/admin.css`, `playwright.config.ts`, `e2e/admin.spec.ts`, `e2e/seed.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes : routes de la tâche 12, `public/styles/tokens.css`.
- Produces : `playwright.config.ts` (projets Chromium et WebKit, tailles 375×812 et 1280×800), lançant `npm run dev:e2e` sur le port 8788 ; `dev:e2e` = `rm -rf .wrangler/e2e && astro build && wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e && wrangler dev --port 8788 --persist-to .wrangler/e2e --var FAKE_GATEWAYS:1 --var PAYMENT_MODE:simulated --var ACCESS_AUD:local-dev --var BASE_URL:http://localhost:8788`, avec `workers: 1`. `seed(request, kind)` dans `e2e/seed.ts` crée des réservations par l'API, chacune sur une date libre calculée à partir d'aujourd'hui, et `freeDate()` donne une date libre à au moins 30 jours.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("traiter une demande depuis le téléphone", async ({ page }) => {
  await seed("pending");
  await page.goto("/admin");
  await page.getByRole("button", { name: /Camille/ }).click();
  await expect(page.getByRole("link", { name: /06 12 34 56 78/ })).toHaveAttribute("href", /^tel:/);
  await page.getByRole("button", { name: "Valider" }).click();
  await expect(page.getByText("Attente d'acompte")).toBeVisible();
});
test("refuser demande une confirmation", async ({ page }) => { /* un dialogue s'ouvre, Annuler ne change rien */ });
test("ajuster le prix recalcule l'acompte", async ({ page }) => {});
test("le calendrier montre chaque état", async ({ page }) => { /* une date par état, couleur et libellé */ });
test("ajouter une réservation et bloquer une date", async ({ page }) => {});
test("la santé affiche le dernier passage", async ({ page }) => {});
test("aucun débordement horizontal à 375 px", async ({ page }) => {
  await page.goto("/admin");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx playwright install chromium webkit && npx playwright test e2e/admin.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter la page**

Page statique sans donnée, tout passe par `fetch` vers l'API. Trois zones : À traiter, Calendrier, Santé. La fiche s'ouvre en panneau, et `#<id>` dans l'adresse l'ouvre directement pour le bouton « Ajuster le prix ». Rose pour l'action principale seulement. Si l'API répond 403, afficher « Connexion requise ».

- [ ] **Step 4: Vérifier**

Run : `npx playwright test e2e/admin.spec.ts`. Expected : PASS sur les deux navigateurs.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: interface d'administration"
```

### Task 14: Identité et médias du site

**Files:**
- Create: `scripts/build-fonts.sh`, `scripts/build-media.sh`, `scripts/build-logo-parts.mjs`, `src/generated/logo-parts.json`, `public/fonts/*.woff2`, `public/media/*`, `src/styles/fonts.css`, `src/layouts/Base.astro`, `test/worker/logo-parts.test.ts`
- Modify: `src/pages/admin.astro` (passe sur `Base.astro`)

**Interfaces:**
- Produces : `src/generated/logo-parts.json` avec `{ broto, left, rose, orange, right: string; tip: [number, number] }` ; `Base.astro` avec `title`, `description`, et `noindex?: boolean`, chargeant `/styles/tokens.css` et `fonts.css`.
- Produces, médias de `public/media/` (WebP sauf mention) : `tirage-1` à `tirage-8`, `ecran-pose`, `ecran-3photos`, `ecran-format`, `gros-tirages`, `gros-combine`, `borne-boucle.mp4`, `borne-boucle-poster`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import parts from "../../src/generated/logo-parts.json";
it("sépare le logo en cinq morceaux et situe la fente", () => {
  for (const k of ["broto", "left", "right", "rose", "orange"]) expect(parts[k]).toMatch(/^M/);
  expect(parts.tip[0]).toBeCloseTo(1659, 0);
  expect(parts.tip[1]).toBe(917);
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

Run : `npx vitest run test/worker/logo-parts.test.ts`. Expected : FAIL.

- [ ] **Step 3: Écrire et lancer les trois scripts**

- `build-logo-parts.mjs` lit `logo-blanc.svg` et découpe le tracé blanc par sous-chemin : `y` minimal négatif pour `broto`, sinon `x` minimal sous 1000 pour `left`, le reste pour `right`. Le rose et l'orange sont repris tels quels. `tip` : axe de la fente à `y = 917`, calculé sur les bords droits de coupe à 24°. Fichier de sortie versionné.
- `build-fonts.sh` : `python3 -m fontTools.ttLib.woff2 compress` pour Unbounded 700 et 800, Outfit 400 et 600.
- `build-media.sh` (source : `/home/sw0och/Spot_pub_Brotobooth`, ffmpeg, WebP qualité 78) :

| Sortie | Source | Instant | Largeur |
|---|---|---|---|
| `tirage-1` | `spot_reseau_brotobooth.mp4`, recadré `1408:1054:132:12` | 300 s | 1000 |
| `tirage-2` à `tirage-8` | `GX011237` 1,2 s ; `GX011244` 2,8 s ; `GX011249` 2,7 s ; `GX011249` 10,7 s ; `GX011245` 6,8 s ; `GX011250` 1,5 s ; `GX011241` 2,2 s, recadrés `2880:2160:480:0` | | 1000 |
| `ecran-pose`, `ecran-3photos`, `ecran-format` | `spot_reseau_brotobooth.mp4` | 250 s, 260 s, 275 s | 1400 |
| `gros-tirages`, `gros-combine` | `GX011244` 2,8 s ; `GX011249` 10,7 s | | 1500 |
| `borne-boucle.mp4` | `GX011249`, de 9 à 15,5 s, ralenti 1,5×, aller-retour, sans son, H.264, `faststart` | | 960 |
| `borne-boucle-poster` | Première image de la boucle | | 1280 |

- [ ] **Step 4: Vérifier le contenu et le poids**

Run : `npx vitest run test/worker/logo-parts.test.ts && du -k public/media/borne-boucle.mp4`. Expected : PASS, 3072 Ko au plus. Si la vidéo pèse plus, monter le CRF jusqu'à passer sous cette limite. Regarder aussi `ecran-pose` pour vérifier qu'on y voit bien le compte à rebours, `ecran-3photos` les trois photos et `ecran-format` le choix du format.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: polices, logo découpé et médias du site"
```

### Task 15: Page d'accueil

**Files:**
- Modify: `src/pages/index.astro` (remplace le provisoire)
- Create: `src/components/TopBar.astro`, `Hero.astro`, `GuestSteps.astro`, `Handset.astro`, `Plans.astro`, `Founders.astro`, `FinalCta.astro`, `Footer.astro`, `src/styles/site.css`, `src/pages/404.astro`, `e2e/home.spec.ts`

**Interfaces:**
- Consumes : `Base.astro`, `config/offer.json`, médias de la tâche 14.
- Produces : la barre (`TopBar`, avec `variant: "home" | "reserve"`), `Footer`, et les ancres `#borne` et `#formules`. `Hero` porte `id="hero"` et contient `#wall`, pour la tâche 16. Le bouton rose utilise la classe `.btn`.

Les textes sont ceux de `docs/superpowers/specs/2026-11-07-maquette-site.html` : section par section, reprendre la mise en page et le texte exacts. Formules et contacts viennent de `config/offer.json`, jamais écrits en dur.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("la page raconte les sections dans l'ordre, sans JavaScript", async ({ browser }) => {
  const page = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Réservez votre photobooth");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Ce que vivent vos invités", "Un combiné sur le côté ?", "Les formules", "Une date en tête ?"]);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
});
test("le menu mène aux trois destinations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation").getByRole("link")).toHaveText(["La borne", "Formules", "Réserver"]);
  await expect(page.getByRole("link", { name: "Réserver" })).toHaveAttribute("href", "/reserver");
});
test("les formules viennent de la configuration et mènent à la réservation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Choisir" }).first()).toHaveAttribute("href", "/reserver?formule=formule-1");
});
test("au plus un bouton rose par écran", async ({ page }) => {
  // à chaque section, compter les éléments .btn visibles dans la fenêtre : 1 au plus
});
test("aucune couleur de marque dans le texte", async ({ page }) => {
  // parcourir h1, h2, h3, p, a, span : color différent de rgb(242, 85, 155) et rgb(255, 138, 61)
});
test("aucun débordement horizontal à 375 px, et cibles de 44 px", async ({ page }) => {});
test("une page 404 ramène à l'accueil", async ({ page }) => {});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx playwright test e2e/home.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter la page et ses composants**

Porter le CSS de la maquette, responsive, avec `srcset` sur les images et `loading="lazy"` hors de l'ouverture. Logo de barre : SVG en ligne, plat, depuis `logo-blanc.svg`. Texte de présentation : celui de la maquette, à confirmer selon la spec, section 13.

- [ ] **Step 4: Vérifier**

Run : `npx playwright test e2e/home.spec.ts`. Expected : PASS sur les deux navigateurs et les deux tailles.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: page d'accueil"
```

### Task 16: Animations

**Files:**
- Create: `public/scripts/early.js`, `src/scripts/intro-timeline.ts`, `src/scripts/logo-intro.ts`, `src/scripts/photo-wall.ts`, `src/scripts/toss.ts`, `test/worker/intro-timeline.test.ts`, `e2e/motion.spec.ts`
- Modify: `src/pages/index.astro`, `src/layouts/Base.astro`, `src/styles/site.css`

**Interfaces:**
- Produces : `introFrame(t: number): { opening; travel; relief; opacity; burstOuter; burstOpacity; reveal }` (`intro-timeline.ts`, fonction pure) ; `startIntro(): void`, `startWall(): void`, `initToss(): void`.
- `early.js`, chargé de façon bloquante dans le `<head>` : ajoute `js` sur `<html>`, puis `intro` si l'animation doit jouer, c'est-à-dire ni vue dans cette visite (`sessionStorage`, accès protégé par `try/catch`), ni réduction des animations. Le CSS ne cache `.reveal` que sous `html.intro`.

Porter `intro`, `draw`, le mur et l'arrivée des images depuis la maquette. Les constantes y sont exactes : elles reprennent `ui/widgets/BrandLogo.py` et `ui/widgets/PhotoWall.py`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// test/worker/intro-timeline.test.ts : minutage de BrandLogo.py
it.each([
  [0, 300, 0], [0.3, 300, 0], [0.8, 0, 0], [0.875, 20, 0], [0.95, 0, 0], [1.4, 0, 0], [2, 0, 1],
])("à %s s : ouverture %s, trajet %s", (t, opening, travel) => {
  const f = introFrame(t);
  expect(f.opening).toBeCloseTo(opening, 5);
  expect(f.travel).toBeCloseTo(travel, 5);
});
it("les traits apparaissent à l'impact et s'effacent à 1,3 s", () => {
  expect(introFrame(0.79).burstOpacity).toBe(0);
  expect(introFrame(1.05).burstOpacity).toBe(1);
  expect(introFrame(1.3).burstOpacity).toBe(0);
});
it("le contenu apparaît de 1,6 à 2 s", () => {
  expect(introFrame(1.6).reveal).toBe(0);
  expect(introFrame(2).reveal).toBe(1);
});
```

```ts
// e2e/motion.spec.ts
test("l'ouverture se termine dans l'en-tête et révèle le contenu", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(2300);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  await expect(page.locator(".print")).not.toHaveCount(0);
});
test("un toucher termine l'ouverture aussitôt", async ({ page }) => {
  await page.goto("/"); await page.mouse.click(10, 10);
  await expect(page.locator("#logo-intro")).toHaveCount(0);
});
test("l'ouverture ne rejoue pas dans la même visite", async ({ page }) => {
  await page.goto("/"); await page.waitForTimeout(2300); await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
});
test("avec réduction des animations : pas d'ouverture, mur immobile, contenu visible", async ({ browser }) => {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await page.goto("/");
  await expect(page.locator("#logo-intro")).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});
test("si le stockage de session est interdit, la page fonctionne", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "sessionStorage", { get() { throw new Error("interdit"); } }));
  await page.goto("/"); await page.waitForTimeout(2300);
  await expect(page.getByRole("link", { name: "Choisir une date" }).first()).toBeVisible();
});
test("le mur compte 9 tirages sur ordinateur, 8 sur téléphone, sans débordement", async ({ page }) => {});
test("les images de section arrivent une fois et finissent à leur place", async ({ page }) => {});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/intro-timeline.test.ts && npx playwright test e2e/motion.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter les animations**

Une seule surcouche `#logo-intro`, retirée du DOM à la fin : elle atterrit exactement sur le logo de la barre (position mesurée par `getBoundingClientRect`), qui prend alors le relais. Le mur s'arrête quand `#hero` sort de l'écran et que la page passe en arrière-plan.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/intro-timeline.test.ts && npx playwright test e2e/motion.spec.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: animation du logo, mur de tirages et arrivée des images"
```

### Task 17: Page de réservation

**Files:**
- Create: `src/pages/reserver.astro`, `src/scripts/reservation.ts`, `src/scripts/calendar-grid.ts`, `src/styles/reserver.css`, `test/worker/calendar-grid.test.ts`, `e2e/reservation.spec.ts`

**Interfaces:**
- Consumes : `GET /api/availability`, `POST /api/requests`, `TopBar` en variante `reserve`, `config/offer.json`.
- Produces : `monthCells(year: number, month: number): (string | null)[]` (semaine commençant lundi), `dayState(date, availability): "free" | "taken" | "out"` (`calendar-grid.ts`).
- Variable de génération : `PUBLIC_TURNSTILE_SITE_KEY`. Si elle est vide, le script Turnstile n'est pas chargé (tests de bout en bout).

- [ ] **Step 1: Écrire les tests qui échouent**

`calendar-grid.test.ts` : novembre 2026 commence par 6 cases vides (le 1er est un dimanche) ; `dayState` renvoie `taken` pour une date indisponible et `out` avant `earliest` et après `latest`.

```ts
test("le parcours complet", async ({ page }) => {
  await page.goto("/reserver");
  const day = await pickFreeDate(page);  // e2e/seed.ts : avance d'un mois si besoin, puis clique une date libre
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.getByRole("button", { name: /Formule 1/ }).click();
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.getByLabel("Nom").fill("Camille Durand");
  /* ... lieu, horaires, téléphone, e-mail, CGV ... */
  await page.getByRole("button", { name: "Envoyer ma demande" }).click();
  await expect(page.getByRole("heading", { name: "Demande envoyée" })).toBeVisible();
  await expect(page.getByText(/répondons sous 72 h/)).toBeVisible();
});
test("une formule présélectionnée passe directement aux coordonnées après la date", async ({ page }) => { /* ?formule=formule-2 */ });
test("une date prise est barrée et inactive", async ({ page }) => {});
test("les dates trop proches sont inactives", async ({ page }) => {});
test("si la date vient d'être prise, le client le voit et revient au calendrier à jour", async ({ page }) => {
  // intercepter POST : 409, puis message « Cette date vient d'être prise » et date barrée
});
test("une coupure réseau garde la saisie et donne le contact", async ({ page }) => {   // Review Focus 5
  // abort POST /api/requests : champs toujours remplis, téléphone et e-mail visibles, nouvel envoi possible
});
test("une erreur de champ se voit à côté du champ", async ({ page }) => { /* 422 fields:["phone"] : message près du téléphone, focus déplacé */ });
test("si les disponibilités ne répondent pas, le contact remplace le calendrier", async ({ page }) => {});
test("un double clic n'envoie qu'une demande", async ({ page }) => { /* bouton désactivé pendant l'envoi */ });
test("la vidéo tourne derrière la carte, sans son", async ({ page }) => {
  await page.goto("/reserver");
  const v = page.locator("video");
  await expect(v).toHaveJSProperty("muted", true);
  expect(await v.evaluate((e: HTMLVideoElement) => !e.paused)).toBe(true);
});
test("avec réduction des animations ou économie de données, seule l'image fixe s'affiche", async ({ browser }) => {});
test("tient sur un téléphone, sans débordement", async ({ page }) => {});
test("le calendrier s'utilise au clavier", async ({ page }) => { /* Tab jusqu'à une date, Entrée : sélectionnée, focus visible */ });
test("la barre se réduit au logo et à Accueil", async ({ page }) => {});
test("sans JavaScript, la page donne le téléphone et l'e-mail", async ({ browser }) => {});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/calendar-grid.test.ts && npx playwright test e2e/reservation.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter la page**

Porter la carte en verre dépoli et les textes de la maquette. Le calendrier charge le mois affiché et le suivant. La saisie reste en mémoire pendant les allers-retours entre étapes. Turnstile en mode géré sur la troisième étape, jeton joint à l'envoi. La vidéo se lance sauf si `prefers-reduced-motion` ou `navigator.connection?.saveData`.

- [ ] **Step 4: Vérifier**

Run : `npx vitest run test/worker/calendar-grid.test.ts && npx playwright test e2e/reservation.spec.ts`. Expected : PASS sur les deux navigateurs et les deux tailles.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: page de réservation branchée à l'API"
```

### Task 18: Pages légales, référencement et en-têtes

**Files:**
- Create: `src/pages/mentions-legales.astro`, `src/pages/cgv.astro`, `src/pages/confidentialite.astro`, `public/robots.txt`, `public/sitemap.xml`, `public/_headers`, `e2e/quality.spec.ts`
- Modify: `src/layouts/Base.astro`, `worker/http.ts`, `worker/html.ts`

**Interfaces:**
- Produces : le marqueur `[À compléter]` dans le texte des pages tant qu'une information manque, repéré par la tâche 19.

**Contenu à rédiger, en brouillon à faire valider par un professionnel :**
- **CGV :** le mot « acompte » explicite et sa portée (engagement ferme, solde dû), montant, délai de paiement, annulation par le client et par Brotobooth, rétractation (emplacement prévu pour la conclusion du professionnel sur l'article L221-28, 12°), responsabilité, photos, médiation, droit applicable. Version égale à `termsVersion`.
- **Confidentialité :** données collectées, finalités, durée (refus et expirations anonymisés à 12 mois), sous-traitants (Cloudflare, Stripe, Resend, Telegram, en précisant que Telegram reçoit le nom du client et le lieu), droits, contact, Turnstile.
- **Mentions légales :** éditeur, SIRET, hébergeur, contact.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("les pages légales sont accessibles depuis le pied de page", async ({ page }) => {
  for (const [name, url] of [["Mentions légales", "/mentions-legales"], ["CGV", "/cgv"], ["Confidentialité", "/confidentialite"]]) {
    await page.goto("/"); await page.getByRole("contentinfo").getByRole("link", { name }).click();
    await expect(page).toHaveURL(url);
  }
});
test("les CGV parlent d'acompte et portent leur version", async ({ page }) => {
  await page.goto("/cgv");
  await expect(page.getByText(/acompte/i).first()).toBeVisible();
  await expect(page.getByText("2026-11-07")).toBeVisible();
});
test("chaque page publique a un titre et une description, et l'accueil ses données structurées", async ({ page }) => {});
test("/admin n'est pas indexé", async ({ request }) => {
  expect((await request.get("/admin")).headers()["x-robots-tag"]).toContain("noindex");
});
test("robots.txt exclut /admin, /acompte, /agenda, /api, et le plan du site existe", async ({ request }) => {});
test("la politique de sécurité n'interrompt rien", async ({ page }) => {
  // écouter securitypolicyviolation et la console sur /, /reserver et /admin : aucune violation
});
test("aucun cookie déposé sur les pages publiques", async ({ page, context }) => {
  await page.goto("/"); await page.goto("/reserver");
  expect(await context.cookies()).toEqual([]);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx playwright test e2e/quality.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter les pages et les en-têtes**

Politique de sécurité commune aux fichiers statiques (`public/_headers`) et au Worker : `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'self'`. Ajouter `X-Content-Type-Options: nosniff` et `Referrer-Policy: strict-origin-when-cross-origin`. `/admin` en `X-Robots-Tag: noindex`.

- [ ] **Step 4: Vérifier**

Run : `npx playwright test e2e/quality.spec.ts`. Expected : PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pages légales, référencement et en-têtes de sécurité"
```

### Task 19: Contrôles finaux et procédure de mise en ligne

**Files:**
- Create: `scripts/check-launch.mjs`, `e2e/a11y-perf.spec.ts`, `e2e/parcours.spec.ts`, `docs/mise-en-ligne.md`, `docs/essai-local.md`, `test/worker/check-launch.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces : `findLaunchBlockers(input: { offer: Offer; legalPages: Record<string, string>; databaseId: string; vars: Record<string, string> }): string[]` (exportée par `scripts/check-launch.mjs`, fonction pure : la lecture des fichiers reste dans le bloc principal du script). `npm run deploy` = `npm test && npx playwright test && node scripts/check-launch.mjs && astro build && wrangler deploy`. `npm run demo` lance le site en local avec des données d'essai, le paiement simulé, les messages lisibles sur `/demo` et la tâche automatique déclenchable (`wrangler dev --test-scheduled`).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
it("bloque tant que les contenus manquent", () => {
  const b = findLaunchBlockers({ offer: draftOffer, legalPages: { cgv: "[À compléter]" }, databaseId: "00000000-0000-0000-0000-000000000000" });
  expect(b).toEqual(expect.arrayContaining([expect.stringMatching(/provisoire/), expect.stringMatching(/téléphone/), expect.stringMatching(/cgv/), expect.stringMatching(/D1/)]));
});
it("signale une formule à 0 €", () => { /* priceCents: 0 */ });
it("refuse de publier avec le paiement simulé ou les fausses passerelles", () => { /* vars: { PAYMENT_MODE: "simulated" } ou { FAKE_GATEWAYS: "1" } : bloqué */ });
it("laisse passer un contenu complet", () => { expect(findLaunchBlockers(completeInput)).toEqual([]); });
```

```ts
// e2e/parcours.spec.ts
test("une réservation de bout en bout", async ({ page }) => {
  // demande sur /reserver, validation dans /admin, lien lu sur /demo, paiement simulé,
  // puis prestation confirmée dans /admin et date barrée sur /reserver
});

// e2e/a11y-perf.spec.ts
for (const url of ["/", "/reserver", "/cgv", "/mentions-legales", "/confidentialite", "/admin"]) {
  test(`aucune violation d'accessibilité sur ${url}`, async ({ page }) => {
    await page.goto(url); await page.waitForTimeout(2300);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
test("le titre reste lisible au-dessus du mur", async ({ page }) => {
  // axe sur #hero, une fois les tirages posés : aucune violation de contraste
});
test("LCP sous 2,5 s en 4G simulée", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium");
  // CDP Network.emulateNetworkConditions (4 Mb/s, 20 ms), mesure via PerformanceObserver largest-contentful-paint
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/check-launch.test.ts && npx playwright test e2e/a11y-perf.spec.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter le contrôle et corriger ce que révèlent les tests**

- [ ] **Step 4: Écrire `docs/mise-en-ligne.md`**

Procédure pour le propriétaire, dans cet ordre, avec les commandes :

1. **Comptes :** Cloudflare en offre Workers Paid, Stripe, Resend (région européenne), bot via @BotFather, identifiants des chats Telegram.
2. **Base :** `npx wrangler d1 create brotobooth --jurisdiction=eu`, identifiant à reporter dans `wrangler.jsonc`, puis `wrangler d1 migrations apply DB --remote`.
3. **Secrets :** `wrangler secret put` pour chacun des secrets de `Env`.
4. **DNS :** relever toutes les entrées actuelles de `brotobooth.fr`, les recréer chez Cloudflare, dont l'entrée de messagerie (`mail.mymail.eu.com`), changer les serveurs de noms, vérifier que la messagerie fonctionne. Retour arrière : remettre les anciens serveurs de noms. `photos.brotobooth.fr` reste réservé à la galerie de la borne.
5. **Resend :** ajouter SPF et DKIM sans toucher à l'entrée de messagerie.
6. **Cloudflare Access :** application sur `/admin*` et `/api/admin*`, politique limitée aux e-mails du propriétaire, public (AUD) à reporter dans `ACCESS_AUD`.
7. **Turnstile :** créer le widget, clé publique dans `PUBLIC_TURNSTILE_SITE_KEY`, clé secrète dans `TURNSTILE_SECRET`.
8. **Stripe (après la tâche 20) :** webhook sur `/api/stripe/webhook` pour `checkout.session.completed`, d'abord en mode test.
9. **Telegram :** `node scripts/set-telegram-webhook.mjs`.
10. **Contenus :** remplir `config/offer.json`, retirer `draft`, compléter les pages légales après validation par un professionnel, confirmer le texte de présentation.
11. **Publication :** `npm run deploy`.
12. **Avant d'ouvrir :** un vrai paiement de faible montant remboursé, un e-mail reçu sur Gmail, les boutons du bot, l'agenda abonné et ses alertes réglées sur le téléphone, un essai sur un vrai téléphone et sur Safari, le point du lundi reçu, une restauration Time Travel répétée à blanc.

- [ ] **Step 5: Écrire `docs/essai-local.md`**

Guide pour le propriétaire : lancer `npm run demo`, ouvrir le site, faire une demande depuis le téléphone ou l'ordinateur, lire les messages sur `/demo`, valider dans `/admin`, payer en simulation, déclencher la tâche automatique, et la liste de ce qui est simulé (paiement, e-mails, Telegram, anti-robots).

- [ ] **Step 6: Vérifier l'ensemble**

Run : `npm test && npx playwright test && npm run build`. Expected : tout passe. Run : `node scripts/check-launch.mjs`. Expected : ÉCHEC listant les contenus manquants, ce qui prouve que le contrôle fonctionne.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: contrôles finaux, essai local et procédure de mise en ligne"
```

### Task 20: Vrai paiement Stripe

**Ne démarre qu'après la vérification du site par le propriétaire et son accord explicite.** Le mode test de Stripe suffit pour cette tâche : aucune clé réelle.

**Files:**
- Create: `worker/stripe.ts`, `test/worker/stripe.test.ts`
- Modify: `worker/deps.ts`, `docs/mise-en-ligne.md`

**Interfaces:**
- Consumes : `StripeGateway`, `stripeWebhook` et tout le parcours `/acompte` de la tâche 7, inchangés.
- Produces : `stripeGateway(env: Env, fetchFn?: typeof fetch): StripeGateway`. `makeDeps` l'utilise dès que `PAYMENT_MODE` n'est pas `simulated`.

- [ ] **Step 1: Écrire les tests qui échouent**

Avec un `fetchFn` factice : `createSession` envoie `mode=payment`, le montant, la devise `eur`, `metadata[booking_id]`, `client_reference_id`, `expires_at`, et les adresses de retour `/acompte/<jeton>?paid=1` et `/acompte/<jeton>`. `retrieveSession` traduit la réponse en `StripeSession`, y compris `bookingId` depuis les métadonnées. `expireSession` relaie l'erreur de Stripe. `verifyWebhook` accepte un en-tête produit par `stripe.webhooks.generateTestHeaderStringAsync` et rejette une signature fausse.

- [ ] **Step 2: Lancer les tests pour les voir échouer**

Run : `npx vitest run test/worker/stripe.test.ts`. Expected : FAIL.

- [ ] **Step 3: Implémenter `worker/stripe.ts`**

`new Stripe(key, { httpClient: Stripe.createFetchHttpClient(fetchFn) })` et `webhooks.constructEventAsync(body, sig, secret, undefined, Stripe.createSubtleCryptoProvider())`.

- [ ] **Step 4: Vérifier**

Run : `npm test`. Expected : tout passe. Puis, avec les clés de test du propriétaire et la CLI Stripe : paiement normal, paiement en limite d'échéance, webhook rejoué, webhook perdu, paiement sur réservation expirée.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: paiement réel par Stripe Checkout"
```

## Sources vérifiées pour ce plan

- [Intégration Vitest de Cloudflare](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)
- [`run_worker_first` et fichiers statiques](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Access dans un Worker (`ctx.access`)](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Test de Turnstile](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [SDK Stripe sur Cloudflare Workers](https://github.com/stripe/stripe-node)
- [Session Checkout : `expires_at`](https://docs.stripe.com/api/checkout/sessions/create)
- [Déployer Astro sur Cloudflare](https://github.com/withastro/docs/blob/main/src/content/docs/en/guides/deploy/cloudflare.mdx)
