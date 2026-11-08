import { afterEach, describe, expect, it } from "vitest";
import { ALL_TEMPLATES } from "../../worker/notifications";
import { offer } from "../../worker/offer";
import type { Booking } from "../../worker/repository";
import { renderEmail, renderTelegram } from "../../worker/templates";
import { T0, newBooking } from "../support";

const ctx = { baseUrl: "https://brotobooth.fr" };
const CLIENT_TEMPLATES = ALL_TEMPLATES.filter((t) => t.startsWith("client_"));
const OWNER_TEMPLATES = ALL_TEMPLATES.filter((t) => t.startsWith("owner_"));

const booking = (over: Partial<Booking> = {}): Booking => ({
  ...newBooking({ id: "b-42", token: "jeton0123456789abcdef", plan: "formule-2" }),
  created_at: T0,
  updated_at: T0,
  ...over,
});

const hostile = { client_name: 'A<b>&"C', venue: "Salle, n°3; étage\n2 🎉", message: "<script>x</script>" };

describe("champs libres", () => {
  it.each(ALL_TEMPLATES)("%s échappe les champs libres", (t) => {
    const tg = renderTelegram(t, booking(hostile), ctx).html;
    expect(tg).not.toContain("<script>");
    expect(tg).not.toMatch(/<b>&/);
    const m = renderEmail(t, booking(hostile), ctx);
    expect(m.html).not.toContain("<script>");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it.each(ALL_TEMPLATES)("%s n'emploie que <b> et <a> côté Telegram", (t) => {
    const { html } = renderTelegram(t, booking(hostile), ctx);
    expect(html.replace(/<\/?b>|<a href="[^"<>]*">|<\/a>/g, "")).not.toMatch(/[<>]/);
  });

  it("garde le texte brut des e-mails tel que saisi, et l'échappe dans la version HTML", () => {
    const m = renderEmail("owner_new_request", booking(hostile), ctx);
    expect(m.text).toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(m.html).toContain("A&lt;b&gt;&amp;&quot;C");
  });

  it("ne laisse aucun saut de ligne dans l'objet, même quand une valeur en contient", () => {
    for (const t of ALL_TEMPLATES) {
      const { subject } = renderEmail(t, booking({ ...hostile, event_date: "2026-12-19" }), ctx);
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject.length).toBeGreaterThan(0);
    }
  });
});

describe("messages au client", () => {
  it.each(CLIENT_TEMPLATES)("%s ne contient aucun vocabulaire interne", (t) => {
    const { text, subject, html } = renderEmail(t, booking(), ctx);
    expect(subject + text + html).not.toMatch(/bloqu|valid|statut|pending|awaiting|hold/i);
  });

  it.each([
    ["client_received", "Votre demande pour le samedi 19 décembre"],
    ["client_refused", "Votre demande pour le samedi 19 décembre"],
    ["client_deposit_link", "Votre acompte pour le samedi 19 décembre"],
    ["client_deposit_reminder", "Plus que 24 h pour votre acompte"],
    ["client_confirmed", "C'est confirmé pour le samedi 19 décembre"],
    ["client_released", "Votre demande pour le samedi 19 décembre"],
    ["client_cancelled", "Votre réservation du samedi 19 décembre"],
    ["client_d7", "Votre photobooth arrive dans une semaine"],
  ])("%s a pour objet « %s »", (t, subject) => {
    expect(renderEmail(t, booking({ event_date: "2026-12-19" }), ctx).subject).toBe(subject);
  });

  it("salue le client par son nom, et sans nom salue quand même", () => {
    expect(renderEmail("client_received", booking(), ctx).text.startsWith("Bonjour Camille Martin,")).toBe(true);
    expect(renderEmail("client_received", booking(), ctx).html).toContain("Bonjour Camille Martin,");
    expect(renderEmail("client_received", booking({ client_name: null }), ctx).text.startsWith("Bonjour,")).toBe(true);
  });

  it("l'accusé de réception annonce le délai de réponse et qu'il n'y a rien à payer", () => {
    const { text } = renderEmail("client_received", booking(), ctx);
    expect(text).toContain(`${offer.reviewHours} h`);
    expect(text).toMatch(/rien à payer/i);
  });

  it("le lien de paiement contient le jeton, jamais l'identifiant", () => {
    const m = renderEmail("client_deposit_link", booking(), ctx);
    expect(m.text).toContain(`https://brotobooth.fr/acompte/${booking().token}`);
    expect(m.html).toContain(`href="https://brotobooth.fr/acompte/${booking().token}"`);
    expect(m.text + m.html + m.subject).not.toContain(booking().id);
  });

  it("le lien de paiement donne le montant, la date limite à l'heure de Paris et la date confirmée au paiement", () => {
    const { text } = renderEmail("client_deposit_link", booking(), ctx);
    expect(text).toMatch(/450,00 €/);
    expect(text).toContain("jusqu'au mardi 10 novembre à 11 h");
    expect(text).toMatch(/confirmée dès que l'acompte est payé/);
  });

  it("le lien de paiement s'écrit sans date limite quand la réservation n'en a pas", () => {
    const { text } = renderEmail("client_deposit_link", booking({ hold_until: null }), ctx);
    expect(text).not.toContain("jusqu'au");
  });

  it("le rappel porte le lien et la date limite", () => {
    const { text } = renderEmail("client_deposit_reminder", booking(), ctx);
    expect(text).toContain(`https://brotobooth.fr/acompte/${booking().token}`);
    expect(text).toContain("mardi 10 novembre à 11 h");
  });

  it("formate les dates et les montants en français", () => {
    expect(renderEmail("client_confirmed", booking({ event_date: "2026-12-19", price_cents: 150000 }), ctx).text)
      .toMatch(/samedi 19 décembre[\s\S]*1\s?500,00\s?€/);
  });

  it("la confirmation récapitule la formule, le lieu, l'acompte et le solde restant", () => {
    const { text } = renderEmail("client_confirmed", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(text).toContain("Formule 2");
    expect(text).toContain("Domaine des Pins, Lyon");
    expect(text).toContain("18h-02h");
    expect(text).toMatch(/Acompte réglé : 450,00 €/);
    expect(text).toMatch(/Solde restant : 1\s?050,00 €/);
  });

  it("le rappel de J-7 donne le lieu, les horaires et le solde restant", () => {
    const { text } = renderEmail("client_d7", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(text).toContain("Domaine des Pins, Lyon");
    expect(text).toContain("18h-02h");
    expect(text).toMatch(/Solde restant : 1\s?050,00 €/);
  });

  it("n'annonce plus de solde quand il est déjà réglé", () => {
    const { text } = renderEmail("client_d7", booking({ balance_paid_at: T0 }), ctx);
    expect(text).toMatch(/Solde restant : 0,00 €/);
  });

  it("le refus s'excuse et propose de choisir une autre date", () => {
    const { text } = renderEmail("client_refused", booking(), ctx);
    expect(text).toMatch(/excus/);
    expect(text).toContain("https://brotobooth.fr/reserver");
  });

  it("l'avis de libération explique comment refaire une demande", () => {
    const { text } = renderEmail("client_released", booking(), ctx);
    expect(text).toMatch(/n'est plus réservée/);
    expect(text).toContain("https://brotobooth.fr/reserver");
  });

  it("l'avis d'annulation annonce l'annulation", () => {
    expect(renderEmail("client_cancelled", booking(), ctx).text).toMatch(/annulée/);
  });

  describe("coordonnées de l'offre", () => {
    const saved = { ...offer.contact };
    afterEach(() => {
      Object.assign(offer.contact, saved);
    });

    it("ajoutent le téléphone et l'adresse quand l'offre les renseigne", () => {
      Object.assign(offer.contact, { phone: "06 12 34 56 78", email: "contact@example.test" });
      for (const t of CLIENT_TEMPLATES) {
        const m = renderEmail(t, booking(), ctx);
        expect(m.text).toContain("06 12 34 56 78");
        expect(m.text).toContain("contact@example.test");
        expect(m.html).toContain('href="tel:0612345678"');
        expect(m.html).toContain('href="mailto:contact@example.test"');
      }
    });

    it("n'ajoutent que ce que l'offre renseigne", () => {
      Object.assign(offer.contact, { phone: "", email: "contact@example.test" });
      const m = renderEmail("client_refused", booking(), ctx);
      expect(m.text).toContain("contact@example.test");
      expect(m.html).not.toContain("tel:");
    });

    it("n'ajoutent rien quand l'offre ne renseigne rien", () => {
      Object.assign(offer.contact, { phone: "", email: "" });
      expect(renderEmail("client_refused", booking(), ctx).text).not.toMatch(/question/i);
    });

    it("échappent ce que l'offre renseigne", () => {
      Object.assign(offer.contact, { phone: "", email: '"><script>x</script>@example.test' });
      expect(renderEmail("client_refused", booking(), ctx).html).not.toContain("<script>");
    });
  });
});

describe("messages au propriétaire", () => {
  it("l'alerte de demande porte les trois boutons", () => {
    expect(renderTelegram("owner_new_request", booking(), ctx).buttons!.flat().map((b) => b.text)).toEqual([
      "Valider",
      "Refuser",
      "Ajuster le prix",
    ]);
  });

  it("les boutons de l'alerte renvoient à la réservation par son identifiant", () => {
    expect(renderTelegram("owner_new_request", booking(), ctx).buttons!.flat()).toEqual([
      { text: "Valider", data: "v:b-42" },
      { text: "Refuser", data: "r:b-42" },
      { text: "Ajuster le prix", url: "https://brotobooth.fr/admin#b-42" },
    ]);
  });

  it("les autres messages n'ont pas de bouton", () => {
    for (const t of ALL_TEMPLATES.filter((t) => t !== "owner_new_request")) {
      expect(renderTelegram(t, booking(), ctx).buttons).toBeUndefined();
    }
  });

  it("l'alerte de demande donne la date, le type, la formule, le lieu, le client et le téléphone", () => {
    const { html } = renderTelegram("owner_new_request", booking({ event_date: "2026-12-19" }), ctx);
    for (const part of ["samedi 19 décembre", "Mariage", "Formule 2", "Domaine des Pins, Lyon", "Camille Martin", "0601020304"]) {
      expect(html).toContain(part);
    }
  });

  it("Telegram ne reçoit ni l'adresse e-mail ni le message du client, l'e-mail oui", () => {
    const tg = renderTelegram("owner_new_request", booking(), ctx).html;
    expect(tg).not.toContain("camille@example.test");
    expect(tg).not.toContain("Un fond rose");
    const mail = renderEmail("owner_new_request", booking(), ctx);
    expect(mail.text).toContain("camille@example.test");
    expect(mail.text).toContain("Un fond rose, si possible.");
    expect(mail.text).toContain("https://brotobooth.fr/admin#b-42");
  });

  it("l'alerte de demande rappelle l'échéance de la réponse", () => {
    expect(renderTelegram("owner_new_request", booking(), ctx).html).toContain("mardi 10 novembre à 11 h");
  });

  it("le message en gras de Telegram reprend l'objet de l'e-mail", () => {
    const b = booking({ event_date: "2026-12-19" });
    const subject = renderEmail("owner_new_request", b, ctx).subject;
    expect(renderTelegram("owner_new_request", b, ctx).html.startsWith(`<b>${subject}</b>`)).toBe(true);
  });

  it.each(["owner_d7", "owner_d1"])("%s donne le lieu, les horaires, le téléphone et le solde restant", (t) => {
    const { html } = renderTelegram(t, booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    for (const part of ["Domaine des Pins, Lyon", "18h-02h", "0601020304"]) expect(html).toContain(part);
    expect(html).toMatch(/Solde restant<\/b> : 1\s?050,00 €/);
  });

  it("owner_deposit_paid donne le client, l'acompte et le solde restant", () => {
    const { html } = renderTelegram("owner_deposit_paid", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(html).toContain("Camille Martin");
    expect(html).toMatch(/450,00 €/);
    expect(html).toMatch(/1\s?050,00 €/);
  });

  it("owner_released nomme le client et la date libérée", () => {
    const { html } = renderTelegram("owner_released", booking({ event_date: "2026-12-19" }), ctx);
    expect(html).toContain("Camille Martin");
    expect(html).toContain("samedi 19 décembre");
  });

  it("owner_review_reminder nomme le client et renvoie à la demande", () => {
    const m = renderEmail("owner_review_reminder", booking(), ctx);
    expect(m.text).toContain("Camille Martin");
    expect(m.text).toContain("https://brotobooth.fr/admin#b-42");
  });

  it("owner_late_payment donne le client, la date, l'acompte et demande un remboursement par Stripe", () => {
    const m = renderEmail("owner_late_payment", booking({ event_date: "2026-12-19", deposit_cents: 45_000 }), ctx);
    expect(m.text).toContain("Camille Martin");
    expect(m.text).toContain("samedi 19 décembre");
    expect(m.text).toMatch(/450,00 €/);
    expect(m.text).toMatch(/Stripe/);
    expect(m.text).toMatch(/rembours/i);
    expect(renderTelegram("owner_late_payment", booking(), ctx).html).toMatch(/rembours/i);
  });

  it("owner_email_failed nomme le client et donne de quoi le joindre", () => {
    const { html } = renderTelegram("owner_email_failed", booking(), ctx);
    expect(html).toContain("Camille Martin");
    expect(html).toContain("0601020304");
    expect(html).toContain("camille@example.test");
  });

  it("garde les liens de Telegram sur les adresses du site", () => {
    const { html } = renderTelegram("owner_deposit_paid", booking(), ctx);
    expect(html).toContain('<a href="https://brotobooth.fr/admin#b-42">');
  });
});

describe("owner_digest", () => {
  const upcoming = [
    booking({ id: "b1", event_date: "2026-12-19", status: "confirmed", client_name: "Camille Martin" }),
    booking({ id: "b2", event_date: "2027-01-09", status: "awaiting_deposit", client_name: "Lou Durand" }),
    booking({ id: "b3", event_date: "2027-02-13", status: "pending_review", client_name: "Sam Petit" }),
  ];

  it("liste chaque prestation à venir avec sa date, son client et son état", () => {
    const { html } = renderTelegram("owner_digest", null, { ...ctx, upcoming });
    expect(html).toContain("samedi 19 décembre 2026");
    expect(html).toContain("samedi 9 janvier 2027");
    expect(html).toContain("samedi 13 février 2027");
    expect(html).toMatch(/Camille Martin[^\n]*confirmée/);
    expect(html).toMatch(/Lou Durand[^\n]*acompte attendu/);
    expect(html).toMatch(/Sam Petit[^\n]*à traiter/);
    expect(html).toMatch(/3 prestations à venir/);
  });

  it("donne la même liste complète par e-mail", () => {
    const m = renderEmail("owner_digest", null, { ...ctx, upcoming });
    expect(m.subject).toBe("Point du lundi : les prestations à venir");
    for (const name of ["Camille Martin", "Lou Durand", "Sam Petit"]) expect(m.text).toContain(name);
    expect(m.html).toContain("samedi 13 février 2027");
  });

  it("annonce une semaine vide en toutes lettres", () => {
    for (const c of [ctx, { ...ctx, upcoming: [] }]) {
      expect(renderTelegram("owner_digest", null, c).html).toContain("Aucune prestation à venir");
      expect(renderEmail("owner_digest", null, c).text).toContain("Aucune prestation à venir");
    }
  });

  it("écrit « 1 prestation » au singulier", () => {
    expect(renderTelegram("owner_digest", null, { ...ctx, upcoming: [upcoming[0]] }).html).toMatch(/1 prestation à venir/);
  });

  it("échappe les clients et les lieux", () => {
    const { html } = renderTelegram("owner_digest", null, { ...ctx, upcoming: [booking(hostile)] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("A&lt;b&gt;&amp;&quot;C");
    expect(renderEmail("owner_digest", null, { ...ctx, upcoming: [booking(hostile)] }).html).not.toMatch(/A<b>/);
  });

  it("tient dans les 4096 caractères de Telegram et renvoie le reste à l'administration", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      booking({
        id: `b${i}`,
        event_date: new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10),
        status: "confirmed",
        venue: "Un lieu au nom assez long pour remplir la ligne",
      }),
    );
    const tg = renderTelegram("owner_digest", null, { ...ctx, upcoming: many }).html;
    expect(tg.length).toBeLessThanOrEqual(4096);
    expect(tg).toMatch(/… et \d+ autres, à retrouver dans l&#39;administration\./);
    expect(tg).toContain("120 prestations à venir");
    // L'e-mail, lui, garde la copie complète.
    const mail = renderEmail("owner_digest", null, { ...ctx, upcoming: many });
    expect(mail.text).toContain("jeudi 29 avril 2027");
    expect(mail.text).not.toContain("… et ");
  });
});

describe("modèles inconnus", () => {
  it("lève sur un modèle inconnu", () => {
    expect(() => renderEmail("inconnu", booking(), ctx)).toThrow(/inconnu/);
    expect(() => renderTelegram("inconnu", booking(), ctx)).toThrow(/inconnu/);
  });

  it("lève sans réservation, sauf pour le point du lundi", () => {
    for (const t of ALL_TEMPLATES.filter((t) => t !== "owner_digest")) {
      expect(() => renderEmail(t, null, ctx)).toThrow();
      expect(() => renderTelegram(t, null, ctx)).toThrow();
    }
    expect(() => renderEmail("owner_digest", null, ctx)).not.toThrow();
  });

  it("rend les dix-sept modèles, sur les deux canaux", () => {
    expect(OWNER_TEMPLATES.length + CLIENT_TEMPLATES.length).toBe(ALL_TEMPLATES.length);
    for (const t of ALL_TEMPLATES) {
      expect(renderEmail(t, booking(), ctx).text.length).toBeGreaterThan(0);
      expect(renderTelegram(t, booking(), ctx).html.length).toBeGreaterThan(0);
    }
  });
});
