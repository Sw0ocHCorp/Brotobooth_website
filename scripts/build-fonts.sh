#!/usr/bin/env bash
# Convertit en WOFF2 les quatre polices du site (dossier `fonts/`, sous-ensemble latin) vers `public/fonts/` :
# Unbounded 700 (boutons d'action) et 800 (titres), Outfit 400 et 600 (tout le reste). À relancer si un fichier de `fonts/` change.
# Il faut python3 avec fontTools et brotli : `python3 -m pip install fonttools brotli`.
#   bash scripts/build-fonts.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/fonts"
target_dir="$root/public/fonts"

if ! python3 -c "import fontTools, brotli" 2>/dev/null; then
  echo "python3 avec fontTools et brotli est requis : python3 -m pip install fonttools brotli" >&2
  exit 1
fi

mkdir -p "$target_dir"
for font in Unbounded-latin-700 Unbounded-latin-800 Outfit-latin-400 Outfit-latin-600; do
  if [ ! -f "$source_dir/$font.ttf" ]; then
    echo "Police introuvable : $source_dir/$font.ttf" >&2
    exit 1
  fi
  python3 -m fontTools.ttLib.woff2 compress -o "$target_dir/$font.woff2" "$source_dir/$font.ttf"
done
ls -l "$target_dir"
