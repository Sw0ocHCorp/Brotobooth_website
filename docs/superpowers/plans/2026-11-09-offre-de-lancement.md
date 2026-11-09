# Offre de lancement à paliers : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** des prix de lancement par paliers (10 places chacun) qui passent tout seuls au palier suivant, figés dans chaque réservation et affichés comme une billetterie de festival.

**Architecture :** les paliers vivent dans `config/offer.json` et une fonction pure calcule le palier en cours à partir des places prises, comptées dans D1. Le Worker attribue le palier à l'insertion par une instruction conditionnelle (limite stricte), refuse une demande dont le prix affiché n'est plus le bon (`price_changed`) et publie l'état des prix sur `GET /api/prices`. Les pages restent statiques au prix normal ; un petit module front applique le prix du moment.

**Tech Stack :** Astro 7, Worker Cloudflare en TypeScript sans framework, D1, Vitest (`@cloudflare/vitest-plugin`), Playwright (Chromium).

**Spec :** `docs/superpowers/specs/2026-11-09-offre-de-lancement-design.md` (à lire avant chaque tâche ; la spec d'origine `2026-11-07-site-reservations-design.md` reste valable ailleurs).

## Global Constraints

- Chaque phrase visible par un client s'adresse à lui (« vous ») ; jamais « palier », « place prise », « statut » côté client : il lit « Offre de lancement ». « Palier » n'apparaît que chez le propriétaire (administration, e-mails `owner_*`, Telegram, agenda).
- DA « Sunset » : orange en anneau pour le choix fait, rose pour l'action, jamais de couleur de marque en texte ; le prix barré est en couleur atténuée.
- Montants en centimes partout ; affichage par `formatEuros` (`worker/html.ts`), qui écrit « 250 € » et « 37,50 € ».
- Aucun test ne cite un prix, un palier, un nombre de places ni un identifiant de l'offre réelle : il lit `offer` ou construit une offre de test avec `buildOffer`.
- Les e2e ne supposent jamais quel palier est en cours : la base e2e se remplit pendant la série. Ils lisent `GET /api/prices` ou le remplacent par `page.route`.
- Aucune nouvelle dépendance. Aucune donnée personnelle dans les journaux.
- Ne jamais committer `.claude/` ; chaque commit se termine par la ligne d'attribution de l'environnement.
- Commandes : `npm test`, `npm run typecheck`, `npm run build`, e2e `npx playwright test --project=chromium-telephone --project=chromium-ordinateur` (WebKit ne démarre pas sur cette machine).

## Review Focus

1. **Base e2e et tests qui consomment des places** : chaque demande ou ajout manuel d'un test fait avancer le palier ; un test qui suppose le premier palier casse au onzième. → Task 3 (helper de demande qui lit le palier courant) et Tasks 5 à 7 (prix lus sur `/api/prices`).
2. **Deux paliers voisins au même prix** pour une formule : un palier rempli pendant l'envoi ne doit pas répondre `price_changed` avec un prix identique. → Task 3, test `retries the next tier when its price is the same`.
3. **Cache de 30 s sur `/api/prices`** : le client envoie un prix périmé ; le message doit dire l'ancien et le nouveau prix, et le renvoi doit réussir même si la relecture de `/api/prices` échoue. → Task 6, e2e « renvoi au nouveau prix même si /api/prices ne répond plus ».
4. **`/api/prices` en panne côté administration** : le formulaire d'ajout préremplit au prix normal, le bandeau reste caché, le serveur attribue quand même le palier en cours. → Task 7.
5. **Places qui reviendraient par la bande** : refus, expiration, annulation, anonymisation ou correctif de prix ne doivent jamais rendre une place ni changer de palier ; une date bloquée n'en prend jamais. → Task 2 (anonymisation, `price_tier` figé) et Task 3 (refus puis demande suivante).

---

### Task 1 : Les paliers dans l'offre

**Files :**
- Modify : `config/offer.json`, `worker/offer.ts`, `src/components/Plans.astro`, `src/pages/reserver.astro`, `scripts/check-launch.mjs`, `worker/operations.ts:~172-176`, `docs/mise-en-ligne.md` (étape 10), tout autre lecteur de `plan.priceCents` (`grep -rn priceCents src worker scripts e2e test`)
- Test : `test/worker/bookings.test.ts` (tests de `buildOffer`, à côté des existants), `test/worker/check-launch.test.ts`

**Interfaces :**
- Produces (dans `worker/offer.ts`) :
  - `interface Tier { id: string; name: string; places?: number; refillCents: number; prices: Record<string, number> }`
  - `Plan` = `{ id: string; name: string; booth: string; prints: number }` (plus de `priceCents`)
  - `Offer.tiers: Tier[]` ; `OfferConfig` décrit le JSON (formules sans `name`)
  - `interface CurrentTier { tier: Tier; remaining: number | null; launch: boolean }`
  - `currentTier(from: Offer, taken: Readonly<Record<string, number>>): CurrentTier`
  - `normalTier(from: Offer): Tier` (le dernier palier)
  - `priceOf(tier: Tier, planId: string): number`
  - `tierById(id: string): Tier | undefined` (lit l'offre du module, comme `planById`)
  - `interface PricesBody { tier: string; launch: boolean; remaining: number | null; refillCents: number; plans: Record<string, { priceCents: number; normalCents: number }> }`
  - `pricesBody(from: Offer, current: CurrentTier): PricesBody`

- [ ] **Step 1 : tests qui échouent** (dans le `describe` de `buildOffer`, offre de test à deux formules `a`, `b` et trois paliers)
  - `currentTier on an empty base is the first tier` : `tier.id` = premier, `remaining` = ses `places`, `launch` = `true`.
  - `currentTier skips full tiers` : `taken = { t1: places1 }` → deuxième palier, `remaining` = `places2`.
  - `currentTier counts the last place` : `taken = { t1: places1 - 1 }` → premier palier, `remaining` = 1.
  - `currentTier ends on the unlimited tier` : tous les paliers limités pleins → dernier palier, `remaining` = `null`, `launch` = `false`.
  - `currentTier ignores unknown tier ids` : `taken = { inconnu: 99 }` → premier palier.
  - `pricesBody gives tier and normal prices` : `plans.a` = `{ priceCents: prix t1 de a, normalCents: prix du dernier palier de a }`, `refillCents` et `tier` du palier en cours.
  - `buildOffer refuses …`, un test par cas, chacun `toThrow(/config\/offer.json/)` : aucun palier ; deux `id` identiques ; prix manquant pour une formule ; prix pour une formule inconnue ; palier non final sans `places` ; `places` à 0 ou non entier ; dernier palier avec `places`.
  - `check-launch.test.ts` : un prix à 0 dans un palier donne `Le palier « <name> » : le prix de « <plan.name> » est encore à 0 € dans config/offer.json.` ; un `refillCents` à 0 donne `Le palier « <name> » : le tarif de la recharge est encore à 0 € dans config/offer.json.` ; l'offre réelle n'a aucun de ces deux blocages.

- [ ] **Step 2 : lancer** `npx vitest run test/worker/bookings.test.ts test/worker/check-launch.test.ts` → échecs (fonctions absentes, messages absents).

- [ ] **Step 3 : implémenter**
  - `config/offer.json` : les formules perdent `priceCents` ; `tiers` exactement comme la section 3 de la spec (`lancement-1` 15000/25000/7500 et 10 places, `lancement-2` 20000/35000/10000 et 10 places, `normal` 25000/40000/10000).
  - `worker/offer.ts` : types et fonctions ci-dessus ; `buildOffer` valide les paliers (cas du step 1) en plus de ce qu'il fait déjà.
  - Les affichages statiques (`Plans.astro`, étape 2 de `reserver.astro`) montrent `priceOf(normalTier(offer), plan.id)`, masqué s'il vaut 0, comme avant.
  - `createRequest` prend provisoirement `priceOf(normalTier(offer), plan)` ; la Task 3 le remplace.
  - `check-launch.mjs` : les deux blocages du step 1 remplacent celui de la « formule à 0 € ».
  - `docs/mise-en-ligne.md`, étape 10 : la forme des paliers, et que l'`id` d'un palier ne change plus une fois le site en ligne.

- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, `npm run build` et les e2e Chromium → tout passe (les prix affichés n'ont pas changé : ce sont les prix normaux).

- [ ] **Step 5 : commit** `feat: les paliers de prix dans l'offre`

### Task 2 : Le palier dans la base

**Files :**
- Create : `migrations/0003_price_tier.sql`
- Modify : `worker/repository.ts`, `worker/operations.ts` (`blankBooking` : les deux nouvelles colonnes à `null`), `test/support.ts` (`newBooking` : `price_tier: null, refill_cents: null`)
- Test : `test/worker/repository.test.ts`

**Interfaces :**
- Consumes : rien de la Task 1.
- Produces (dans `worker/repository.ts`) :
  - `Booking` gagne `price_tier: string | null` et `refill_cents: number | null` (et `NEW_BOOKING_COLUMNS`)
  - `type TierCap = { tier: string; places: number }`
  - `countTakenByTier(db: D1Database): Promise<Record<string, number>>`
  - `insertBooking(db, b, specs, nowIso, cap?: TierCap)` → `{ ok: true; booking } | { ok: false; reason: "date_taken" | "tier_full" }`

- [ ] **Step 1 : tests qui échouent**
  - `countTakenByTier counts every status` : une réservation par état (`pending_review`, `awaiting_deposit`, `confirmed`, `refused`, `expired`, `cancelled`) au palier `t1` → `{ t1: 6 }` ; une date bloquée (`price_tier` nul) n'apparaît pas.
  - `insertBooking with a cap refuses a full tier` : `cap = { tier: "t1", places: 1 }`, une première insertion `ok`, une seconde (autre date) → `{ ok: false, reason: "tier_full" }`, aucune ligne ni notification de la seconde en base.
  - `insertBooking with a cap lets only one of two simultaneous inserts through` : `Promise.all` de deux insertions (dates différentes, `places: 1`) → une `ok`, une `tier_full`.
  - `insertBooking still reports a taken date with a cap` : même date qu'une réservation active, palier non plein → `date_taken`.
  - `anonymizeOld keeps the tier and the refill price` : ligne `refused` anonymisée → `price_tier` et `refill_cents` inchangés, `countTakenByTier` inchangé.
  - `patchBooking cannot move a booking to another tier` : `patchBooking(…, { price_tier: "t2" })` lève.

- [ ] **Step 2 : lancer** `npx vitest run test/worker/repository.test.ts` → échecs (colonnes et fonctions absentes).

- [ ] **Step 3 : implémenter**
  - Migration : deux `ALTER TABLE bookings ADD COLUMN` (`price_tier TEXT`, `refill_cents INTEGER`), avec un commentaire qui renvoie à la spec.
  - `insertBooking` avec `cap` : `INSERT INTO bookings (…) SELECT ?, … WHERE (SELECT COUNT(*) FROM bookings WHERE price_tier = ?) < ?`, et ses notifications par `notificationStmt(db, spec, { sql: "id = ?", params: [b.id] })` ; une insertion qui n'a écrit aucune ligne (`writeThenRead` rend `null`) donne `tier_full`. Sans `cap`, rien ne change.
  - `price_tier` rejoint `FROZEN_COLUMNS`.

- [ ] **Step 4 : lancer** `npm test` et `npm run typecheck` → tout passe.

- [ ] **Step 5 : commit** `feat: chaque réservation garde son palier, limite stricte des places`

### Task 3 : Le serveur attribue le palier et publie les prix

**Files :**
- Modify : `worker/operations.ts` (`PARSERS`, `RequestInput`, `CreateRequestResult`, `createRequest`, `ManualInput`, `createManual`, `insertOwnerBooking`, `OpResult`), `worker/api.ts`, `worker/router.ts`, `worker/admin.ts` (`parseManual`, `FAILURE_STATUS`), `scripts/demo.mjs` (la demande d'exemple lit `/api/prices` puis envoie `price_cents`), `docs/essai-local.md` (les demandes d'essai prennent des places ; `npm run demo:reset` les rend), `test/support.ts`
- Test : `test/worker/operations.test.ts`, `test/worker/api.test.ts`, `test/worker/admin.test.ts`

**Interfaces :**
- Consumes : Task 1 (`currentTier`, `priceOf`, `pricesBody`, `PricesBody`), Task 2 (`countTakenByTier`, `insertBooking(…, cap)`, `TierCap`).
- Produces :
  - `RequestInput.price_cents: number` (entier de 0 à 10 000 000, obligatoire ; sinon champ `price_cents` refusé)
  - `CreateRequestResult` gagne `{ kind: "price_changed"; priceCents: number }`
  - `ManualInput.plan?: string` ; `OpResult` gagne la raison `"tier_changed"`
  - `GET /api/prices` → `200` `PricesBody`, `Cache-Control: public, max-age=30`
  - `POST /api/requests` → `409 { error: "price_changed", price_cents }`
  - `POST /api/admin/bookings` (`kind: "manual"`) accepte `plan` (identifiant connu, sinon champ refusé) ; `409 { error: "tier_changed" }`
  - `test/support.ts` : `requestBody(over?)` (ou le helper de demande existant) envoie `price_cents` = prix de la formule au palier en cours, lu avec `currentTier(offer, await countTakenByTier(env.DB))`

- [ ] **Step 1 : tests qui échouent** (offre de test injectée là où un test remplit un palier ; jamais les chiffres réels)
  - `createRequest stores the tier, its price, deposit and refill` : `price_tier`, `price_cents`, `deposit_cents = depositCents(prix, depositPercent)`, `refill_cents` du palier en cours.
  - `createRequest answers price_changed before Turnstile` : `price_cents` faux → `{ kind: "price_changed", priceCents: <bon prix> }`, `verifyTurnstile` jamais appelé, aucune ligne.
  - `createRequest moves to the next tier once a tier is full` : palier à `places` remplies → prix du suivant.
  - `createRequest answers price_changed when the tier fills during the request` : palier plein entre la vérification et l'insertion (insertion concurrente) → `price_changed` avec le prix du palier suivant, une seule ligne au premier palier.
  - `retries the next tier when its price is the same` : deux paliers voisins au même prix, le premier se remplit pendant la demande → `created` au palier suivant, pas de `price_changed`.
  - `a refused request keeps its place` : refuser une demande puis en créer une autre → `remaining` diminue toujours.
  - `createManual takes a place of the current tier` : `price_tier`, `refill_cents` du palier, `plan` enregistré quand fourni, prix saisi conservé.
  - `createManual answers tier_changed when the tier fills` → `{ ok: false, reason: "tier_changed" }`.
  - `blockDate takes no place` : `price_tier` nul, `countTakenByTier` inchangé.
  - API : `GET /api/prices` rend `pricesBody(offer, currentTier(…))` et l'en-tête de cache ; `POST /api/requests` sans `price_cents` → 422 avec `price_cents` dans `fields` ; avec un mauvais prix → 409 `price_changed` et le bon `price_cents`.
  - Admin : `plan` inconnu → 422 `fields: ["plan"]` ; `tier_changed` → 409 `{ error: "tier_changed" }` ; la réservation renvoyée porte `price_tier` et `refill_cents`.

- [ ] **Step 2 : lancer** `npx vitest run test/worker/operations.test.ts test/worker/api.test.ts test/worker/admin.test.ts` → échecs.

- [ ] **Step 3 : implémenter**
  - `createRequest`, dans cet ordre : champs, doublon, palier en cours et comparaison des prix (`price_changed`), Turnstile, limites, insertion avec `cap` (si `launch`).
  - Sur `tier_full`, relire le palier en cours : prix différent → `price_changed` ; prix identique → nouvelle insertion au nouveau palier. Au plus `offer.tiers.length` essais (chaque `tier_full` remplit un palier, le palier en cours ne fait qu'avancer).
  - `createManual` : même palier en cours, insertion avec `cap`, `tier_full` → `tier_changed`. `blockDate` sans palier ni `cap`.
  - `prices` dans `api.ts`, routé en `GET /api/prices`.

- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, puis les e2e Chromium : les parcours qui envoient une demande cassent tant que la page n'envoie pas `price_cents` ; le noter dans le rapport, la Task 6 les répare. Les autres e2e passent.

- [ ] **Step 5 : commit** `feat: le palier attribué à l'enregistrement, prix publiés sur /api/prices`

### Task 4 : Les messages, l'agenda et les CGV

**Files :**
- Modify : `worker/templates.ts`, `worker/payments.ts:98`, `worker/calendar.ts` (`details`), `src/pages/cgv.astro` (section « Le prix »)
- Test : `test/worker/templates.test.ts`, `test/worker/payments.test.ts`, `test/worker/calendar.test.ts`

**Interfaces :**
- Consumes : Task 1 (`tierById`), Task 2 (colonnes).
- Produces (dans `worker/templates.ts`) : `tierName(b: Booking): string | null` (le `name` du palier, son `id` s'il est inconnu, `null` sans palier).

- [ ] **Step 1 : tests qui échouent**
  - Client (`client_received`, `client_deposit_link`, `client_confirmed`, rappels, page `/acompte`) : une ligne « Recharge de 100 tirages, le jour J » avec `formatEuros(refill_cents)` juste après « Formule » ; aucune ligne quand `refill_cents` est nul.
  - Propriétaire (`owner_new_request`, `owner_deposit_paid`, `owner_d7`, `owner_d1`) : « Palier » avec `tierName(b)` et « Recharge de 100 tirages » avec le tarif, juste après « Formule », sur e-mail et Telegram.
  - Agenda : `Palier : …` et `Recharge de 100 tirages : …` dans la description.
  - `tierName` : palier connu → `name` ; identifiant inconnu → l'identifiant ; nul → `null`.
  - Le test de vocabulaire des e-mails client reste vert (« palier » n'y apparaît jamais).

- [ ] **Step 2 : lancer** les trois fichiers de test → échecs.

- [ ] **Step 3 : implémenter.** CGV, dans « Le prix », la phrase exacte : « Si les tirages compris s'épuisent pendant votre événement, vous pouvez ajouter des recharges de 100 tirages, au tarif indiqué dans votre récapitulatif. Elles se règlent avec le solde. »

- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, `npm run build` → tout passe.

- [ ] **Step 5 : commit** `feat: le tarif de la recharge dans les récapitulatifs, le palier chez le propriétaire`

### Task 5 : La carte du BrotoBooth sur l'accueil

**Files :**
- Create : `src/scripts/prices.ts`
- Modify : `src/components/Plans.astro`, le chargement des scripts de l'accueil (`src/pages/index.astro`), `src/styles/site.css` (une classe `sr-only` si le site n'en a pas ; `src/styles/admin.css` en a une à reprendre)
- Test : `e2e/home.spec.ts`

**Interfaces :**
- Consumes : Task 1 (`PricesBody`, `offer`, `normalTier`, `priceOf`), Task 3 (`GET /api/prices`).
- Produces (dans `src/scripts/prices.ts`) :
  - `fetchPrices(fresh?: boolean): Promise<PricesBody | null>` (`null` sur toute erreur ou réponse non 200 ; `fresh` → `cache: "no-cache"`)
  - `placesLine(remaining: number): string` → « Plus que 7 places à ce prix », « Plus qu'une place à ce prix »
  - `applyPrices(root: ParentNode, body: PricesBody | null): void`, qui met à jour dans `root` : `[data-launch]` (montré seulement si `body?.launch`), `[data-places]`, `[data-plan="<id>"] [data-amount]`, `[data-refill]`. Avec `null` ou hors offre : prix normaux, rien de barré, `[data-launch]` caché.
  - Le balisage d'un montant pendant l'offre : `<b>150 €</b><s><span class="sr-only">, au lieu de </span>250 €</s>`, le prix barré affiché avant le prix du palier (ordre visuel en CSS) ; le texte lu est « 150 €, au lieu de 250 € ».

- [ ] **Step 1 : tests qui échouent** (`e2e/home.spec.ts`, `page.route("**/api/prices", …)` avec des corps construits depuis `offer` et `pricesBody`)
  - `pendant l'offre, la carte montre le prix du moment, le prix normal barré et les places` : « Offre de lancement », `placesLine(remaining)`, pour chaque formule le texte « <prix du palier>, au lieu de <prix normal> », la recharge au tarif du palier.
  - `une seule place restante se dit au singulier` : `remaining: 1` → « Plus qu'une place à ce prix ».
  - `hors offre, la carte garde les prix normaux` : `launch: false` → aucun « Offre de lancement », aucun `s`.
  - `sans réponse de /api/prices, la carte garde les prix normaux` : route en `abort()` puis en 500.

- [ ] **Step 2 : lancer** `npx playwright test e2e/home.spec.ts --project=chromium-telephone --project=chromium-ordinateur` → échecs.

- [ ] **Step 3 : implémenter.** `Plans.astro` construit la carte au prix normal avec les attributs ci-dessus, la ligne cachée « Offre de lancement » suivie de `[data-places]`, et la ligne « Recharge de 100 tirages, le jour J » avec `[data-refill]` au tarif normal. Le script de l'accueil appelle `applyPrices(document.querySelector("#formules"), await fetchPrices())`.

- [ ] **Step 4 : lancer** les e2e Chromium complets, `npm run typecheck`, `npm run build` → tout passe (hors parcours d'envoi, réparés en Task 6).

- [ ] **Step 5 : commit** `feat: l'offre de lancement sur la carte du BrotoBooth`

### Task 6 : La réservation au prix du moment

**Files :**
- Modify : `src/pages/reserver.astro` (étape 2 : `[data-launch]` au-dessus des tirages, `[data-amount]` dans chaque bouton, ligne de recharge après eux ; étape 3 : `<p class="problem" id="problem-price" role="alert" tabindex="-1" hidden>` près du bouton d'envoi), `src/scripts/reservation.ts`, `src/styles/reserver.css`
- Test : `e2e/reservation.spec.ts`, `e2e/seed.ts`, `e2e/parcours.spec.ts` si besoin

**Interfaces :**
- Consumes : Task 5 (`fetchPrices`, `applyPrices`, `placesLine`), Task 3 (`409 price_changed`).
- Produces : rien pour d'autres tâches.

- [ ] **Step 1 : tests qui échouent**
  - `l'étape 2 montre le prix du moment` : route de `/api/prices` → boutons « <prix du palier>, au lieu de <prix normal> », la ligne de places, la recharge.
  - `l'envoi transmet le prix affiché` : le corps de `POST /api/requests` (intercepté puis relayé) porte `price_cents` = prix affiché de la formule choisie.
  - `un prix changé est expliqué, puis le renvoi aboutit` : `/api/prices` remplacé par un corps au prix normal pendant l'offre réelle → 409 réel, message exact « Le prix de cette formule vient de changer : <nouveau> au lieu de <ancien>. Si ce prix vous convient, envoyez à nouveau votre demande. », focus sur le message, champs intacts ; second envoi → demande enregistrée. Si l'offre réelle est déjà au dernier palier au moment du test, le corps de remplacement porte un autre prix que le vrai.
  - `renvoi au nouveau prix même si /api/prices ne répond plus` : même scénario, `/api/prices` en `abort()` après le 409 → le second envoi porte le `price_cents` de la réponse 409 et aboutit.
  - Les parcours d'envoi existants repassent au vert.

- [ ] **Step 2 : lancer** `npx playwright test e2e/reservation.spec.ts …` → échecs.

- [ ] **Step 3 : implémenter.** Au démarrage, `fetchPrices()` en même temps que `load()`, puis `applyPrices` sur l'étape 2. `request()` ajoute `price_cents` : prix affiché de la formule choisie (prix du moment, sinon prix normal). Dans `answer()`, `409` avec `error === "price_changed"` passe avant le cas « date prise » : retenir `data.price_cents` pour la formule choisie, relire `fetchPrices(true)` et l'appliquer, montrer `#problem-price`. Le message se cache à l'envoi suivant.

- [ ] **Step 4 : lancer** les e2e Chromium complets, `npm test`, `npm run typecheck` → tout passe.

- [ ] **Step 5 : commit** `feat: la réservation au prix du moment, prix changé expliqué au client`

### Task 7 : L'administration

**Files :**
- Modify : `src/pages/admin.astro` (bandeau `<p id="tier" role="status" hidden>` sous l'en-tête ; champ « Formule » en premier du formulaire d'ajout avant le prix, valeurs = identifiants, libellés = noms, première option vide « Prix libre »), `src/scripts/admin.ts` (`Booking` local, `explain`, `FIELD_LABEL`, fiche, préremplissage)
- Test : `e2e/admin.spec.ts`

**Interfaces :**
- Consumes : Task 1 (`tierById`, `offer`, `normalTier`, `priceOf`), Task 3 (`plan`, `409 tier_changed`, colonnes renvoyées), Task 5 (`fetchPrices`).
- Produces : rien.

- [ ] **Step 1 : tests qui échouent**
  - `le bandeau nomme le palier en cours` : texte = `Palier en cours : <name> · <n> places restantes` (`1 place restante` au singulier) d'après la vraie réponse de `/api/prices`, ou `Palier en cours : <name>` sur le palier sans limite.
  - `choisir une formule préremplit prix et acompte` : prix = prix du palier en cours, acompte = `depositCents(prix, offer.depositPercent)`, tous deux modifiables ; « Prix libre » ne touche à rien.
  - `sans /api/prices, le formulaire préremplit au prix normal` : route en `abort()` → bandeau caché, prix normal ; l'ajout aboutit et la fiche montre le palier attribué par le serveur.
  - `un palier rempli entre-temps est signalé` : réponse 409 `tier_changed` (route) → « Le palier vient de changer : vérifiez le prix. », prix relu.
  - `la fiche montre le palier et la recharge` : lignes « Palier » et « Recharge de 100 tirages ».
  - Un `plan` refusé se lit « Vérifiez la formule. ».

- [ ] **Step 2 : lancer** `npx playwright test e2e/admin.spec.ts …` → échecs.

- [ ] **Step 3 : implémenter.** Le bandeau se lit à l'ouverture de la page et après chaque ajout ; l'ouverture du formulaire d'ajout relit `fetchPrices(true)`.

- [ ] **Step 4 : lancer** la suite complète : `npm test`, `npm run typecheck`, `npm run build`, e2e Chromium → tout passe.

- [ ] **Step 5 : commit** `feat: le palier en cours et le prix proposé dans l'administration`
