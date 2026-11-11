// `import css from "…css?raw"` : le texte d'un fichier, lu par vite au moment du test.
declare module "*?raw" {
  const text: string;
  export default text;
}

// `parseEnv` de `node:util`, le seul morceau de Node que les tests emploient : le lecteur de `.env` de Vite et du contrôle d'avant publication.
declare module "node:util" {
  export function parseEnv(content: string): Record<string, string>;
}

// Un composant Astro, rendu par les essais de `test/components` : tsc ne lit pas les fichiers `.astro`, Vite les compile.
declare module "*.astro" {
  const component: import("astro/runtime/server/index.js").AstroComponentFactory;
  export default component;
}
