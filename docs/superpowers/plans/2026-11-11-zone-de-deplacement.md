# Zone de déplacement : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** une section « Où nous venons » après les formules, avec la carte de la zone de déplacement dessinée à partir des contours officiels des communes, la zone en toutes lettres et un lien WhatsApp pour un lieu hors zone.

**Architecture :** la liste ordonnée des communes du contour vit dans `config/offer.json`. Un script lancé à la main (`npm run zone`) lit les contours sur geo.api.gouv.fr, calcule la zone avec des fonctions pures (polygone refermé par la mer, point dans un polygone, simplification) et écrit `src/generated/zone.json`, versionné. Un composant Astro dessine la carte en SVG en ligne : aucune requête extérieure chez le visiteur.

**Tech Stack :** Astro 7, TypeScript, Node 24 (script), Vitest (projets `worker` et `components`), Playwright (Chromium).

**Spec :** `docs/superpowers/specs/2026-11-11-zone-de-deplacement-design.md` (textes exacts, règle de fermeture par la mer, budget de 80 Ko).

## Global Constraints

- Textes au mot près, ceux de la spec ; chaque phrase s'adresse au client ; rien d'inventé.
- DA « Sunset » : mer au fond nuit du site, communes voisines en traits discrets, zone en blanc translucide ; aucune couleur de marque en texte ; pas d'animation.
- Aucune requête extérieure chez le visiteur ; le site se construit sans réseau (le script n'est jamais lancé par `npm run build`, `npm run deploy` ni les tests).
- `src/generated/zone.json` pèse au plus 80 Ko.
- Mention sous la carte : « Contours des communes : IGN, Admin Express (Licence Ouverte) ».
- Aucune nouvelle dépendance. Les tests ne citent pas les valeurs de l'offre réelle autrement que par `offer` (les communes du contour sont des données réelles : les tests de géométrie utilisent des données de test).
- Branche `feat/contenus` ; ne jamais committer `.claude/` ; ligne d'attribution à chaque commit.
- La démo du propriétaire peut tourner sur le port 8790 et sert `dist/` : ne pas lancer `npm run build` sans vérifier que le port 8790 est libre (`ss -ltnp | grep 8790`) ; les e2e construisent dans `.wrangler/e2e/dist` et ne la gênent pas.
- Commandes : `npm test`, `npm run typecheck`, e2e `npx playwright test --project=chromium-telephone --project=chromium-ordinateur` (≈ 7 min, port 8798).

## Review Focus

1. **Une commune du littoral entre Cassis et La Londe-les-Maures** (Toulon, La Seyne-sur-Mer, Bandol…) doit être dans la zone, même si une droite Cassis–La Londe passe au nord de son centre. → Task 1, test `closes the contour by the sea`.
2. **Un nom de commune du contour mal écrit ou introuvable** sur geo.api.gouv.fr : le script s'arrête avec le nom en cause, sans écrire de carte partielle. → Task 2, test `a border commune missing from the data is an error`.
3. **Une simplification trop forte** qui ferait disparaître une petite commune ou une île : chaque tracé garde au moins trois points ou est omis proprement, jamais un chemin SVG invalide. → Task 1, test `simplify keeps at least the endpoints and never returns fewer than 3 points for a ring`.
4. **Un téléphone étroit (320 px)** : la carte rétrécit avec la page, ses noms restent lisibles ou se masquent, rien ne déborde. → Task 3, e2e `la carte tient sur 320 px`.
5. **Aucun réseau pendant la construction** : `npm run build` réussit sans appeler geo.api.gouv.fr. → Task 3, l'e2e et la construction n'appellent jamais le script (vérifié par un test qui lit `package.json`).

---

### Task 1 : La géométrie de la zone

**Files :**
- Create : `scripts/zone-geometry.mjs` (fonctions pures, JavaScript annoté JSDoc pour être lu par Node sans compilation et typé par `tsc`)
- Modify : `config/offer.json` (`zone.border`), `worker/offer.ts` (`Offer.zone`, validation dans `buildOffer`)
- Test : `test/worker/zone-geometry.test.ts`, `test/worker/offer.test.ts`

**Interfaces :**
- Produces (dans `scripts/zone-geometry.mjs`) :
  - `type Point = [lon: number, lat: number]` ; `type Ring = Point[]`
  - `closeBySea(border: Point[], offset = 0.3): Ring` → le contour suivi dans l'ordre, puis un point à `offset` degrés au sud du dernier, un au sud du premier, puis retour au premier
  - `contains(ring: Ring, point: Point): boolean` (règle pair-impair)
  - `simplify(ring: Ring, tolerance: number): Ring` (Douglas-Peucker sur un anneau fermé ; au moins 3 points distincts, sinon `[]`)
  - `projector(bounds: { west; south; east; north }, width: number): (p: Point) => [x: number, y: number]` (équirectangulaire corrigée de `cos` de la latitude moyenne ; nord en haut)
- Produces (dans `worker/offer.ts`) : `Offer.zone = { border: { name: string; department: string }[] }` ; `buildOffer` refuse moins de trois communes (erreur `config/offer.json`).
- `config/offer.json` : `zone.border`, dans cet ordre : Cassis (13), Aubagne (13), Gémenos (13), Cuges-les-Pins (13), Signes (83), Méounes-lès-Montrieux (83), Belgentier (83), Solliès-Toucas (83), La Farlède (83), La Crau (83), Hyères (83), La Londe-les-Maures (83).

- [ ] **Step 1 : tests qui échouent** (données de test, pas les vraies communes)
  - `contains` : un carré ; un point dedans, un dehors, un sur un sommet (au choix, mais constant).
  - `closes the contour by the sea` : un contour en « U » ouvert vers le sud (côte imaginaire) ; un point au sud de la droite entre le premier et le dernier point, mais au nord des points de fermeture, est dedans ; un point plus au sud que les points de fermeture est dehors.
  - `simplify keeps at least the endpoints and never returns fewer than 3 points for a ring` : un cercle de 200 points simplifié garde la forme (aire à 5 % près) avec bien moins de points ; un minuscule triangle sous la tolérance donne `[]`.
  - `projector` : l'ouest à `x = 0`, l'est à `x = width`, le nord au-dessus du sud.
  - `buildOffer` : `zone.border` de deux communes → erreur `config/offer.json`.
- [ ] **Step 2 : lancer** `npx vitest run test/worker/zone-geometry.test.ts test/worker/offer.test.ts` → échecs.
- [ ] **Step 3 : implémenter** les fonctions et la configuration.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck` → tout passe.
- [ ] **Step 5 : commit** `feat: la géométrie de la zone de déplacement`

### Task 2 : Le script qui fabrique la carte

**Files :**
- Create : `scripts/build-zone.mjs`, `src/generated/zone.json` (produit par le script, versionné)
- Modify : `package.json` (script `"zone": "node scripts/build-zone.mjs"`), `docs/mise-en-ligne.md` (étape 10 : changer la zone = modifier `zone.border` puis `npm run zone`)
- Test : `test/worker/build-zone.test.ts`

**Interfaces :**
- Consumes : Task 1 (`closeBySea`, `contains`, `simplify`, `projector`, `offer.zone.border`).
- Produces : `buildZone(communes: Feature[], border: { name; department }[], width = 800): Zone` (pure, exportée pour les tests) ; `type Zone = { viewBox: string; zone: string; context: string; labels: { name: string; x: number; y: number }[]; communes: string[] }` ; le fichier `src/generated/zone.json` de cette forme.
- Le script : lit `https://geo.api.gouv.fr/departements/{13,83}/communes?fields=nom,code,centre,contour&format=geojson&geometry=contour`, appelle `buildZone`, réduit la tolérance de simplification jusqu'à ce que le JSON tienne en 80 Ko, écrit le fichier, puis affiche les communes retenues (une par ligne, triées).
- `zone` : chemin SVG de toutes les communes retenues ; `context` : les autres communes des deux départements dont l'emprise touche le cadre (cadre = emprise de la zone + 12 % de marge) ; `labels` : centres projetés de Cassis, Aubagne, Signes, Méounes-lès-Montrieux (écrit « Méounes »), Toulon, Hyères, La Londe-les-Maures.

- [ ] **Step 1 : tests qui échouent** (`build-zone.test.ts`, fausses communes carrées en GeoJSON)
  - les communes du contour et celles dont le centre est dans le polygone fermé par la mer sont retenues, les autres non ;
  - `a border commune missing from the data is an error` : un nom absent → l'appel lève une erreur qui le cite ;
  - les sept repères connus de `labels` sont projetés dans le cadre (`0 ≤ x ≤ width`) ;
  - `package.json` : aucun des scripts `build`, `deploy`, `dev`, `dev:e2e`, `demo`, `test` n'appelle `build-zone`.
  - `src/generated/zone.json` existe, a la forme `Zone` et pèse au plus 80 Ko (80 × 1024 octets).
- [ ] **Step 2 : lancer** les tests → échecs.
- [ ] **Step 3 : implémenter**, puis lancer `npm run zone` (réseau nécessaire) : `src/generated/zone.json` est écrit, sous 80 Ko ; noter dans le rapport la liste des communes affichée.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck` → tout passe.
- [ ] **Step 5 : commit** `feat: la carte de la zone fabriquée depuis les contours officiels` (avec `zone.json`)

### Task 3 : La section « Où nous venons » et les CGV

**Files :**
- Create : `src/components/TravelZone.astro`
- Modify : `src/pages/index.astro` (après `<Plans />`, avant `<FinalCta />`), `src/components/ContactFallback.astro` (si sa phrase sert aussi ici), `src/styles/site.css`, `src/pages/cgv.astro` (ligne « Zone de déplacement et frais de déplacement »)
- Test : `test/components/travel-zone.test.ts`, `e2e/home.spec.ts` (liste `SECTIONS` et la section), `e2e/quality.spec.ts` si le texte des CGV y est vérifié

**Interfaces :**
- Consumes : Task 2 (`src/generated/zone.json`, forme `Zone`), `whatsappHref`, `ContactLine`.

- [ ] **Step 1 : tests qui échouent**
  - rendu du composant : `h2` « Où nous venons » ; la phrase exacte de la spec (« Nous installons la borne de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures, sur la côte et dans les terres jusqu'à Gémenos, Cuges-les-Pins, Signes, Méounes, Belgentier, Solliès-Toucas, La Farlède et La Crau. ») ; la mention de la source ; le SVG `aria-hidden` avec les sept noms repères ; « Votre événement a lieu ailleurs ? Écrivez-nous sur WhatsApp : nous voyons ensemble ce qui est possible. » avec le lien `whatsappHref` ; sans WhatsApp (offre de test), la phrase se termine par `ContactLine`.
  - e2e : la section `#zone` vient juste après la section des formules ; faire défiler jusqu'à elle n'émet aucune requête hors de l'origine du site ; `la carte tient sur 320 px` (aucun débordement horizontal, carte visible) ; contrôle d'accessibilité de l'accueil.
  - CGV : « Zone de déplacement : celle que présente la page d'accueil, de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures. Au-delà, sur demande. » puis « Frais de déplacement : » suivi de `<Fact />` (toujours `[À compléter]`).
- [ ] **Step 2 : lancer** les tests concernés → échecs.
- [ ] **Step 3 : implémenter.** Le SVG prend toute la largeur de son conteneur (`viewBox`, `width: 100%`, hauteur automatique) ; les noms repères restent à une taille de texte lisible (pas en dessous de 11 px à 320 px de large), ou se masquent sur les très petits écrans.
- [ ] **Step 4 : lancer** `npm test`, `npm run typecheck`, puis l'e2e Chromium complet → tout passe.
- [ ] **Step 5 : commit** `feat: la section « Où nous venons » et la zone dans les CGV`
