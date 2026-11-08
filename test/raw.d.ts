// `import css from "…css?raw"` : le texte d'un fichier, lu par vite au moment du test.
declare module "*?raw" {
  const text: string;
  export default text;
}
