import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it } from "vitest";
import TravelZone from "../../src/components/TravelZone.astro";
import zone from "../../src/generated/zone.json";
import { offer, type Offer } from "../../worker/offer";

/** La section « Notre zone de déplacement », rendue avec une offre d'essai qui a WhatsApp : la section n'en propose pas pour autant. */

const WITH_WHATSAPP: Offer["contact"] = { phones: [], phone: "06 00 00 00 01", email: "bonjour@example.test", whatsapp: "+33 6 00 00 00 03", social: [] };

const real = offer.contact;
afterEach(() => {
  offer.contact = real;
});

async function render(contact: Offer["contact"]): Promise<string> {
  offer.contact = contact;
  return (await AstroContainer.create()).renderToString(TravelZone);
}

/** Le texte de `html` sans balises, espaces réduits. */
const text = (html: string): string => html.replace(/<svg\b[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

describe("the travel zone section", () => {
  it("is the #zone section titled « Notre zone de déplacement »", async () => {
    const html = await render(WITH_WHATSAPP);
    expect(html).toMatch(/<section\b[^>]*\bid="zone"/);
    expect(html).toMatch(/<h2\b[^>]*>Notre zone de déplacement<\/h2>/);
  });

  it("says the zone is the one drawn, names no town, and dates the outlines under the map", async () => {
    const plain = text(await render(WITH_WHATSAPP));
    expect(plain).toContain("Nous installons la borne partout dans la zone dessinée sur la carte, sur la côte comme dans les terres.");
    for (const { name } of offer.zone.border) expect(plain).not.toContain(name);
    const [year, month] = zone.updated.split("-").map(Number);
    const asOf = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, 1));
    expect(plain).toContain(`Contours des communes : IGN, Admin Express (Licence Ouverte), ${asOf}`);
    expect(asOf).toMatch(/^[a-zéû]+ \d{4}$/);
  });

  it("draws the map as an image named by its aria-label, with the landmarks written from zone.json and no external reference", async () => {
    const html = await render(WITH_WHATSAPP);
    const svg = /<svg\b[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    expect(svg).toMatch(/role="img"/);
    expect(svg).not.toMatch(/aria-hidden/);
    expect(svg).toMatch(/aria-label="Carte de la zone où nous installons la borne : de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures, [^"]*La Crau\."/);
    expect(svg).toContain(`viewBox="${zone.viewBox}"`);
    const names = ["Cassis", "Aubagne", "Signes", "Méounes", "Toulon", "Hyères", "La Londe-les-Maures"];
    expect(zone.labels.map((label) => label.name)).toEqual(names);
    for (const name of names) expect(svg).toContain(`>${name}</text>`);
    expect(svg.match(/<g class="small"/g)).toHaveLength(zone.labels.filter((label) => label.small).length);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("offers nothing outside the zone, even when the offer has WhatsApp", async () => {
    const html = await render(WITH_WHATSAPP);
    expect(text(html)).not.toContain("ailleurs");
    expect(html).not.toMatch(/<a\b/);
  });
});
