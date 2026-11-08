import { runCron } from "./cron";
import { makeDeps } from "./deps";
import type { Env } from "./env";
import { handle } from "./router";

export default {
  fetch: (req, env, ctx) => handle(req, makeDeps(env), ctx),

  scheduled: (_controller, env, ctx) => ctx.waitUntil(runCron(makeDeps(env))),
} satisfies ExportedHandler<Env>;
