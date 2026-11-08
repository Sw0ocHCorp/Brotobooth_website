import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import guide from "../../docs/essai-local.md?raw";

/** Ce que le guide d'essai promet à qui l'ouvre sur une machine neuve : de quoi lancer `npm run demo`. */

describe("prérequis de l'essai local", () => {
  it("package.json exige Node 24 ou plus", () => {
    expect((pkg as { engines?: { node?: string } }).engines).toEqual({ node: ">=24" });
  });

  it("le guide donne les prérequis (Node 24, npm install) avant la première commande", () => {
    const beforeFirstCommand = guide.slice(0, guide.indexOf("npm run demo"));
    expect(beforeFirstCommand).toMatch(/Node(\.js)? 24/);
    expect(beforeFirstCommand).toContain("npm install");
  });
});
