# Offre de lancement à paliers

Date : 2026-11-09. Complète la spec [2026-11-07-site-reservations-design.md](2026-11-07-site-reservations-design.md), dont les règles restent valables sauf là où ce document les remplace (prix d'une formule, ajout manuel, récapitulatifs).

## 1. Intention

Pour lancer le BrotoBooth, le propriétaire veut des prix progressifs, comme une billetterie de festival : les premières prestations sont moins chères, puis le prix monte par paliers jusqu'au prix normal.

| Palier | 200 tirages | 400 tirages | Recharge de 100 tirages | Places |
|---|---|---|---|---|
| Lancement 1 | 150 € | 250 € | 75 € | 10 |
| Lancement 2 | 200 € | 350 € | 100 € | 10 |
| Prix normal | 250 € | 400 € | 100 € | sans limite |

### Critères de réussite

1. **Automatique.** Le site passe au palier suivant tout seul, sans action du propriétaire.
2. **Jamais plus de 10 places par palier**, même si deux demandes arrivent à la même seconde.
3. **Un prix tenu.** Le client paie le prix qu'il a vu et accepté en envoyant sa demande ; s'il a changé entre-temps, il le voit avant que rien ne soit enregistré.
4. **Comme un festival.** Pendant l'offre, la carte du BrotoBooth montre le prix du moment, le prix normal barré et les places restantes.
5. **Rien de faux affiché.** Sans le prix du moment (chargement, panne), le site affiche le prix normal, jamais un prix plus bas que celui qui sera demandé.

## 2. Règles (validées par le propriétaire)

1. Les paliers se suivent dans l'ordre de `config/offer.json`. Tous ont un nombre de places, sauf le dernier, le prix normal, qui n'a pas de limite.
2. Une place est prise par toute réservation enregistrée à ce palier : demande du site ou ajout manuel. **Une place prise ne revient jamais** : une demande refusée, expirée ou annulée garde la sienne. Le prix ne redescend donc jamais. Une date bloquée ne prend pas de place.
3. Le palier en cours est le premier qui a encore une place.
4. Le prix de la formule et le tarif de la recharge sont figés à l'enregistrement de la réservation. L'acompte reste `depositPercent` du prix figé.
5. Les recharges de 100 tirages s'achètent le jour J, si les tirages s'épuisent, au tarif figé dans la réservation. Elles se règlent avec le solde. Le site ne les vend pas.
6. Une réservation ajoutée à la main prend une place du palier en cours. Le formulaire propose le prix de ce palier pour la formule choisie ; le propriétaire peut le changer. Changer plus tard le prix d'une réservation ne change pas son palier.
7. Quand tous les paliers limités sont complets, le site affiche le prix normal sans aucune mention d'offre.
8. Les places sont comptées sur toutes les bornes à la fois : seul le BrotoBooth est réservable, et une réservation manuelle peut n'avoir aucune formule.

Conséquence assumée : une demande fantaisiste, refusée, consomme une place. Les essais se font sur la version locale (`npm run demo`), jamais sur le site en ligne.

## 3. Configuration (`config/offer.json`)

Le prix quitte les formules et passe dans les paliers :

```json
"plans": [
  { "id": "brotobooth-200", "booth": "brotobooth", "prints": 200 },
  { "id": "brotobooth-400", "booth": "brotobooth", "prints": 400 }
],
"tiers": [
  { "id": "lancement-1", "name": "Lancement 1", "places": 10, "refillCents": 7500,
    "prices": { "brotobooth-200": 15000, "brotobooth-400": 25000 } },
  { "id": "lancement-2", "name": "Lancement 2", "places": 10, "refillCents": 10000,
    "prices": { "brotobooth-200": 20000, "brotobooth-400": 35000 } },
  { "id": "normal", "name": "Prix normal", "refillCents": 10000,
    "prices": { "brotobooth-200": 25000, "brotobooth-400": 40000 } }
]
```

- `id` est la clé enregistrée dans chaque réservation : elle ne change plus une fois le site en ligne. `name` n'est montré qu'au propriétaire. Le client lit « Offre de lancement » pour tout palier limité.
- `buildOffer` (`worker/offer.ts`) refuse une offre mal formée, avec une erreur explicite :
  - aucun palier, ou deux paliers avec le même `id` ;
  - un palier sans prix pour l'une des formules, ou avec un prix pour une formule inconnue ;
  - un palier autre que le dernier sans `places` entier et supérieur à 0, ou un dernier palier qui a des `places`.
- `Plan` perd `priceCents`. Le prix normal d'une formule est celui du dernier palier.
- `scripts/check-launch.mjs` refuse la publication tant qu'un prix ou un tarif de recharge vaut 0.
- Mettre fin à l'offre plus tôt : retirer les paliers de lancement. Les réservations déjà enregistrées gardent leur prix et leur tarif ; leur palier, devenu inconnu, s'affiche par son identifiant dans l'administration.

## 4. Données

Migration `0003_price_tier.sql` : deux colonnes nullables sur `bookings`.

- `price_tier TEXT` : l'`id` du palier de la réservation, `NULL` pour une date bloquée et pour les lignes antérieures.
- `refill_cents INTEGER` : le tarif figé de la recharge de 100 tirages.

Places prises d'un palier : `SELECT price_tier, COUNT(*) FROM bookings WHERE price_tier IS NOT NULL GROUP BY price_tier`, quel que soit l'état. L'anonymisation (`anonymizeOld`) n'efface ni `price_tier` ni `refill_cents`, qui ne sont pas des données personnelles : une place reste prise après l'effacement. Un test le vérifie.

## 5. Attribution du palier

Une fonction pure calcule le palier en cours à partir de l'offre et des places prises : le palier, et le nombre de places restantes (`null` pour le dernier palier).

### Demande du client (`createRequest`)

1. Lecture des champs. La demande porte désormais `price_cents`, le prix que la page a affiché pour la formule choisie (entier, obligatoire).
2. Recherche du doublon, inchangée.
3. **Vérification du prix**, avant le service anti-robots, car un jeton ne sert qu'une fois : si le prix de la formule au palier en cours diffère de `price_cents`, rien n'est enregistré et la réponse est `price_changed` avec le nouveau prix.
4. Service anti-robots et limites, inchangés.
5. **Insertion conditionnelle** : la réservation reçoit le palier, le prix, l'acompte et le tarif de recharge du palier en cours. Pour un palier limité, l'insertion n'a lieu que si le palier a encore une place, vérifié dans la même instruction SQL (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < places`). Les notifications de la demande ne s'insèrent que si la réservation l'a été, dans le même lot. D1 exécute un lot d'un seul tenant : deux demandes simultanées sur la dernière place ne peuvent pas passer toutes les deux.
6. Si le palier s'est rempli entre-temps : `price_changed` avec le prix du nouveau palier en cours. Une date prise entre-temps donne `date_taken`, comme aujourd'hui ; si le palier s'est rempli en même temps, le client l'apprend au renvoi.

### Ajout manuel

- Le formulaire d'ajout gagne un choix « Formule » facultatif. Choisir une formule préremplit le prix du palier en cours et l'acompte ; le propriétaire peut les modifier. Sans formule, le prix reste libre.
- La réservation prend une place du palier en cours, avec son tarif de recharge, par la même insertion conditionnelle. Si le palier s'est rempli entre l'ouverture du formulaire et l'envoi, l'ajout est refusé avec « Le palier vient de changer : vérifiez le prix. », et le formulaire relit `/api/prices` pour se mettre à jour.
- Une date bloquée ne prend pas de place.

## 6. API

- `GET /api/prices` (nouvelle, publique) : `{ launch, remaining, refillCents, plans: { [id]: { priceCents, normalCents } } }`, où `launch` vaut `true` sur un palier limité. `Cache-Control: public, max-age=30`, comme `/api/availability` : le prix peut dater de 30 secondes, l'envoi le vérifie. Aucune donnée de réservation n'y figure, seulement des comptes.
- `POST /api/requests` : `price_cents` obligatoire. Nouvelle réponse `409 { error: "price_changed", price_cents }`.
- Administration : les réservations renvoyées portent `price_tier` et `refill_cents`. L'ajout manuel accepte `plan` (facultatif) et répond `409 { error: "tier_changed" }` dans le cas décrit plus haut. Le bandeau de l'administration lit `/api/prices` et nomme le palier par son `name`.

## 7. Affichage

### Accueil, carte du BrotoBooth

- Construite statiquement au prix normal, sans mention d'offre : c'est ce que voit le client sans JavaScript, avant la réponse de `/api/prices` ou si elle échoue.
- Un script léger lit `/api/prices`. Pendant un palier limité, la carte affiche :
  - « Offre de lancement » et « Plus que 7 places à ce prix » (« Plus qu'une place à ce prix » pour la dernière) ;
  - pour chaque formule : « 200 tirages », le prix normal barré, puis le prix du palier. Un lecteur d'écran entend « 150 €, au lieu de 250 € » ;
  - « Recharge de 100 tirages, le jour J » et son tarif.
- Hors offre, la carte garde le prix normal et le tarif normal de la recharge, sans rien de barré.
- La section des formules est loin sous la ligne de flottaison : la mise à jour ne fait pas bouger ce que le client regarde.

### Réservation

- La page lit `/api/prices` en même temps que les dates. À l'étape 2, les boutons des tirages montrent le prix du palier, le prix normal barré pendant l'offre, et « Plus que 7 places à ce prix » au-dessus d'eux ; « Recharge de 100 tirages, le jour J » et son tarif suivent les boutons.
- L'envoi transmet le prix affiché pour la formule choisie.
- Sur `price_changed`, la page relit `/api/prices`, met à jour les prix de l'étape 2 et affiche, à l'étape 3, près du bouton d'envoi : « Le prix de cette formule vient de changer : 200 € au lieu de 150 €. Si ce prix vous convient, envoyez à nouveau votre demande. » La formule reste choisie, les champs gardent leur contenu, le jeton anti-robots est renouvelé comme après les autres refus.

### E-mails, page d'acompte, agenda

- Le récapitulatif du client (accusé de réception, lien de paiement, confirmation, rappels, `/acompte`) ajoute « Recharge de 100 tirages, le jour J : 75 € » quand `refill_cents` est renseigné.
- Les messages du propriétaire (e-mail, Telegram) et l'événement d'agenda ajoutent le palier et le tarif de la recharge, pour l'avoir sous la main le jour J.

### Administration

- Un bandeau : « Palier en cours : Lancement 1 · 7 places restantes », ou « Prix normal » une fois l'offre finie.
- Chaque réservation affiche son palier et son tarif de recharge.

### CGV

Dans « Le prix », une phrase : « Si les tirages compris s'épuisent pendant votre événement, vous pouvez ajouter des recharges de 100 tirages, au tarif indiqué dans votre récapitulatif. Elles se règlent avec le solde. »

## 8. Erreurs

- `/api/prices` en panne : l'accueil garde le prix normal ; la réservation affiche le prix normal, et l'envoi corrige par `price_changed` si besoin.
- Configuration incohérente : `buildOffer` échoue au chargement, les tests et la construction cassent avant toute publication.
- Le compte des places est une lecture : une panne de D1 fait échouer la demande comme aujourd'hui, sans jamais l'enregistrer à un mauvais prix.

## 9. Tests

- Unitaires : palier en cours (vide, palier rempli, tous remplis, dernière place) ; `buildOffer` refuse chaque offre mal formée ; prix, acompte et recharge figés à l'enregistrement ; `price_changed` avant le service anti-robots ; place gardée après refus, expiration, annulation et anonymisation ; date bloquée sans place ; ajout manuel avec et sans formule, et `tier_changed`.
- Concurrence, sur D1 local avec une offre de test à une place : deux demandes simultanées sur la dernière place, une seule est enregistrée à ce prix, l'autre reçoit `price_changed`.
- API : forme de `/api/prices`, en-tête de cache, `price_cents` obligatoire.
- e2e Chromium : carte de l'accueil avant et après `/api/prices`, et en panne ; prix de l'étape 2 ; message `price_changed` puis renvoi réussi ; bandeau et choix de formule dans l'administration.
- Aucun test ne cite un prix, un palier ni un nombre de places de l'offre réelle : ils lisent `offer`, ou une offre de test.

## 10. Hors périmètre

- Paliers propres à chaque borne : à prévoir quand le BrotoBooth tiny deviendra réservable.
- Montrer le prix du palier suivant, ou une date de fin d'offre.
- Vendre des recharges en ligne.
