import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it } from "vitest";
import Contact from "../../src/components/Contact.astro";
import Footer from "../../src/components/Footer.astro";
import { offer, telHref, whatsappHref, type Offer } from "../../worker/offer";

/**
 * Les moyens de contact de la section « Contact » et du pied de page, rendus avec une offre d'essai : l'offre réelle n'a
 * pas encore de numéro ni d'adresse, et rien de ce qui s'affichera alors ne doit partir sans avoir été vu.
 */

type Contact = Offer["contact"];
type Link = { href?: string; name?: string; title?: string; icon?: boolean; text: string };

const FULL: Contact = {
  phones: [
    { name: "Ana", number: "06 00 00 00 01" },
    { name: "Ben", number: "+33 6 00 00 00 02" },
  ],
  phone: "06 00 00 00 01",
  email: "bonjour@example.test",
  whatsapp: "+33 6 00 00 00 03",
  social: ["https://www.instagram.com/photomaton_test/", "https://exemple.fr/page"],
};
const EMPTY: Contact = { phones: [], phone: "", email: "", whatsapp: "", social: [] };
const REAL_ICONS = [whatsappHref(offer.contact.whatsapp), ...offer.contact.social.filter((url) => url.includes("instagram.com"))];

const real = offer.contact;
afterEach(() => {
  offer.contact = real;
});

async function render(component: typeof Footer, contact: Contact): Promise<string> {
  offer.contact = contact;
  return (await AstroContainer.create()).renderToString(component);
}

/** Le premier élément `<tag class="…">` de `html` dont la classe contient `className`, avec son contenu ; `""` s'il n'y en a pas. */
const zone = (html: string, tag: string, className = ""): string =>
  new RegExp(`<${tag}\\b[^>]*${className && `class="[^"]*\\b${className}\\b[^"]*"`}[^>]*>[\\s\\S]*?</${tag}>`).exec(html)?.[0] ?? "";

/**
 * Les liens de `html`, avec leur cible, leur nom accessible donné à part (`aria-label`), leur info-bulle, leur texte visible
 * et, pour une icône (SVG caché aux lecteurs d'écran, à la couleur du texte), `icon: true` ; un lien sans icône n'a pas la clé.
 */
const links = (html: string): Link[] =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, content]) => {
    const svg = /<svg\b[^>]*>[\s\S]*?<\/svg>/.exec(content)?.[0];
    if (svg) {
      expect(svg).toMatch(/aria-hidden="true"/);
      expect(svg).toMatch(/fill="currentColor"/);
    }
    return {
      href: /\bhref="([^"]*)"/.exec(attributes)?.[1],
      name: /\baria-label="([^"]*)"/.exec(attributes)?.[1],
      ...(svg && { title: /\btitle="([^"]*)"/.exec(attributes)?.[1], icon: true }),
      text: content.replace(/<svg\b[\s\S]*?<\/svg>/g, "").trim(),
    };
  });

const instagram = {
  href: "https://www.instagram.com/photomaton_test/",
  name: "@photomaton_test sur Instagram",
  title: "@photomaton_test sur Instagram",
  icon: true,
  text: "",
};
const whatsapp = { href: "https://wa.me/33600000003", name: "Nous écrire sur WhatsApp", title: "Nous écrire sur WhatsApp", icon: true, text: "" };
const website = { href: "https://exemple.fr/page", name: "exemple.fr", text: "exemple.fr" };
const mail = { href: "mailto:bonjour@example.test", name: undefined, text: "bonjour@example.test" };
const hasMail = (html: string): boolean => html.includes("mailto:");

describe("the footer", () => {
  it("gives each founder's number, then WhatsApp and Instagram as icons alone, and a network without an icon its short text", async () => {
    expect(links(zone(await render(Footer, FULL), "address"))).toEqual([
      { href: telHref("06 00 00 00 01"), name: undefined, text: "Ana · 06 00 00 00 01" },
      { href: telHref("+33 6 00 00 00 02"), name: undefined, text: "Ben · +33 6 00 00 00 02" },
      whatsapp,
      instagram,
      website,
    ]);
  });

  it("never gives the e-mail address, even when one is filled in", async () => {
    expect(hasMail(await render(Footer, FULL))).toBe(false);
  });

  it("gives no contact at all when none is filled in", async () => {
    expect(zone(await render(Footer, EMPTY), "address")).toBe("");
  });

  it("with the real offer, gives WhatsApp and Instagram icons only", async () => {
    const found = links(zone(await (await AstroContainer.create()).renderToString(Footer), "address"));
    expect(found.map(({ href, icon, text }) => [href, icon, text])).toEqual(REAL_ICONS.map((href) => [href, true, ""]));
  });
});

describe("the contact section", () => {
  it("calls each founder by name, then gives WhatsApp and Instagram as icons alone, and a network without an icon its short text", async () => {
    expect(links(zone(await render(Contact, FULL), "ul", "means"))).toEqual([
      { href: telHref("06 00 00 00 01"), name: undefined, text: "Appeler Ana" },
      { href: telHref("+33 6 00 00 00 02"), name: undefined, text: "Appeler Ben" },
      whatsapp,
      instagram,
      website,
    ]);
  });

  it("gives no e-mail link among the direct means", async () => {
    expect(hasMail(zone(await render(Contact, FULL), "ul", "means"))).toBe(false);
  });

  it("with the real offer, gives WhatsApp and Instagram icons only", async () => {
    const found = links(zone(await (await AstroContainer.create()).renderToString(Contact), "ul", "means"));
    expect(found.map(({ href, icon, text }) => [href, icon, text])).toEqual(REAL_ICONS.map((href) => [href, true, ""]));
  });

  it("gives no direct means when none is filled in", async () => {
    expect(zone(await render(Contact, EMPTY), "ul", "means")).toBe("");
  });

  const problemLinks = (html: string) =>
    Object.fromEntries([...html.matchAll(/<p data-problem="(\w+)"[^>]*>([\s\S]*?)<\/p>/g)].map(([, kind, text]) => [kind, links(text)]));
  const onWhatsapp = { href: whatsapp.href, name: undefined, text: "sur WhatsApp" };

  it("follows a failed send and the connection limit with WhatsApp, never the anti-robot refusal", async () => {
    expect(problemLinks(await render(Contact, FULL))).toEqual({ failed: [onWhatsapp], bot: [], too_many: [onWhatsapp] });
  });

  it("without WhatsApp, follows them with how to reach us as the booking page does", async () => {
    const call = { href: telHref("06 00 00 00 01"), name: undefined, text: "06 00 00 00 01" };
    expect(problemLinks(await render(Contact, { ...FULL, whatsapp: "" }))).toEqual({ failed: [call, mail], bot: [], too_many: [call, mail] });
  });

  it("never gives the e-mail address anywhere in the section when WhatsApp is set", async () => {
    const html = await render(Contact, FULL);
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("bonjour@example.test");
  });

  it("without JavaScript, sends the visitor to WhatsApp", async () => {
    const noJs = zone(await render(Contact, FULL), "p", "no-js");
    expect(links(noJs)).toEqual([onWhatsapp]);
    expect(noJs).toContain("Écrivez-nous");
  });

  it("without JavaScript and without WhatsApp, sends the visitor to the e-mail address, only if there is one", async () => {
    const without = { ...FULL, whatsapp: "" };
    expect(links(zone(await render(Contact, without), "p", "no-js"))).toEqual([mail]);
    const empty = zone(await render(Contact, EMPTY), "p", "no-js");
    expect(empty).toContain("Le formulaire ne s'affiche pas sur votre navigateur.");
    expect(links(empty)).toEqual([]);
  });
});
