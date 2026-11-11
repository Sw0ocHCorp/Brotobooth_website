import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { getViteConfig } from "astro/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                IP_HASH_SALT: "sel-de-test",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          // Par défaut vitest vide les fichiers CSS, y compris `?raw` : sans cela, `tokens.css?raw` serait une chaîne vide.
          css: { include: [/public\/styles\/.*\.css/] },
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      // Les composants Astro, rendus dans Node par l'API Container d'Astro, avec une offre d'essai.
      getViteConfig({ test: { name: "components", include: ["test/components/**/*.test.ts"], environment: "node" } }),
    ],
  },
});
