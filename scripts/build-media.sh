#!/usr/bin/env bash
# Tire de `/home/sw0och/Spot_pub_Brotobooth` (les rushs et le film du spot) tous les médias du site, vers `public/media/` :
#   tirage-1 à tirage-8  les tirages du mur de l'accueil (WebP, 1000 px) ;
#   ecran-*              les écrans de la borne : le compte à rebours, les trois photos, le choix du format (WebP, 1400 px) ;
#   gros-*               les tirages en main et le combiné, pour les sections de l'accueil (WebP, 1500 px) ;
#   borne-boucle.mp4     la vidéo de la réservation : muette, 3 Mo au plus, en boucle aller-retour ;
#   borne-boucle-poster  son image fixe (économie de données, avant le premier affichage).
# Rien ne vient d'une banque d'images. Remplacer un tirage par une photo de soirée : copier le fichier sous le même nom.
# Le script se relance sans risque : il réécrit chaque fichier, et seulement une fois son encodage réussi.
#   bash scripts/build-media.sh            (autre dossier de sources : SPOT_PUB_DIR=/chemin bash scripts/build-media.sh)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="${SPOT_PUB_DIR:-/home/sw0och/Spot_pub_Brotobooth}"
target_dir="$root/public/media"

WEBP_QUALITY=78
# Le film du spot est en 16:9 ; le cadre qui garde l'écran de la borne et les tirages en main, sans la barre de titre.
SPOT=spot_reseau_brotobooth.mp4
SPOT_FRAME=1408:1054:132:12
# Les rushs de la GoPro sont en 4K 16:9 ; le cadre 4:3 centré sur la borne.
RUSH_FRAME=2880:2160:480:0
# La vidéo : l'extrait de GX011249 (début et durée en secondes), son ralenti, sa largeur, sa cadence et son poids maximal en Ko.
LOOP_SOURCE=GX011249.MP4
LOOP_START=9
LOOP_LENGTH=6.5
LOOP_SLOWDOWN=1.5
LOOP_WIDTH=960
LOOP_FPS=20
LOOP_MAX_KB=3072
LOOP_CRF_FIRST=24
LOOP_CRF_LAST=40
POSTER_WIDTH=1280

if [ ! -d "$source_dir" ]; then
  echo "Dossier des sources introuvable : $source_dir" >&2
  echo "Indiquez-le avec SPOT_PUB_DIR=/chemin/du/dossier bash scripts/build-media.sh" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg est requis (avec libwebp et libx264)." >&2
  exit 1
fi

mkdir -p "$target_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ffmpeg_quiet() { ffmpeg -hide_banner -loglevel error -nostdin -y "$@"; }

source_path() {
  if [ ! -f "$source_dir/$1" ]; then
    echo "Source introuvable : $source_dir/$1" >&2
    exit 1
  fi
  echo "$source_dir/$1"
}

# still NOM SOURCE INSTANT LARGEUR [RECADRAGE] : une image du film à l'instant donné, recadrée puis réduite à la largeur donnée.
still() {
  local name=$1 file=$2 at=$3 width=$4 crop=${5:-}
  local filters="scale=$width:-2"
  [ -n "$crop" ] && filters="crop=$crop,$filters"
  ffmpeg_quiet -ss "$at" -i "$(source_path "$file")" -frames:v 1 -vf "$filters" -c:v libwebp -quality "$WEBP_QUALITY" "$work/$name.webp"
  mv -f "$work/$name.webp" "$target_dir/$name.webp"
  echo "$name.webp"
}

# loop : l'extrait ralenti, suivi de lui-même à l'envers sans répéter l'image de la jointure, au plus léger CRF qui tient dans le poids permis.
loop() {
  local out="$work/borne-boucle.mp4" crf size_kb
  # L'aller est l'extrait entier ; le retour va de l'avant-dernière image à la deuxième, pour que ni le sommet ni la reprise ne marque un arrêt.
  local filters="scale=$LOOP_WIDTH:-2,split[forward][back];[back]trim=start_frame=1,reverse,trim=start_frame=1[return];[forward][return]concat=n=2:v=1:a=0,setpts=$LOOP_SLOWDOWN*PTS,fps=$LOOP_FPS,format=yuv420p"
  for ((crf = LOOP_CRF_FIRST; crf <= LOOP_CRF_LAST; crf++)); do
    ffmpeg_quiet -ss "$LOOP_START" -t "$LOOP_LENGTH" -i "$(source_path "$LOOP_SOURCE")" -filter_complex "$filters" -an \
      -c:v libx264 -preset slow -crf "$crf" -profile:v high -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact \
      -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv "$out"
    size_kb=$(( ($(stat -c %s "$out") + 1023) / 1024 ))
    if [ "$size_kb" -le "$LOOP_MAX_KB" ]; then
      mv -f "$out" "$target_dir/borne-boucle.mp4"
      echo "borne-boucle.mp4 (${size_kb} Ko, CRF $crf)"
      return
    fi
  done
  echo "borne-boucle.mp4 dépasse ${LOOP_MAX_KB} Ko même à CRF $LOOP_CRF_LAST." >&2
  exit 1
}

still tirage-1 "$SPOT" 300 1000 "$SPOT_FRAME"
still tirage-2 GX011237.MP4 1.2 1000 "$RUSH_FRAME"
still tirage-3 GX011244.MP4 2.8 1000 "$RUSH_FRAME"
still tirage-4 GX011249.MP4 2.7 1000 "$RUSH_FRAME"
still tirage-5 GX011249.MP4 10.7 1000 "$RUSH_FRAME"
still tirage-6 GX011245.MP4 6.8 1000 "$RUSH_FRAME"
still tirage-7 GX011250.MP4 1.5 1000 "$RUSH_FRAME"
still tirage-8 GX011241.MP4 2.2 1000 "$RUSH_FRAME"

still ecran-pose "$SPOT" 250 1400
still ecran-3photos "$SPOT" 260 1400
still ecran-format "$SPOT" 275 1400

still gros-tirages GX011244.MP4 2.8 1500
still gros-combine GX011249.MP4 10.7 1500

loop
still borne-boucle-poster "$LOOP_SOURCE" "$LOOP_START" "$POSTER_WIDTH"
