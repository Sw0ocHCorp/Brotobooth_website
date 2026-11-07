import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env as WorkerEnv } from "../worker/env";

// Types de `env` et de `exports` pour tous les tests : les liaisons du Worker,
// plus les migrations lues par vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../worker/index");
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
