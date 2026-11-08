import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
    include: ["test/**/*.test.ts"],
    // Par défaut vitest vide les fichiers CSS, y compris `?raw` : sans cela, `tokens.css?raw` serait une chaîne vide.
    css: { include: [/public\/styles\/.*\.css/] },
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
