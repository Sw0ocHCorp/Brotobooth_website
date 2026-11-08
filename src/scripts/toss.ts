/**
 * Les vraies photos des sections (`.shot`, de `Shot.astro`) arrivent comme les tirages du mur, une seule fois chacune :
 * quand une photo entre à l'écran, elle est lancée de son côté (`data-from`, -1 la gauche, 1 la droite) et se pose avec
 * un léger rebond à sa place de repos, inclinée de `--r`. Une photo déjà à l'écran au chargement y reste : elle est
 * arrivée. Rien n'est caché avant que ce script ne tourne, et rien ne bouge si le visiteur a demandé de réduire les
 * animations.
 */

const FLY_MS = 660; // le vol des tirages du mur, un peu plus long : les photos viennent de plus loin
const LANDING = "cubic-bezier(.34, 1.26, .64, 1)";
const FROM_DISTANCE_VW = 110; // hors de l'écran, du côté d'où elle vient
const FROM_TILT = 9; // en degrés, penchée vers son côté
const IN_VIEW = 0.12; // part de la photo à l'écran qui la fait arriver

export function initToss(): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const reported = new WeakSet<Element>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting, intersectionRatio } of entries) {
        const shot = target as HTMLElement;
        const first = !reported.has(shot);
        reported.add(shot);
        if (first && isIntersecting) observer.unobserve(shot);
        // Hors de l'écran, elle attend d'y entrer, cachée à sa place.
        else if (first) shot.classList.add("toss");
        else if (intersectionRatio >= IN_VIEW) {
          observer.unobserve(shot);
          shot.classList.remove("toss");
          const from = Number(shot.dataset.from);
          const rest = getComputedStyle(shot).getPropertyValue("--r");
          shot.animate(
            [{ transform: `translateX(${from * FROM_DISTANCE_VW}vw) rotate(${from * FROM_TILT}deg)` }, { transform: `rotate(${rest})` }],
            { duration: FLY_MS, easing: LANDING },
          );
        }
      }
    },
    { threshold: IN_VIEW },
  );
  document.querySelectorAll(".shot[data-from]").forEach((shot) => observer.observe(shot));
}
