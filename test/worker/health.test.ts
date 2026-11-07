import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("répond 404 en JSON sur une route d'API inconnue", async () => {
  const res = await exports.default.fetch("https://brotobooth.fr/api/inconnue");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
