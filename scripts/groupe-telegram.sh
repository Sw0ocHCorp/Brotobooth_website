#!/usr/bin/env bash
# Trouve l'identifiant du groupe Telegram où le bot a été ajouté, pour y annoncer les réservations à plusieurs personnes.
#   bash scripts/groupe-telegram.sh
# Le bot est d'abord débranché du site (Telegram ne donne ses messages qu'ainsi), puis rebranché à la fin, quoi qu'il
# arrive, avec un nouveau secret de liaison (`scripts/relier-telegram.sh`). Pendant ce temps, une minute environ, les
# boutons des alertes ne répondent pas ; un appui fait alors arrivera au site au rebranchement. Le jeton se saisit au
# clavier, sans s'afficher, et ne va dans aucun fichier.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -t 0 ]; then
  echo "À lancer dans un terminal : le jeton du bot se saisit au clavier. Rien n'a été modifié." >&2
  exit 1
fi

read -rs -p "Jeton du bot (rien ne s'affiche quand vous collez), puis Entrée : " TELEGRAM_BOT_TOKEN
echo
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Aucun jeton saisi : rien n'a été modifié." >&2
  exit 1
fi
export TELEGRAM_BOT_TOKEN

node scripts/telegram-groups.mjs pause
# À partir d'ici, le bot est rebranché à la sortie du script, même s'il s'arrête en route.
trap 'echo; echo "Rebranchement du bot sur le site…"; bash scripts/relier-telegram.sh' EXIT

read -r -p "Une fois le message envoyé dans le groupe, appuyez ici sur Entrée (sans rien taper) : " _
node scripts/telegram-groups.mjs list
