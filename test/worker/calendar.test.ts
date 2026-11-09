import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_STATUSES, addDays, type BookingStatus } from "../../worker/bookings";
import { renderCalendar } from "../../worker/calendar";
import type { Deps } from "../../worker/deps";
import type { Booking, NewBooking } from "../../worker/repository";
import { handle } from "../../worker/router";
import { SECOND_PLAN, T0, fakeDeps, insert, newBooking, resetDb, type FakeDeps } from "../support";

const TOKEN = "d3f1c0de5eed";
const TODAY = "2026-11-07";
const ctx = createExecutionContext();

const booking = (status: BookingStatus, date: string, over: Partial<NewBooking> = {}): Booking => ({
  ...newBooking({ status, event_date: date, ...over }),
  created_at: T0,
  updated_at: T0,
});
const confirmed = (date: string, over?: Partial<NewBooking>) => booking("confirmed", date, over);
const pending = (date: string, over?: Partial<NewBooking>) => booking("pending_review", date, over);

const render = (...bookings: Booking[]) => renderCalendar(bookings, new Date(T0));
/** Le calendrier tel que l'agenda le lit : les lignes repliées sont recollées. */
const unfold = (ics: string) => ics.replaceAll("\r\n ", "");
/** Les identifiants d'événement du calendrier, dans l'ordre. */
const uids = (ics: string) => [...ics.matchAll(/^UID:(.+)@brotobooth\.fr$/gm)].map((m) => m[1]);

describe("renderCalendar", () => {
  it("donne un événement sur la journée par prestation confirmée et par demande à valider", () => {
    const ics = render(confirmed("2026-12-19"), pending("2027-01-09"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261219");
    expect(ics).toContain("DTEND;VALUE=DATE:20261220");
    expect(ics).toMatch(/SUMMARY:Prestation/);
    expect(ics).toMatch(/SUMMARY:À valider/);
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.split("\r\n").length).toBeGreaterThan(5);
  });

  it("clôt le mois et l'année : la fin de la journée est le lendemain", () => {
    expect(render(confirmed("2026-12-31"))).toContain("DTEND;VALUE=DATE:20270101");
  });

  it("est un calendrier nommé Brotobooth, à fins de ligne CRLF seulement", () => {
    const ics = render(confirmed("2026-12-19"));
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("\r\nX-WR-CALNAME:Brotobooth\r\n");
    expect(ics.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it("reste un calendrier valide quand rien n'est à venir", () => {
    expect(render()).toBe(
      ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Brotobooth//Reservations//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Brotobooth", "END:VCALENDAR", ""].join("\r\n"),
    );
  });

  // L'événement commence à minuit : 15 h avant, l'alerte sonne la veille à 9 h, comme les autres rappels (`-P1D` sonnerait à minuit).
  it("alerte la veille à 9 h de chaque événement", () => {
    const ics = render(confirmed("2026-12-19"), pending("2027-01-09"));
    expect(ics.match(/^BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15H\r\n/gm)).toHaveLength(2);
    expect(ics).not.toContain("TRIGGER:-P1D");
    // Une alerte d'affichage porte un texte (RFC 5545, 3.6.6) : celui de l'événement.
    expect(ics).toMatch(/TRIGGER:-PT15H\r\nDESCRIPTION:Prestation[^\r]*\r\nEND:VALARM/);
  });

  it("garde le même identifiant d'événement d'une lecture à l'autre", () => {
    const a = confirmed("2026-12-19");
    const first = renderCalendar([a], new Date(T0));
    const later = renderCalendar([a], new Date("2026-11-08T08:00:00.000Z"));
    expect(first).toContain(`UID:${a.id}@brotobooth.fr\r\n`);
    expect(uids(later)).toEqual(uids(first));
  });

  it("date l'événement de l'instant injecté", () => {
    expect(render(confirmed("2026-12-19"))).toContain("DTSTAMP:20261107T100000Z\r\n");
  });

  it("échappe les champs libres", () => {
    const ics = unfold(render(confirmed("2026-12-19", { venue: "Salle, n°3; étage\n2" })));
    expect(ics).toContain("Salle\\, n°3\\; étage\\n2");
  });

  it("échappe l'antislash avant les autres signes", () => {
    expect(unfold(render(confirmed("2026-12-19", { venue: String.raw`C:\salle;` })))).toContain(String.raw`LOCATION:C:\\salle\;`);
  });

  it("n'ouvre aucune ligne de plus à qui glisse un saut de ligne dans un champ", () => {
    const venue = "Salle\r\nEND:VEVENT\r\nBEGIN:VEVENT\rSUMMARY:Piège\u0000\u0007";
    const ics = render(confirmed("2026-12-19", { venue, client_name: venue }));
    expect(ics.match(/^BEGIN:VEVENT\r$/gm)).toHaveLength(1);
    expect(ics.match(/^END:VEVENT\r$/gm)).toHaveLength(1);
    expect(ics.match(/^SUMMARY:/gm)).toHaveLength(1);
    expect(ics).toContain("Salle\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Piège");
    // Les autres caractères de contrôle ne sont pas permis dans un texte : un seul suffirait à faire refuser le flux.
    expect(ics).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  it("replie les lignes à 75 octets sans couper un caractère", () => {
    const lines = render(confirmed("2026-12-19", { venue: "é".repeat(200) })).split("\r\n");
    const enc = new TextEncoder();
    expect(lines.every((l) => enc.encode(l).length <= 75)).toBe(true);
    expect(new TextDecoder().decode(enc.encode(lines.join("\r\n")))).not.toContain("�");
  });

  it("replie sans rien perdre, et sans couper un caractère de quatre octets", () => {
    for (const venue of ["é".repeat(200), "🎉".repeat(60), `a${"🎉".repeat(60)}`, `Salle ${"vue sur la mer, ".repeat(12)}🎉`]) {
      const ics = render(confirmed("2026-12-19", { venue }));
      const lines = ics.split("\r\n");
      const enc = new TextEncoder();
      expect(lines.every((l) => enc.encode(l).length <= 75)).toBe(true);
      expect(lines.some((l) => l.startsWith(" "))).toBe(true);
      // Chaque ligne, une fois en UTF-8, redonne la même ligne : aucune ne porte la moitié d'un caractère.
      expect(lines.every((l) => new TextDecoder().decode(enc.encode(l)) === l)).toBe(true);
      expect(unfold(ics)).toContain(`LOCATION:${venue.replaceAll(",", "\\,")}\r\n`);
    }
  });

  it("donne un titre à chaque état qui tient une date", () => {
    const titles = {
      confirmed: "Prestation",
      pending_review: "À valider",
      awaiting_deposit: "Acompte attendu",
      blocked: "Date bloquée",
    };
    for (const [status, title] of Object.entries(titles)) {
      expect(render(booking(status as BookingStatus, "2026-12-19", { client_name: null, notes: null }))).toContain(`SUMMARY:${title}\r\n`);
    }
  });

  it("nomme le client dans le titre", () => {
    expect(render(confirmed("2026-12-19", { client_name: "Camille Martin" }))).toMatch(/SUMMARY:Prestation[^\r\n]*Camille Martin\r\n/);
  });

  it("affiche une date bloquée sous son propre titre", () => {
    const ics = render(booking("blocked", "2026-12-19", { client_name: null, notes: null }));
    expect(ics).toContain("SUMMARY:Date bloquée\r\n");
  });

  it("montre à la place du nom la note du propriétaire d'une date bloquée, jamais un champ client", () => {
    const ics = unfold(
      render(
        booking("blocked", "2026-12-19", {
          notes: "Mariage de ma sœur",
          client_name: "Camille Martin",
          client_phone: "0601020304",
          client_email: "camille@example.test",
          venue: "Domaine des Pins",
          event_type: "Mariage",
          event_hours: "18h-02h",
          message: "Un fond rose",
        }),
      ),
    );
    expect(ics).toContain("SUMMARY:Date bloquée");
    expect(ics).toContain("Mariage de ma sœur");
    for (const client of ["Camille", "0601020304", "example.test", "Domaine", "18h-02h", "fond rose", "LOCATION", "Solde"]) {
      expect(ics).not.toContain(client);
    }
  });

  it("décrit la prestation : type, horaires, formule, téléphone et solde restant", () => {
    const ics = unfold(render(confirmed("2026-12-19")));
    expect(ics).toContain("LOCATION:Domaine des Pins\\, Lyon\r\n");
    // Le nom de la formule est celui de l'offre, tel que le calendrier l'écrit (`\`, `;` et `,` échappés).
    const formule = SECOND_PLAN.name.replace(/[\\;,]/g, "\\$&");
    expect(ics).toContain(`Formule : ${formule}\\nTéléphone : 0601020304\\nSolde restant : `);
    expect(ics).toMatch(/DESCRIPTION:Type : Mariage\\nHoraires : 18h-02h\\nFormule : [^\r]+\\nTéléphone : 0601020304\\nSolde restant : 1\s050 €\r\n/);
  });

  it("ne dit rien du solde, du lieu ni du reste quand ils ne sont pas renseignés", () => {
    const ics = unfold(
      render(confirmed("2026-12-19", { price_cents: null, deposit_cents: null, venue: null, event_type: null, event_hours: null, plan: null, client_phone: null })),
    );
    expect(ics).not.toContain("LOCATION");
    // Il ne reste que le texte de l'alerte : l'événement lui-même n'a pas de description.
    expect(ics.match(/^DESCRIPTION:/gm)).toHaveLength(1);
    expect(ics).not.toContain("Solde");
    expect(ics).not.toContain("null");
  });

  it("compte un solde réglé pour zéro", () => {
    expect(unfold(render(confirmed("2026-12-19", { balance_paid_at: T0 })))).toMatch(/Solde restant : 0 €/);
  });
});

describe("GET /agenda/<jeton>.ics", () => {
  let deps: FakeDeps;
  beforeEach(async () => {
    await resetDb(env.DB);
    deps = fakeDeps({ env: { ...env, CALENDAR_TOKEN: TOKEN } });
  });

  const get = (path: string, d: Deps = deps, method = "GET") => handle(new Request(`https://brotobooth.fr${path}`, { method }), d, ctx);
  const feed = (d: Deps = deps) => get(`/agenda/${TOKEN}.ics`, d);
  const feedText = async (d: Deps = deps) => (await feed(d)).text();
  const held = (date: string, status: BookingStatus = "confirmed") => insert(newBooking({ event_date: date, status }));

  it("sert le bon type de contenu", async () => {
    await held("2026-12-19");
    const res = await feed();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await res.text()).toMatch(/^BEGIN:VCALENDAR\r\n/);
  });

  it("répond 404 à un mauvais jeton, sans détail", async () => {
    await held("2026-12-19");
    const unknown = await get("/inconnu");
    for (const path of ["/agenda/faux.ics", `/agenda/${TOKEN}x.ics`, `/agenda/${TOKEN.slice(1)}.ics`, `/agenda/${TOKEN.toUpperCase()}.ics`, `/agenda/${TOKEN}`, `/agenda/${TOKEN}.ical`, "/agenda/.ics"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text(), path).toBe(await unknown.clone().text());
    }
  });

  it("est coupé quand le jeton de l'agenda est vide ou absent", async () => {
    await held("2026-12-19");
    for (const CALENDAR_TOKEN of ["", undefined as unknown as string]) {
      const off = fakeDeps({ env: { ...env, CALENDAR_TOKEN } });
      for (const path of ["/agenda/.ics", "/agenda/undefined.ics", "/agenda/%20.ics", `/agenda/${TOKEN}.ics`]) {
        expect((await get(path, off)).status, `${JSON.stringify(CALENDAR_TOKEN)} ${path}`).toBe(404);
      }
    }
  });

  it("ne répond qu'à GET", async () => {
    const res = await get(`/agenda/${TOKEN}.ics`, deps, "POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("liste chaque état qui tient une date", async () => {
    const ids: string[] = [];
    for (const [i, status] of ACTIVE_STATUSES.entries()) {
      ids.push((await held(addDays("2026-12-01", i), status)).booking.id);
    }
    expect(uids(await feedText())).toEqual(ids);
  });

  it("exclut les états libérés et les dates passées", async () => {
    const kept = await held(TODAY);
    const tomorrow = await held(addDays(TODAY, 1), "pending_review");
    await held(addDays(TODAY, -1)); // hier
    await held("2026-12-01", "expired");
    await held("2026-12-02", "cancelled");
    await held("2026-12-03", "refused");
    expect(uids(await feedText())).toEqual([kept.booking.id, tomorrow.booking.id]);
  });

  it("trie les événements par date", async () => {
    const late = await held("2027-02-01");
    const early = await held("2026-12-01", "awaiting_deposit");
    expect(uids(await feedText())).toEqual([early.booking.id, late.booking.id]);
  });

  it("compte les jours à l'heure de Paris à l'instant injecté", async () => {
    const today = await held(TODAY);
    const tomorrow = await held(addDays(TODAY, 1));
    // 23 h 30 UTC : minuit passé à Paris, le 8 novembre.
    deps.setNow("2026-11-07T23:30:00.000Z");
    expect(uids(await feedText())).toEqual([tomorrow.booking.id]);
    deps.setNow("2026-11-07T10:00:00.000Z");
    expect(uids(await feedText())).toEqual([today.booking.id, tomorrow.booking.id]);
  });
});
