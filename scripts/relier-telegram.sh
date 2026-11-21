#!/usr/bin/env bash
# Relie le bot Telegram au site : les boutons « Accepter » et « Refuser » des alertes répondent ensuite.
#   bash scripts/relier-telegram.sh
# Le script demande le jeton du bot au clavier, sans l'afficher, crée un nouveau secret de liaison qu'il n'affiche
# jamais, l'enregistre chez Cloudflare (TELEGRAM_WEBHOOK_SECRET), puis déclare l'adresse du site à Telegram avec ce même
# secret. Ni le jeton ni le secret ne vont dans un fichier. À relancer après tout changement d'adresse ou de secret ;
# s'il s'arrête en route, le relancer suffit.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-https://brotobooth.fr}"

# Le jeton vient de TELEGRAM_BOT_TOKEN quand un autre script l'a déjà demandé (`scripts/groupe-telegram.sh`) ; sinon il se
# saisit au clavier, et sans terminal (bouton « Run », tâche automatique), rien n'est modifié.
token="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$token" ]; then
  if [ ! -t 0 ]; then
    echo "À lancer dans un terminal : le jeton du bot se saisit au clavier. Rien n'a été modifié." >&2
    exit 1
  fi
  read -rs -p "Jeton du bot (rien ne s'affiche quand vous collez), puis Entrée : " token
  echo
fi
if [ -z "$token" ]; then
  echo "Aucun jeton saisi : rien n'a été modifié." >&2
  exit 1
fi

secret="$(openssl rand -hex 32)"
printf %s "$secret" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
TELEGRAM_BOT_TOKEN="$token" TELEGRAM_WEBHOOK_SECRET="$secret" BASE_URL="$BASE_URL" node scripts/set-telegram-webhook.mjs
