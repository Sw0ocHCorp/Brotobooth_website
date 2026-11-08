import parts from "../generated/logo-parts.json";
import { BURST_INNER, INTRO_SECONDS, TRAVEL_START, introFrame, type IntroFrame } from "./intro-timeline";
import { startWall } from "./photo-wall";

/**
 * L'ouverture de l'accueil, une fois par visite, comme sur l'écran d'accueil de la borne (`ui/widgets/BrandLogo.py`) :
 * le logo coupé, grand et centré avec BOOTH ouvert, ses moitiés qui claquent l'une contre l'autre, les traits d'impact,
 * puis le logo qui file se poser sur celui de la barre en perdant son relief, et le contenu qui apparaît. `early.js` a
 * décidé qu'elle joue (`html.intro`). Elle se dessine dans une surcouche unique, `#logo-intro`, qui atterrit exactement
 * sur le logo plat de la barre (mesuré) et est retirée à la fin : le logo de la barre prend le relais. Un toucher ou un
 * défilement la termine aussitôt. Le mur de tirages commence quand le logo part vers la barre, ou tout de suite si
 * l'ouverture ne joue pas ; si les morceaux du logo ne sont pas utilisables, la page montre simplement le logo plat.
 *
 * Les positions ne sont mesurées qu'au début, et si la fenêtre change : à chaque image, la surcouche ne change que de
 * transformation et d'opacité, et les morceaux du logo, de décalage.
 */

const SVG = "http://www.w3.org/2000/svg";
/** Le logo en grand : la plus grande taille qui tient dans 70 % de la largeur et 45 % de la hauteur de l'écran. */
const BIG_WIDTH = 0.7;
const BIG_HEIGHT = 0.45;
/** Le relief festif, en unités du logo : la copie rose décalée d'autant vers le bas et la droite, l'orange du double. */
const RELIEF = 35;
/** Les trois traits d'impact, sous la fente inclinée de SLIT degrés : leur écart et leur épaisseur au plus. */
const SLIT = 24;
const BURST_FAN = 34;
const BURST_WIDTH = 46;
const INK = "#FFFFFF";
const ROSE = "#F2559B";
const ORANGE = "#FF8A3D";
/** Après un toucher, la surcouche attend le clic qui le termine, au plus ce délai, pour qu'il n'active rien dessous. */
const TAP_MS = 1000;

const PATHS = ["broto", "left", "right", "rose", "orange"] as const;
const usable = PATHS.every((name) => parts[name]?.startsWith("M")) && parts.tip?.length === 2 && parts.tip.every(Number.isFinite);
/** La direction de chaque trait depuis le bout de la fente : vers le bas, de part et d'autre de la fente. */
const BURST_DIRECTIONS = [SLIT + 180 + BURST_FAN, SLIT + 180, SLIT + 180 - BURST_FAN].map((degrees) => {
  const angle = (degrees * Math.PI) / 180;
  return [Math.sin(angle), -Math.cos(angle)] as const;
});

/** Le logo coupé, dans l'ordre où la borne le peint : le relief, BROTO, puis chaque moitié de BOOTH et les traits. */
function buildLogo(viewBox: string) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", viewBox);
  const path = (d: string, fill: string) => `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
  const relief = (fill: string) => `<g>${path(parts.broto, fill)}${path(parts.left, fill)}${path(parts.right, fill)}</g>`;
  svg.innerHTML =
    relief(ORANGE) +
    relief(ROSE) +
    path(parts.broto, INK) +
    `<g>${path(parts.left, INK)}${path(parts.rose, ROSE)}</g>` +
    `<g>${path(parts.orange, ORANGE)}${path(parts.right, INK)}</g>` +
    `<g fill="none" stroke-linecap="round"><line stroke="${ROSE}"/><line stroke="${INK}"/><line stroke="${ORANGE}"/></g>`;
  const [orangeRelief, roseRelief, , left, right, burst] = [...svg.children] as SVGElement[];
  return { svg, reliefs: [[orangeRelief, 2], [roseRelief, 1]] as const, left, right, burst, lines: [...burst.children] };
}

export function startIntro(): void {
  const html = document.documentElement;
  const flat = document.querySelector<SVGSVGElement>(".bar .logo svg");
  const viewBox = flat?.getAttribute("viewBox");
  if (!html.classList.contains("intro") || !flat || !viewBox || !usable) {
    html.classList.remove("intro");
    startWall();
    return;
  }

  const { svg, reliefs, left, right, burst, lines } = buildLogo(viewBox);
  const box = flat.viewBox.baseVal;
  const reveals = [...document.querySelectorAll<HTMLElement>(".reveal")];
  const cover = document.createElement("div");
  cover.id = "logo-intro";
  cover.setAttribute("aria-hidden", "true");
  cover.append(svg);
  document.body.append(cover);

  // Le logo en grand et centré au départ, le logo de la barre à l'arrivée : la taille de la surcouche est celle du départ.
  let big = { x: 0, y: 0, width: 0, height: 0 };
  let end = big;
  const measure = () => {
    const screen = cover.getBoundingClientRect();
    const scale = Math.min((BIG_WIDTH * screen.width) / box.width, (BIG_HEIGHT * screen.height) / box.height);
    const [width, height] = [box.width * scale, box.height * scale];
    big = { x: (screen.width - width) / 2, y: (screen.height - height) / 2, width, height };
    end = flat.getBoundingClientRect();
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
  };

  const draw = (frame: IntroFrame) => {
    const mix = (from: number, to: number) => from + (to - from) * frame.travel;
    const scale = mix(big.width, end.width) / big.width;
    svg.style.transform = `translate(${mix(big.x, end.x)}px, ${mix(big.y, end.y)}px) scale(${scale})`;
    svg.style.opacity = String(frame.opacity);
    // Le relief glisse sous les lettres à mesure que le logo part, chaque copie avec les moitiés de BOOTH.
    const shift = RELIEF * frame.relief;
    for (const [group, rank] of reliefs) {
      group.style.display = frame.relief > 0 ? "" : "none";
      const offset = rank * shift;
      const [broto, half, otherHalf] = group.children;
      broto.setAttribute("transform", `translate(${offset} ${offset})`);
      half.setAttribute("transform", `translate(${offset - frame.opening} ${offset})`);
      otherHalf.setAttribute("transform", `translate(${offset + frame.opening} ${offset})`);
    }
    left.setAttribute("transform", `translate(${-frame.opening} 0)`);
    right.setAttribute("transform", `translate(${frame.opening} 0)`);
    burst.setAttribute("opacity", String(frame.burstOpacity));
    const width = Math.max(Math.min(BURST_WIDTH, frame.burstOuter - BURST_INNER), 0.01);
    const [x, y] = parts.tip;
    lines.forEach((line, index) => {
      const [dx, dy] = BURST_DIRECTIONS[index];
      line.setAttribute("x1", String(x + dx * BURST_INNER));
      line.setAttribute("y1", String(y + dy * BURST_INNER));
      line.setAttribute("x2", String(x + dx * frame.burstOuter));
      line.setAttribute("y2", String(y + dy * frame.burstOuter));
      line.setAttribute("stroke-width", String(width));
    });
    if (frame.reveal > 0) for (const element of reveals) element.style.opacity = String(frame.reveal);
  };

  let playing = true;
  let raf = 0;
  let started: number | undefined;
  /** L'ouverture est finie : le contenu est là, le logo de la barre aussi, le mur part s'il n'est pas parti. */
  const finish = () => {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    removeEventListener("scroll", leave);
    removeEventListener("resize", measure);
    for (const element of reveals) element.style.removeProperty("opacity");
    html.classList.remove("intro");
    startWall();
  };
  const leave = () => {
    finish();
    cover.remove();
  };
  const tick = (now: number) => {
    started ??= now;
    const t = (now - started) / 1000;
    if (t >= INTRO_SECONDS) return leave();
    draw(introFrame(t));
    if (t >= TRAVEL_START) startWall();
    raf = requestAnimationFrame(tick);
  };

  // Un toucher la termine, sans rien activer d'autre : la surcouche, vidée, reste le temps du clic qui le suit.
  cover.addEventListener(
    "pointerdown",
    () => {
      finish();
      svg.remove();
      for (const type of ["click", "pointercancel"]) cover.addEventListener(type, () => cover.remove());
      setTimeout(() => cover.remove(), TAP_MS);
    },
    { once: true },
  );
  addEventListener("scroll", leave, { passive: true });
  addEventListener("resize", measure);

  measure();
  draw(introFrame(0));
  raf = requestAnimationFrame(tick);
}
