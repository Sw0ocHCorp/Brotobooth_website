import { afterEach, describe, expect, it } from "vitest";
import { escapeHtml } from "../../worker/html";
import { ALL_TEMPLATES } from "../../worker/notifications";
import { offer } from "../../worker/offer";
import type { Booking } from "../../worker/repository";
import { renderEmail, renderTelegram } from "../../worker/templates";
import { SECOND_PLAN, T0, newBooking } from "../support";

const ctx = { baseUrl: "https://brotobooth.fr" };
/** L'espace insécable de la typographie française, devant « : ; ! ? » et entre un nombre et son unité. */
const NBSP = "\u00a0";
const CLIENT_TEMPLATES = ALL_TEMPLATES.filter((t) => t.startsWith("client_"));
const OWNER_TEMPLATES = ALL_TEMPLATES.filter((t) => t.startsWith("owner_"));

const booking = (over: Partial<Booking> = {}): Booking => ({
  ...newBooking({ id: "b-42", token: "jeton0123456789abcdef" }),
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

describe("la date de la prestation", () => {
  // Un horizon de 24 mois : « 19 décembre » seul ne dirait pas laquelle des deux années.
  const sunday = booking({ event_date: "2027-12-19" });

  it.each(ALL_TEMPLATES.filter((t) => t !== "owner_digest"))("%s écrit toujours l'année", (t) => {
    const mail = renderEmail(t, sunday, ctx);
    for (const text of [mail.subject + mail.text, renderTelegram(t, sunday, ctx).html]) {
      expect(text).toContain("dimanche 19 décembre 2027");
      expect(text).not.toMatch(/décembre(?! 2027)/);
    }
  });

  it("le point du lundi n'écrit l'année qu'une fois par prestation", () => {
    const { html } = renderTelegram("owner_digest", null, { ...ctx, upcoming: [sunday] });
    expect(html).toContain("dimanche 19 décembre 2027");
    expect(html).not.toMatch(/2027 2027/);
  });
});

describe("messages au client", () => {
  // Le vocabulaire du propriétaire, et celui que le client ne peut pas relier à sa réservation : « délai » seul ne dit pas
  // lequel, « solde » et « échéance » sont des mots de comptable, « libérer » une date est un geste de l'administration.
  it.each(CLIENT_TEMPLATES)("%s ne contient aucun vocabulaire interne", (t) => {
    for (const b of [booking(), booking({ deposit_paid_at: T0 })]) {
      const { text, subject, html } = renderEmail(t, b, ctx);
      expect(subject + text + html).not.toMatch(/bloqu|valid|statut|pending|awaiting|hold|prestation|solde|échéance|libér|délai|en attente/i);
    }
  });

  it.each([
    ["client_received", "Nous avons bien reçu votre demande pour le samedi 19 décembre 2026"],
    ["client_refused", "Désolés, nous ne pouvons pas être là le samedi 19 décembre 2026"],
    ["client_deposit_link", "Bonne nouvelle : nous pouvons être là le samedi 19 décembre 2026"],
    ["client_deposit_reminder", "Plus que 24 h pour régler l'acompte du samedi 19 décembre 2026"],
    ["client_confirmed", "C'est confirmé pour le samedi 19 décembre 2026"],
    ["client_released", "Votre date du samedi 19 décembre 2026 n'est plus gardée pour vous"],
    ["client_unanswered", "Désolés de ne pas avoir répondu à temps à votre demande du samedi 19 décembre 2026"],
    ["client_cancelled", "Votre réservation du samedi 19 décembre 2026 est annulée"],
    ["client_d7", "Votre photobooth arrive dans une semaine, le samedi 19 décembre 2026"],
  ])("%s a pour objet « %s »", (t, subject) => {
    expect(renderEmail(t, booking({ event_date: "2026-12-19" }), ctx).subject).toBe(subject);
  });

  // Dans la boîte de réception, le client distingue la bonne nouvelle de la mauvaise, et ses deux demandes l'une de l'autre.
  it("chaque message au client a son propre objet, qui nomme la date", () => {
    const subjects = CLIENT_TEMPLATES.map((t) => renderEmail(t, booking({ event_date: "2026-12-19" }), ctx).subject);
    expect(new Set(subjects).size).toBe(CLIENT_TEMPLATES.length);
    for (const subject of subjects) expect(subject).toContain("samedi 19 décembre 2026");
  });

  it.each([
    ["client_refused", "Bien cordialement,"],
    ["client_unanswered", "Bien cordialement,"],
    ["client_cancelled", "Bien cordialement,"],
    ["client_received", "À bientôt,"],
    ["client_deposit_link", "À bientôt,"],
    ["client_confirmed", "À bientôt,"],
    ["client_d7", "À bientôt,"],
  ])("%s se termine par « %s »", (t, closing) => {
    expect(renderEmail(t, booking(), ctx).text.endsWith(`${closing}\nL'équipe Brotobooth`)).toBe(true);
  });

  it("salue le client par son nom, et sans nom salue quand même", () => {
    expect(renderEmail("client_received", booking(), ctx).text.startsWith("Bonjour Camille Martin,")).toBe(true);
    expect(renderEmail("client_received", booking(), ctx).html).toContain("Bonjour Camille Martin,");
    expect(renderEmail("client_received", booking({ client_name: null }), ctx).text.startsWith("Bonjour,")).toBe(true);
  });

  it("l'accusé de réception annonce le délai de réponse, qu'il n'y a rien à payer, et ce qui suit", () => {
    const { text } = renderEmail("client_received", booking(), ctx);
    expect(text).toContain(`sous ${offer.reviewHours}${NBSP}h`);
    expect(text).toMatch(/rien à payer/i);
    expect(text).toContain("un lien pour régler l'acompte et confirmer votre date");
  });

  // `/reserver` promet « un e-mail avec le récapitulatif de votre demande » : il doit redire ce que le client a saisi.
  it("l'accusé de réception récapitule la date, la formule, l'événement, les horaires et le lieu de la demande", () => {
    const m = renderEmail("client_received", booking({ event_date: "2026-12-19" }), ctx);
    for (const [label, value] of [
      ["Date", "samedi 19 décembre 2026"],
      ["Formule", SECOND_PLAN.name],
      ["Événement", "Mariage"],
      ["Horaires", "18h-02h"],
      ["Lieu", "Domaine des Pins, Lyon"],
    ]) {
      expect(m.text).toContain(`${label} : ${value}`);
      expect(m.html).toContain(`<strong>${label}</strong> : ${escapeHtml(value)}`);
    }
  });

  it("l'accusé de réception n'écrit que ce que la demande renseigne", () => {
    const { text } = renderEmail("client_received", booking({ venue: null, event_hours: null, event_type: null }), ctx);
    expect(text).not.toMatch(/Lieu|Horaires|Événement|null/);
    expect(text).toContain("Date : ");
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
    expect(text).not.toContain("Passé le");
  });

  // Les CGV promettent « un e-mail avec le prix total et un lien pour régler l'acompte » : le client paie en sachant quoi.
  it("le lien de paiement rappelle la formule, le prix total, l'acompte et le reste à régler, avant le lien", () => {
    const { text } = renderEmail("client_deposit_link", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(text).toContain(`Formule : ${SECOND_PLAN.name}`);
    expect(text).toMatch(/Prix total : 1\s?500,00 €/);
    expect(text).toContain("Acompte à régler maintenant : 450,00 €");
    expect(text).toMatch(/Reste à régler ensuite : 1\s?050,00 €/);
    expect(text.indexOf("Prix total")).toBeLessThan(text.indexOf("https://brotobooth.fr/acompte/"));
  });

  it("le lien de paiement dit ce qui arrive à la date si l'acompte n'est pas réglé à temps", () => {
    const { text } = renderEmail("client_deposit_link", booking(), ctx);
    expect(text).toContain("Passé le mardi 10 novembre à 11 h, la date sera de nouveau proposée à d'autres.");
  });

  // Un prix encore à fixer ne s'écrit pas « 0,00 € » comme s'il était réel, ni un reste à régler qui en découlerait.
  it.each(["client_deposit_link", "client_confirmed", "client_d7"])("%s n'écrit ni prix ni reste à régler sans prix fixé", (t) => {
    for (const price_cents of [null, 0]) {
      const { text } = renderEmail(t, booking({ price_cents }), ctx);
      expect(text).not.toMatch(/Prix|Reste à régler/);
    }
  });

  it("le rappel porte le lien et la date limite", () => {
    const { text } = renderEmail("client_deposit_reminder", booking(), ctx);
    expect(text).toContain(`https://brotobooth.fr/acompte/${booking().token}`);
    expect(text).toContain("mardi 10 novembre à 11 h");
  });

  it("formate les dates et les montants en français", () => {
    expect(renderEmail("client_confirmed", booking({ event_date: "2026-12-19", price_cents: 150000 }), ctx).text)
      .toMatch(/samedi 19 décembre 2026[\s\S]*1\s?500,00\s?€/);
  });

  it("la confirmation récapitule la formule, le lieu, le prix total, l'acompte et le reste à régler", () => {
    const { text } = renderEmail("client_confirmed", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(text).toContain(SECOND_PLAN.name);
    expect(text).toContain("Domaine des Pins, Lyon");
    expect(text).toContain("18h-02h");
    expect(text).toMatch(/Prix total : 1\s?500,00 €/);
    expect(text).toMatch(/Acompte réglé : 450,00 €/);
    expect(text).toMatch(/Reste à régler : 1\s?050,00 €/);
  });

  // Le rappel de J-7 n'est prévu que si son heure n'était pas passée au paiement (`plan`) : la confirmation ne promet que lui.
  it("la confirmation annonce le rappel d'une semaine avant, seulement s'il est prévu", () => {
    const reminder = "Nous vous enverrons un rappel une semaine avant.";
    const early = renderEmail("client_confirmed", booking({ event_date: "2026-12-19", deposit_paid_at: T0 }), ctx).text;
    expect(early).toContain(reminder);
    expect(early).toContain("D'ici là, n'hésitez pas à nous écrire.");
    const late = renderEmail("client_confirmed", booking({ event_date: "2026-11-12", deposit_paid_at: T0 }), ctx).text;
    expect(late).not.toContain(reminder);
    expect(late).toContain("D'ici là, n'hésitez pas à nous écrire.");
  });

  it("le rappel de J-7 donne le lieu, les horaires et le reste à régler", () => {
    const { text } = renderEmail("client_d7", booking({ price_cents: 150_000, deposit_cents: 45_000 }), ctx);
    expect(text).toContain("Domaine des Pins, Lyon");
    expect(text).toContain("18h-02h");
    expect(text).toMatch(/Reste à régler : 1\s?050,00 €/);
  });

  it("n'annonce plus rien à régler quand le reste est déjà réglé", () => {
    const { text } = renderEmail("client_d7", booking({ balance_paid_at: T0 }), ctx);
    expect(text).toMatch(/Reste à régler : 0,00 €/);
  });

  it("le refus remercie, s'excuse, dit qu'il n'y a rien à payer et propose de choisir une autre date", () => {
    const { text } = renderEmail("client_refused", booking({ event_date: "2026-12-19" }), ctx);
    expect(text).toContain("Merci d'avoir pensé à nous pour votre événement.");
    expect(text).toContain("nous ne pouvons pas être présents le samedi 19 décembre 2026, et nous en sommes désolés");
    expect(text).toContain("Vous n'avez rien à payer.");
    expect(text).toContain("https://brotobooth.fr/reserver");
  });

  // Le client n'a pas payé à temps : le message dit lequel des délais est passé, et ce qui arrive s'il a payé entre-temps.
  it("l'avis de date plus gardée dit quel délai est passé, promet le remboursement et explique comment refaire une demande", () => {
    const { text } = renderEmail("client_released", booking({ event_date: "2026-12-19" }), ctx);
    expect(text).toContain(`Nous n'avons pas reçu votre acompte dans les ${offer.paymentHours}${NBSP}h prévues`);
    expect(text).toContain("la date du samedi 19 décembre 2026 n'est donc plus gardée pour vous");
    expect(text).toMatch(/Si vous avez payé entre-temps, écrivez-nous\s: nous vous rembourserons\./);
    expect(text).toContain("https://brotobooth.fr/reserver");
  });

  // Le propriétaire n'a pas répondu à temps : la faute n'est pas celle du client, le message ne lui parle pas d'acompte.
  it("l'avis de demande restée sans réponse s'excuse, rassure et invite à refaire une demande", () => {
    const { text, html } = renderEmail("client_unanswered", booking({ event_date: "2026-12-19" }), ctx);
    expect(text).toMatch(/désolés/);
    expect(text).toContain("la date du samedi 19 décembre 2026 n'est plus gardée pour vous");
    expect(text).toContain("Vous n'avez rien payé.");
    expect(text).toContain("vous pouvez refaire une demande");
    expect(text).toContain("https://brotobooth.fr/reserver");
    expect(html).toContain('href="https://brotobooth.fr/reserver"');
    expect(text).not.toMatch(/payer|acompte|appeler/i);
  });

  it("l'avis d'annulation confirme l'annulation et propose une autre date", () => {
    const { text } = renderEmail("client_cancelled", booking({ event_date: "2026-12-19" }), ctx);
    expect(text).toContain("Nous vous confirmons l'annulation de votre réservation du samedi 19 décembre 2026");
    expect(text).toContain("Refaire une demande : https://brotobooth.fr/reserver");
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

    // La réponse à un e-mail part vers l'adresse de contact, ou à défaut vers celle du propriétaire (`resendGateway`).
    it("invitent à répondre à l'e-mail quand l'offre ne renseigne aucun moyen", () => {
      Object.assign(offer.contact, { phone: "", email: "" });
      for (const t of CLIENT_TEMPLATES) {
        expect(renderEmail(t, booking(), ctx).text).toContain(`Une question${NBSP}? Répondez simplement à cet e-mail.`);
      }
      Object.assign(offer.contact, { phone: "06 12 34 56 78" });
      expect(renderEmail("client_refused", booking(), ctx).text).not.toContain("Répondez simplement");
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
    for (const part of ["samedi 19 décembre 2026", "Mariage", escapeHtml(SECOND_PLAN.name), "Domaine des Pins, Lyon", "Camille Martin", "0601020304"]) {
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
    expect(html).toContain("samedi 19 décembre 2026");
  });

  it("owner_review_reminder nomme le client et renvoie à la demande", () => {
    const m = renderEmail("owner_review_reminder", booking(), ctx);
    expect(m.text).toContain("Camille Martin");
    expect(m.text).toContain("https://brotobooth.fr/admin#b-42");
  });

  it("owner_late_payment donne le client, la date, l'acompte et demande un remboursement par Stripe", () => {
    const m = renderEmail("owner_late_payment", booking({ event_date: "2026-12-19", deposit_cents: 45_000 }), ctx);
    expect(m.text).toContain("Camille Martin");
    expect(m.text).toContain("samedi 19 décembre 2026");
    expect(m.text).toMatch(/450,00 €/);
    expect(m.text).toMatch(/Stripe/);
    expect(m.text).toMatch(/rembours/i);
    expect(renderTelegram("owner_late_payment", booking(), ctx).html).toMatch(/rembours/i);
  });

  it("owner_email_failed nomme le client et donne son téléphone ; son adresse n'est que dans l'e-mail", () => {
    const tg = renderTelegram("owner_email_failed", booking(), ctx).html;
    expect(tg).toContain("Camille Martin");
    expect(tg).toContain("0601020304");
    expect(tg).not.toContain("camille@example.test");
    const mail = renderEmail("owner_email_failed", booking(), ctx);
    expect(mail.text).toContain("camille@example.test");
    expect(mail.html).toContain("camille@example.test");
  });

  it("owner_late_payment garde l'adresse du client hors de Telegram, et la donne par e-mail", () => {
    expect(renderTelegram("owner_late_payment", booking(), ctx).html).not.toContain("camille@example.test");
    expect(renderEmail("owner_late_payment", booking(), ctx).text).toContain("camille@example.test");
  });

  it.each(ALL_TEMPLATES)("%s n'envoie jamais l'adresse e-mail du client à Telegram", (t) => {
    expect(renderTelegram(t, booking({ client_email: "camille@example.test" }), ctx).html).not.toContain("camille@example.test");
    expect(renderTelegram(t, booking({ client_email: "camille@example.test" }), ctx).html).not.toContain("camille%40example.test");
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

  it("rend chaque modèle, sur les deux canaux", () => {
    expect(OWNER_TEMPLATES.length + CLIENT_TEMPLATES.length).toBe(ALL_TEMPLATES.length);
    for (const t of ALL_TEMPLATES) {
      expect(renderEmail(t, booking(), ctx).text.length).toBeGreaterThan(0);
      expect(renderTelegram(t, booking(), ctx).html.length).toBeGreaterThan(0);
    }
  });
});
