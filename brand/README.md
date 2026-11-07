# Kit de marque BrotoBooth

Le logo « Sunset · le check » : BROTOBOOTH en Unbounded ExtraBold, les deux
O de BOOTH soudés et coupés par une fente penchée à 24° (le O de gauche est
rose, celui de droite orange).

Chaque version existe en SVG (sans taille, il s'adapte) et en PNG de
2000 px de large, fond transparent sauf les icônes. Les SVG ne contiennent
que des tracés pleins (ni masque, ni détourage, ni contour) : ils
s'affichent pareil partout, chez l'imprimeur comme chez le brodeur.
`nuit` va sur un fond sombre (lettres blanches), `clair` sur un fond clair
(lettres noir nuit).

## Les fichiers

Tous s'appellent `brotobooth-<nom>.svg` / `.png`.

| Nom | À quoi il sert |
|---|---|
| `principal-nuit`, `principal-clair` | Le mot sur une ligne : pages web larges, en-têtes, carte de visite, réseaux. |
| `empile-nuit`, `empile-clair` | BROTO au-dessus de BOOTH : accueil de la borne, galerie, formats carrés. |
| `principal-blanc`, `principal-noir`, `empile-blanc`, `empile-noir` | Une seule couleur (blanc ou noir nuit) : gravure, broderie, tampon, impression à une encre. La fente suffit à séparer les deux O. |
| `fete-nuit`, `fete-clair` | Le principal avec son relief rose et orange et les traits d'impact : visuels de réseaux sociaux, grands écrans. |
| `signature-nuit`, `signature-clair` | Le principal, trois barres et « LOCATION DE PHOTOBOOTHS » : carte de visite, bas des bandes photo. |
| `icone-nuit`, `icone-blanc` | Les deux O soudés sur un carré arrondi noir nuit, ou blanc : photo de profil, application, autocollant. |
| `icone-une-couleur` | L'icône en une couleur : carré noir nuit, O blancs. |
| `icone-simple-nuit`, `icone-simple-blanc` | L'icône avec une fente deux fois plus large : pour 32 px et moins. |

## Les couleurs

| Rôle | Fond nuit | Fond clair | Une couleur |
|---|---|---|---|
| Lettres | blanc `#FFFFFF` | noir nuit `#0B0B0F` | l'encre |
| O de gauche | rose `#F2559B` | rose `#F2559B` | l'encre |
| O de droite | orange `#FF8A3D` | orange `#FF8A3D` | l'encre |
| Fente | vide | vide | vide |

La mention de la signature est en gris `#B9B9C6` sur nuit et `#55555F` sur
clair.

## Zone de protection

Autour de chaque version, laisser un vide au moins égal à la moitié de la
hauteur des capitales.

## Tailles minimales

| Version | À l'écran | À l'impression |
|---|---|---|
| Principal | 120 px de large | 30 mm |
| Empilé | 64 px de large | 15 mm |
| En dessous | l'icône ; l'icône simplifiée sous 32 px | |

## Refaire ces fichiers

Le logo n'est dessiné qu'à un seul endroit, `ui/styles/Logo.py`. Ne pas
retoucher les fichiers à la main : `python3 tools/build_logo.py` les écrit
tous (ce dossier, les deux SVG de `ui/assets/` et le logo en ligne des pages
de `deploy/`), identiques d'une fois sur l'autre.
