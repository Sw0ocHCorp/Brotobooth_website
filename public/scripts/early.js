// Chargé de façon bloquante dans le <head> de l'accueil, avant le premier affichage : il dit au CSS ce que la page va
// montrer. `js` : les scripts de la page tournent (la barre part claire au-dessus de l'ouverture, sans attendre le sien).
// `intro` : l'ouverture va jouer, son contenu reste caché jusqu'à ce qu'elle le révèle. Elle joue une fois par visite
// (retenu dans le stockage de session ; s'il est interdit, elle joue), jamais si le visiteur a demandé de réduire les
// animations, ni quand il arrive directement sur une section.
(() => {
  const html = document.documentElement;
  const SEEN = "opening-seen";
  // Si le script de l'ouverture n'a pas commencé dans ce délai (réseau coupé), la page s'affiche sans elle.
  const FALLBACK_MS = 3000;

  html.classList.add("js");
  let seen = false;
  try {
    seen = sessionStorage.getItem(SEEN) === "1";
  } catch {}
  if (seen || location.hash || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  html.classList.add("intro");
  try {
    sessionStorage.setItem(SEEN, "1");
  } catch {}
  setTimeout(() => {
    if (!document.getElementById("logo-intro")) html.classList.remove("intro");
  }, FALLBACK_MS);
})();
