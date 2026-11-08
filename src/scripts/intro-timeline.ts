/**
 * L'ouverture de l'accueil comme fonction pure du temps, reprise de `ui/widgets/BrandLogo.py` (dépôt de la borne) : à un
 * instant `t`, en secondes, elle dit de combien BOOTH est ouvert, jusqu'où vont les traits d'impact et à quel point ils
 * sont visibles, où en est le logo de son trajet vers l'en-tête, ce qui reste de son relief, et à quel point le contenu
 * est apparu. `logo-intro.ts` ne fait que la dessiner. Sans DOM : elle est testée telle quelle.
 */

export const INTRO_SECONDS = 2;
const OPEN_HOLD = 0.3; // le logo est là d'emblée, BOOTH ouvert, et attend
const IMPACT = 0.8; // les moitiés se rejoignent : traits et rebond commencent
const REBOUND_PEAK = 0.875; // les moitiés sont au plus loin du rebond
const REBOUND_END = 0.95;
const BURST_FULL = 1.05; // les traits ont toute leur longueur...
const BURST_GONE = 1.3; // ...et se sont effacés
export const TRAVEL_START = 1.4; // le logo part vers l'en-tête ; le mur de tirages commence
const REVEAL_START = 1.6; // le contenu apparaît, jusqu'à INTRO_SECONDS

/** L'ouverture de BOOTH et son rebond, en unités du logo, pour chacune des deux moitiés. */
const OPENING = 300;
const REBOUND = 20;
/** Les traits d'impact partent du bout de la fente : de BURST_INNER, ils s'allongent jusqu'à BURST_OUTER unités. */
export const BURST_INNER = 90;
const BURST_OUTER = 215;
/** L'opacité du logo une fois posé dans l'en-tête. */
const REST_OPACITY = 0.9;

export interface IntroFrame {
  /** De combien chaque moitié de BOOTH est écartée de sa place, en unités du logo. */
  opening: number;
  /** 0 grand et centré, 1 posé dans l'en-tête. */
  travel: number;
  /** La part du relief festif : 1 en grand, 0 à plat. */
  relief: number;
  opacity: number;
  /** Jusqu'où vont les traits d'impact depuis le bout de la fente, en unités du logo. */
  burstOuter: number;
  burstOpacity: number;
  /** L'opacité du contenu, caché pendant l'ouverture. */
  reveal: number;
}

/** Où en est `t` de `start` à `end`, entre 0 et 1. */
const progress = (t: number, start: number, end: number) => Math.min(Math.max((t - start) / (end - start), 0), 1);
const inCubic = (p: number) => p ** 3;
const outCubic = (p: number) => 1 - (1 - p) ** 3;
const inQuad = (p: number) => p * p;
const outQuad = (p: number) => 1 - (1 - p) ** 2;
const inOutCubic = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);

/** L'ouverture à `t` secondes, ramené à sa durée. */
export function introFrame(t: number): IntroFrame {
  t = Math.min(Math.max(t, 0), INTRO_SECONDS);
  let opening: number;
  if (t < IMPACT) opening = OPENING * (1 - inCubic(progress(t, OPEN_HOLD, IMPACT)));
  else if (t < REBOUND_PEAK) opening = REBOUND * outQuad(progress(t, IMPACT, REBOUND_PEAK));
  else opening = REBOUND * (1 - inQuad(progress(t, REBOUND_PEAK, REBOUND_END)));
  const travel = inOutCubic(progress(t, TRAVEL_START, INTRO_SECONDS));
  return {
    opening,
    travel,
    relief: 1 - travel,
    opacity: 1 - (1 - REST_OPACITY) * travel,
    burstOuter: BURST_INNER + (BURST_OUTER - BURST_INNER) * outCubic(progress(t, IMPACT, BURST_FULL)),
    burstOpacity: t < IMPACT ? 0 : 1 - progress(t, BURST_FULL, BURST_GONE),
    reveal: progress(t, REVEAL_START, INTRO_SECONDS),
  };
}
