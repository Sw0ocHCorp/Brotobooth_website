import { makeDeps } from "./deps";
import type { Env } from "./env";
import { handle } from "./router";

export default {
  fetch: (req, env, ctx) => handle(req, makeDeps(env), ctx),

  async scheduled() {
    // Les rappels et relances arrivent avec les tâches suivantes.
  },
} satisfies ExportedHandler<Env>;
