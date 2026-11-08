import { defineConfig, devices } from "@playwright/test";
import { ORIGIN } from "./e2e/seed";

const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * Le parcours est joué sur Chromium et WebKit, à la taille d'un téléphone et d'un ordinateur. Une seule base
 * locale sert à tous les tests : ils se suivent (`workers: 1`) et chacun nettoie ce qu'il a créé.
 * `testDir` est limité à `e2e/` : sans cela, Playwright chargerait aussi les fichiers de Vitest (`test/`).
 */
const browsers = [
  { name: "chromium", device: devices["Desktop Chrome"] },
  { name: "webkit", device: devices["Desktop Safari"] },
];
const screens = [
  { name: "telephone", viewport: PHONE },
  { name: "ordinateur", viewport: DESKTOP },
];

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: ORIGIN, trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev:e2e",
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: browsers.flatMap(({ name, device }) =>
    screens.map(({ name: screen, viewport }) => ({
      name: `${name}-${screen}`,
      use: { ...device, viewport },
    })),
  ),
});
