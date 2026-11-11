import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, it } from "vitest";
import Contact from "../../src/components/Contact.astro";
import Footer from "../../src/components/Footer.astro";
import { offer, telHref, type Offer } from "../../worker/offer";

/**
 * Les moyens de contact de la section « Contact » et du pied de page, rendus avec une offre d'essai : l'offre réelle n'a
 * pas encore de numéro ni d'adresse, et rien de ce qui s'affichera alors ne doit partir sans avoir été vu.
 */

type Contact = Offer["contact"];
type Link = { href?: string; name?: string; text: string };

const FULL: Contact = {
  phones: [
    { name: "Ana", number: "06 00 00 00 01" },
    { name: "Ben", number: "+33 6 00 00 00 02" },
  ],
  phone: "06 00 00 00 01",
  email: "bonjour@example.test",
  social: ["https://www.instagram.com/photomaton_test/", "https://exemple.fr/page"],
};
const EMPTY: Contact = { phones: [], phone: "", email: "", social: [] };

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

/** Les liens de `html`, avec leur cible, leur nom accessible donné à part (`aria-label`) et leur texte. */
const links = (html: string): Link[] =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, text]) => ({
    href: /\bhref="([^"]*)"/.exec(attributes)?.[1],
    name: /\baria-label="([^"]*)"/.exec(attributes)?.[1],
    text: text.trim(),
  }));

const instagram = { href: "https://www.instagram.com/photomaton_test/", name: "@photomaton_test sur Instagram", text: "@photomaton_test" };
const website = { href: "https://exemple.fr/page", name: "exemple.fr", text: "exemple.fr" };
const mail = { href: "mailto:bonjour@example.test", name: undefined, text: "bonjour@example.test" };

describe("the footer", () => {
  it("gives each founder's number, the e-mail and each network, short", async () => {
    expect(links(zone(await render(Footer, FULL), "address"))).toEqual([
      { href: telHref("06 00 00 00 01"), name: undefined, text: "Ana · 06 00 00 00 01" },
      { href: telHref("+33 6 00 00 00 02"), name: undefined, text: "Ben · +33 6 00 00 00 02" },
      mail,
      instagram,
      website,
    ]);
  });

  it("gives no contact at all when none is filled in", async () => {
    expect(zone(await render(Footer, EMPTY), "address")).toBe("");
  });
});

describe("the contact section", () => {
  it("calls each founder by name, then gives the e-mail and each network, short", async () => {
    expect(links(zone(await render(Contact, FULL), "ul", "means"))).toEqual([
      { href: telHref("06 00 00 00 01"), name: undefined, text: "Appeler Ana" },
      { href: telHref("+33 6 00 00 00 02"), name: undefined, text: "Appeler Ben" },
      mail,
      instagram,
      website,
    ]);
  });

  it("gives no direct means when none is filled in", async () => {
    expect(zone(await render(Contact, EMPTY), "ul", "means")).toBe("");
  });

  it("follows a failed send and the connection limit with how to reach us, never the anti-robot refusal", async () => {
    const html = await render(Contact, FULL);
    const problems = Object.fromEntries([...html.matchAll(/<p data-problem="(\w+)"[^>]*>([\s\S]*?)<\/p>/g)].map(([, kind, text]) => [kind, links(text)]));
    const call = { href: telHref("06 00 00 00 01"), name: undefined, text: "06 00 00 00 01" };
    expect(problems).toEqual({ failed: [call, mail], bot: [], too_many: [call, mail] });
  });

  it("without JavaScript, sends the visitor to the e-mail address, only if there is one", async () => {
    expect(links(zone(await render(Contact, FULL), "p", "no-js"))).toEqual([mail]);
    const empty = zone(await render(Contact, EMPTY), "p", "no-js");
    expect(empty).toContain("Le formulaire ne s'affiche pas sur votre navigateur.");
    expect(links(empty)).toEqual([]);
  });
});
