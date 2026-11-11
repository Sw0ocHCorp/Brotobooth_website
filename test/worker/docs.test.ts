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

describe("les essais automatiques à côté du site local", () => {
  // `npm run dev` et `npm run demo` servent `dist/` : les essais du navigateur, lancés aussi par `npm run deploy`,
  // construisent et servent le site ailleurs, pour ne jamais vider sous un site local ouvert les pages qu'il sert.
  const e2e = (pkg as { scripts: Record<string, string> }).scripts["dev:e2e"];

  it("construisent le site hors de dist/", () => {
    expect(e2e).toMatch(/astro build --outDir \.wrangler\/e2e\/dist\b/);
  });

  it("servent ce qu'ils ont construit", () => {
    expect(e2e).toMatch(/wrangler dev [^&]*--assets \.wrangler\/e2e\/dist\b/);
  });
});
