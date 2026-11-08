/**
 * Le mur de l'ouverture (`#wall`), réglé comme `ui/widgets/PhotoWall.py` (dépôt de la borne) : les vrais tirages sont
 * lancés sur la page comme sur une table. Ils arrivent d'un bord, se posent avec un léger rebond, restent, puis l'un
 * d'eux file vers un bord pendant que son remplaçant vient prendre sa place. Jamais de fondu : un tirage est toujours
 * opaque, tout se fait en mouvement. Chacun garde sa couche : celui qui part glisse sous ceux qui le recouvrent.
 *
 * Seule la transformation est animée ; un tirage posé n'a plus d'animation et ne coûte rien. Un tirage n'est lancé qu'une
 * fois son image décodée. Le renouvellement s'arrête quand l'ouverture n'est plus à l'écran ou que l'onglet est caché.
 * Si le visiteur a demandé de réduire les animations, les tirages sont posés d'emblée et le mur ne bouge plus.
 */

const FLY_IN_MS = 560; // vol à l'arrivée
const FLY_OUT_MS = 640; // vol au départ
const LANDING = "cubic-bezier(.34, 1.34, .64, 1)"; // se pose et se cale, d'un léger rebond
const TAKEOFF = "cubic-bezier(.6, -.2, .74, .05)"; // un petit recul, puis il file
const MAX_TILT = 14; // inclinaison d'un tirage posé, en degrés
const FLIGHT_SPIN = 16; // rotation de plus, au plus, pendant le vol
const SIDE_ENTRY_CHANCE = 0.7; // part des tirages qui arrivent par un côté ; les autres, par le haut ou le bas
const ENTRY_SPREAD = 0.1; // décalage du point d'entrée le long du bord, en part de l'écran : des trajectoires obliques
const TICK_MS = 280; // écart entre deux tirages au remplissage
const RENEW_MS = 2800; // un tirage renouvelé toutes les 3 s environ
const REPLACE_JITTER = 1.5; // décalage du remplaçant autour de la place libérée, en % de l'ouverture

/** Les tirages `tirage-1` à `tirage-8` de `public/media/`, pris tour à tour : les remplacer ne touche pas au code. */
const PHOTOS = 8;
/** Moins large que 760 px, l'écran est un téléphone : 8 tirages, plus grands. */
const PHONE_MAX_WIDTH = 760;
/** Les places des tirages, en % de la largeur et de la hauteur de l'ouverture. */
const SPOTS = {
  wide: [[12, 24], [36, 12], [65, 16], [90, 28], [8, 72], [32, 86], [62, 84], [90, 74], [50, 50]],
  tall: [[20, 12], [80, 18], [12, 36], [88, 44], [18, 70], [82, 66], [30, 90], [75, 90]],
} as const;
/** La largeur d'un tirage, en % de celle de l'ouverture (`cqw`). */
const WIDTH = { wide: [26, 32], tall: [52, 62] } as const;

type Spot = readonly [x: number, y: number];

interface Print {
  element: HTMLElement;
  /** Sa place, d'où le remplaçant ne s'écarte que de REPLACE_JITTER : le mur ne dérive pas au fil des remplacements. */
  spot: Spot;
  tilt: number;
  layer: number;
}

const between = (min: number, max: number) => min + Math.random() * (max - min);

let started = false;
let photo = 0;

/** Remplit le mur puis le renouvelle ; sans effet la deuxième fois, ou sans `#wall` dans la page. */
export function startWall(): void {
  const wall = document.getElementById("wall");
  const hero = document.getElementById("hero");
  if (started || !wall || !hero) return;
  started = true;

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shape = innerWidth < PHONE_MAX_WIDTH ? "tall" : "wide";
  const [narrowest, widest] = WIDTH[shape];
  const prints: Print[] = [];

  /** Le tirage hors de l'écran, du côté de sa place : d'où il arrive, où il repart. */
  const outside = ({ spot: [x, y], tilt }: Print) => {
    const far = Math.max(innerWidth, innerHeight);
    const side = Math.random() < SIDE_ENTRY_CHANCE;
    const dx = side ? (x < 50 ? -far : far) : between(-ENTRY_SPREAD, ENTRY_SPREAD) * innerWidth;
    const dy = side ? between(-ENTRY_SPREAD, ENTRY_SPREAD) * innerHeight : y < 50 ? -far : far;
    return `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${tilt + between(-FLIGHT_SPIN, FLIGHT_SPIN)}deg)`;
  };
  const resting = ({ tilt }: Print) => `translate(-50%, -50%) rotate(${tilt}deg)`;

  /** Lance un tirage vers sa place, à `jitter` près, dans la couche `layer`, une fois son image décodée. */
  const toss = async (spot: Spot, layer: number, jitter = 0) => {
    const image = new Image();
    image.alt = "";
    image.src = `/media/tirage-${(photo++ % PHOTOS) + 1}.webp`;
    try {
      await image.decode();
    } catch {
      return;
    }
    const element = document.createElement("div");
    const print: Print = { element, spot, tilt: between(-MAX_TILT, MAX_TILT), layer };
    const [rest, from] = [resting(print), outside(print)];
    element.className = "print";
    element.style.setProperty("--w", `${between(narrowest, widest)}cqw`);
    element.style.left = `${spot[0] + between(-jitter, jitter)}%`;
    element.style.top = `${spot[1] + between(-jitter, jitter)}%`;
    element.style.zIndex = String(layer);
    element.style.transform = rest;
    element.append(image);
    wall.append(element);
    prints.push(print);
    if (!still) element.animate([{ transform: from }, { transform: rest }], { duration: FLY_IN_MS, easing: LANDING });
  };

  /** Un tirage part depuis sa couche ; son remplaçant arrive au même instant vers la place libérée. */
  const renew = () => {
    const [leaving] = prints.splice(Math.floor(Math.random() * prints.length), 1);
    if (!leaving) return;
    const away = outside(leaving);
    leaving.element
      .animate([{ transform: leaving.element.style.transform }, { transform: away }], { duration: FLY_OUT_MS, easing: TAKEOFF, fill: "forwards" })
      .finished.then(() => leaving.element.remove(), () => {});
    void toss(leaving.spot, leaving.layer, REPLACE_JITTER);
  };

  const spots = SPOTS[shape];
  if (still) {
    spots.forEach((spot, index) => void toss(spot, index + 1));
    return;
  }
  spots.forEach((spot, index) => setTimeout(() => void toss(spot, index + 1), index * TICK_MS));

  let heroInView = true;
  new IntersectionObserver((entries) => entries.forEach((entry) => (heroInView = entry.isIntersecting))).observe(hero);
  const renewWhileSeen = () => {
    if (heroInView && !document.hidden) renew();
  };
  setTimeout(() => setInterval(renewWhileSeen, RENEW_MS), spots.length * TICK_MS + FLY_IN_MS);
}
