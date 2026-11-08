import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://brotobooth.fr",
  // Les scripts restent des fichiers : la politique de sécurité prévue (`script-src 'self'`) refuse un script écrit
  // dans le HTML, or Astro y intègre par défaut tout script (et toute feuille de style) de moins de 4 Ko.
  vite: { build: { assetsInlineLimit: 0 } },
});
