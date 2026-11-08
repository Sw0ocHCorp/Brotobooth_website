import { describe, expect, it } from "vitest";
import fonts from "../../public/styles/fonts.css?raw";

// Les chemins des fichiers présents sous public/ : `?url` évite de lire (et de charger) leur contenu.
const files = (glob: Record<string, unknown>): string[] => Object.keys(glob).map((path) => path.replace(/^.*\/public/, ""));
const publicFonts = files(import.meta.glob("../../public/fonts/*", { query: "?url" }));
const publicMedia = files(import.meta.glob("../../public/media/*", { query: "?url" }));

describe("public/styles/fonts.css : les polices du site", () => {
  const faces = [...fonts.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => body);
  const declared = faces.map((body) => ({
    family: body.match(/font-family:\s*"([^"]+)"/)?.[1],
    weight: Number(body.match(/font-weight:\s*(\d+)/)?.[1]),
    display: body.match(/font-display:\s*(\w+)/)?.[1],
    urls: [...body.matchAll(/url\("([^"]+)"\)\s*format\("([^"]+)"\)/g)].map(([, url, format]) => ({ url, format })),
  }));

  it("ne déclare que les quatre graisses de la charte", () => {
    const pairs = declared.map(({ family, weight }) => `${family} ${weight}`).sort();
    expect(pairs).toEqual(["Outfit 400", "Outfit 600", "Unbounded 700", "Unbounded 800"]);
  });

  it("affiche le texte tout de suite, avec une police de secours", () => {
    for (const face of declared) expect(face.display).toBe("swap");
  });

  it("ne sert que du WOFF2, et chaque fichier existe", () => {
    for (const { urls } of declared) {
      expect(urls).toHaveLength(1);
      expect(urls[0].format).toBe("woff2");
      expect(urls[0].url).toMatch(/\.woff2$/);
      expect(publicFonts).toContain(urls[0].url);
    }
  });
});

describe("public/media : les médias tirés des rushs", () => {
  const stills = [
    ...Array.from({ length: 8 }, (_, i) => `tirage-${i + 1}`),
    "ecran-pose",
    "ecran-3photos",
    "ecran-format",
    "gros-tirages",
    "gros-combine",
    "borne-boucle-poster",
  ];

  it.each(stills)("%s existe en WebP", (name) => {
    expect(publicMedia).toContain(`/media/${name}.webp`);
  });

  it("garde la vidéo de la borne", () => {
    expect(publicMedia).toContain("/media/borne-boucle.mp4");
  });
});
