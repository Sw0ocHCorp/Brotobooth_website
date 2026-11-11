# Zone de déplacement

Date : 2026-11-11. Complète la spec [2026-11-07-site-reservations-design.md](2026-11-07-site-reservations-design.md) ; ses règles restent valables (textes pour le client, DA « Sunset », rien d'inventé, aucun service extérieur sans nécessité).

## 1. Intention

Un client doit voir d'un coup d'œil si Brotobooth vient jusqu'au lieu de son événement, avant de choisir sa date.

### Critères de réussite

1. **La zone se voit et se lit** : une carte, et la même zone en toutes lettres.
2. **Fidèle** : la carte suit les vrais contours des communes et de la côte, et ne déborde pas de la zone donnée par le propriétaire.
3. **Rien d'extérieur pour le visiteur** : la carte est dans le site ; aucun service de cartes n'est appelé, rien à ajouter à la politique de confidentialité.
4. **Légère** : la carte pèse au plus 80 Ko dans la page.

## 2. La zone (donnée par le propriétaire)

Le contour, dans l'ordre, en faisant le tour :

- à l'ouest : Cassis, Aubagne ;
- au nord : Gémenos, Cuges-les-Pins, Signes, Méounes-lès-Montrieux ;
- à l'est : Belgentier, Solliès-Toucas, La Farlède, La Crau, Hyères, La Londe-les-Maures ;
- au sud : la mer.

Hors zone (hypothèse à confirmer par le propriétaire) : le client écrit, et le propriétaire voit au cas par cas ; le site ne promet aucun prix.

## 3. Ce que voit le client

Une section `#zone` « Où nous venons », sur l'accueil, juste après « Les formules » et avant « Une date en tête ? ». Pas de lien dans le menu.

- **La carte** : le fond nuit du site pour la mer ; les communes voisines en traits discrets ; la zone en blanc translucide ; sept villes repères nommées : Cassis, Aubagne, Signes, Méounes, Toulon, Hyères, La Londe-les-Maures. Elle s'adapte à la largeur de l'écran sans débordement. Sous elle, en petit : « Contours des communes : IGN, Admin Express (Licence Ouverte) ».
- **La zone en toutes lettres**, toujours visible : « Nous installons la borne de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures, sur la côte et dans les terres jusqu'à Gémenos, Cuges-les-Pins, Signes, Méounes, Belgentier, Solliès-Toucas, La Farlède et La Crau. » La carte est décorative pour les lecteurs d'écran (`aria-hidden`) : cette phrase la remplace.
- **Hors zone** : « Votre événement a lieu ailleurs ? Écrivez-nous sur WhatsApp : nous voyons ensemble ce qui est possible. », « sur WhatsApp » menant au lien WhatsApp de l'offre ; sans WhatsApp, la phrase se termine par `ContactLine`, comme dans la rubrique Contact.
- **CGV**, section de la prestation : « Zone de déplacement : celle que présente la page d'accueil, de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures. Au-delà, sur demande. » La ligne « Frais de déplacement : » garde son `[À compléter]` jusqu'à ce que le propriétaire les donne.

## 4. Construction

- **Configuration** : `config/offer.json` gagne `zone.border`, la liste ordonnée des communes du contour (noms officiels, avec leur département : `{ "name": "Méounes-lès-Montrieux", "department": "83" }`). `buildOffer` refuse une liste de moins de trois communes, avec une erreur explicite `config/offer.json`.
- **Le script `scripts/build-zone.mjs`**, lancé à la main (`npm run zone`) quand la zone change, jamais pendant la construction du site ni la publication :
  1. lit les contours et les centres des communes des Bouches-du-Rhône et du Var sur `https://geo.api.gouv.fr` (API publique de l'État, sans clé) ;
  2. trace un polygone par les centres des communes du contour, dans l'ordre, refermé **par la mer** : deux points au large, au sud de la dernière et de la première commune, pour que toutes les communes du littoral entre elles soient dedans ;
  3. retient les communes du contour et toutes celles dont le centre est à l'intérieur du polygone ;
  4. projette, simplifie (Douglas-Peucker) et arrondit les tracés jusqu'à tenir dans 80 Ko ;
  5. écrit `src/generated/zone.json` (cadre, tracé de la zone, tracé des communes voisines du cadre, position des villes repères) et affiche la liste des communes retenues, que le propriétaire vérifie.
  Le fichier généré est versionné : la construction du site n'appelle aucun service.
- **Le composant `src/components/TravelZone.astro`** dessine la carte en SVG en ligne à partir de `zone.json`, avec les couleurs du site (pas de couleur de marque en texte ; la zone en blanc translucide).
- Les fonctions de calcul (point dans un polygone, simplification, projection) sont pures, dans un module à part que le script importe et que les tests vérifient.

## 5. Tests

- Unitaires : point dans un polygone ; simplification qui garde la forme et réduit les points ; le polygone fermé par la mer garde Toulon et La Ciotat, et exclut Marseille et Brignoles (sur des données de test, pas l'appel réel) ; `buildOffer` et `zone.border`.
- Rendu du composant : la phrase exacte, la mention de la source, les sept villes repères, le lien WhatsApp hors zone (et le repli sans WhatsApp).
- e2e : la section après « Les formules », aucune requête hors du site en la faisant défiler, pas de débordement sur téléphone, contrôle d'accessibilité de l'accueil ; `zone.json` sous 80 Ko.

## 6. Hors périmètre

- Vérifier automatiquement si le lieu saisi dans une demande est dans la zone.
- Des frais de déplacement calculés au kilomètre.
