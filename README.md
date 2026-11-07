# Identité de la marque (DA « Sunset »)

- `logo-blanc.svg` / `logo-noir.svg` : le logo empilé (BROTO au-dessus
  de BOOTH, fente de 24° dans les deux O, O rose puis orange, à plat) —
  lettres blanches pour le thème sombre, noir nuit pour le thème clair.
  La galerie web les sert tels quels. Ils ne contiennent que des
  `<path>` pleins (ni masque ni `clipPath`) et ne se retouchent pas à la
  main : ils sont **produits** par `tools/build_logo.py`, depuis les
  formes de `ui/styles/Logo.py` (la géométrie, les couleurs, les
  versions). Pour changer le logo : modifier `Logo.py`, puis relancer
  `python3 tools/build_logo.py` sur le PC — il réécrit ces deux SVG, le
  logo en ligne de `deploy/index.html` et `deploy/overlay_upload.html`
  (pas non plus à retoucher à la main) et le kit de `docs/brand/`.
- **La borne ne lit aucun fichier du logo** : elle le dessine elle-même
  (`ui/widgets/BrandLogo.py`, d'après `Logo.py`), net à toutes les
  tailles, et le joue en deux secondes à chaque retour sur l'accueil
  avant qu'il ne prenne sa place dans le coin. Plus de PNG ici, plus
  de QtSvg à prévoir.
- Le kit de marque (principal, empilé, fête, signature, icônes ; fonds
  nuit et clair, une couleur ; SVG + PNG de 2000 px) est dans
  `docs/brand/`, avec ses règles d'usage.
- `fonts/` : deux familles, chacune sous licence OFL, en sous-ensemble
  latin. **Unbounded** (`OFL-Unbounded.txt`), la police même des lettres
  du logo : ExtraBold (800, la graisse du logo) pour les grands titres,
  700 pour les titres de fiche et le texte des boutons d'action. Le
  logo en tire aussi ses lettres (800, et 600 pour la mention), lues
  par `Logo.py` ; le 400 n'est plus demandé nulle part. **Outfit**
  (`OFL-Outfit.txt`), en 400 et 600 : tous les autres mots, c'est la
  police par défaut de l'application. La borne les charge au démarrage
  (`ui/styles/Theme.py`), la galerie les sert aux téléphones des
  invités.
