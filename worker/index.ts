import type { Env } from "./env";

export default {
  async fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled() {
    // Les rappels et relances arrivent avec les tâches suivantes.
  },
} satisfies ExportedHandler<Env>;
