import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it } from "vitest";
import TravelZone from "../../src/components/TravelZone.astro";
import zone from "../../src/generated/zone.json";
import { offer, whatsappHref, type Offer } from "../../worker/offer";

/** La section « Où nous venons », rendue avec une offre d'essai : l'offre réelle n'a pas toujours de WhatsApp. */

const WITH_WHATSAPP: Offer["contact"] = { phones: [], phone: "06 00 00 00 01", email: "bonjour@example.test", whatsapp: "+33 6 00 00 00 03", social: [] };
const WITHOUT_WHATSAPP: Offer["contact"] = { ...WITH_WHATSAPP, whatsapp: "" };

const real = offer.contact;
afterEach(() => {
  offer.contact = real;
});

async function render(contact: Offer["contact"]): Promise<string> {
  offer.contact = contact;
  return (await AstroContainer.create()).renderToString(TravelZone);
}

/** Le texte de `html` sans balises, espaces réduits. */
const text = (html: string): string => html.replace(/<svg\b[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("the travel zone section", () => {
  it("is the #zone section titled « Où nous venons »", async () => {
    const html = await render(WITH_WHATSAPP);
    expect(html).toMatch(/<section\b[^>]*\bid="zone"/);
    expect(html).toMatch(/<h2\b[^>]*>Où nous venons<\/h2>/);
  });

  it("states the zone in words, with the source of the outlines under the map", async () => {
    const plain = text(await render(WITH_WHATSAPP));
    expect(plain).toContain(
      "Nous installons la borne de Cassis et Aubagne jusqu'à Hyères et La Londe-les-Maures, sur la côte et dans les terres jusqu'à Gémenos, Cuges-les-Pins, Signes, Méounes, Belgentier, Solliès-Toucas, La Farlède et La Crau.",
    );
    expect(plain).toContain("Contours des communes : IGN, Admin Express (Licence Ouverte)");
  });

  it("draws the map hidden from screen readers, with the seven landmark names and no external reference", async () => {
    const html = await render(WITH_WHATSAPP);
    const svg = /<svg\b[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    expect(svg).toMatch(/aria-hidden="true"/);
    expect(svg).toContain(`viewBox="${zone.viewBox}"`);
    const names = ["Cassis", "Aubagne", "Signes", "Méounes", "Toulon", "Hyères", "La Londe-les-Maures"];
    expect(zone.labels.map((label) => label.name)).toEqual(names);
    for (const name of names) expect(svg).toContain(`>${name}</text>`);
    expect(html).not.toMatch(/https?:\/\/(?!wa\.me)/);
  });

  it("sends an event out of the zone to WhatsApp", async () => {
    const html = await render(WITH_WHATSAPP);
    expect(text(html)).toContain("Votre événement a lieu ailleurs ? Écrivez-nous sur WhatsApp : nous voyons ensemble ce qui est possible.");
    expect(html).toContain(`<a href="${whatsappHref(WITH_WHATSAPP.whatsapp)}">sur WhatsApp</a>`);
  });

  it("ends the out-of-zone sentence with the contact line when there is no WhatsApp", async () => {
    const html = await render(WITHOUT_WHATSAPP);
    expect(html).not.toContain("wa.me");
    expect(text(html)).toContain("Votre événement a lieu ailleurs ? Appelez-nous au 06 00 00 00 01 ou écrivez-nous à bonjour@example.test.");
  });
});
