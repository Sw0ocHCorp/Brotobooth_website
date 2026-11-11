import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContact, parseContact } from "../../worker/contact";
import { offer } from "../../worker/offer";
import { sha256Hex } from "../../worker/http";
import { countRecentContactByIp, getContactMessage, insertContactMessage, type ContactMessage } from "../../worker/repository";
import { T0, fakeDeps, notificationRows, resetDb, type FakeDeps } from "../support";

const IP = "203.0.113.5";
const NOW = new Date(T0);
const valid = (over: Record<string, unknown> = {}) => ({
  name: "Camille Durand", email: "camille@example.test", phone: "06 12 34 56 78",
  message: "Bonjour, une question.", turnstile_token: "t", ...over,
});
const messages = async () => (await env.DB.prepare("SELECT * FROM contact_messages").all<ContactMessage>()).results;

let deps: FakeDeps;
beforeEach(async () => {
  await resetDb(env.DB);
  deps = fakeDeps({ env: { ...env, IP_HASH_SALT: "sel-de-test" } });
});

describe("parseContact", () => {
  it.each([
    [{ name: "" }, "name"], [{ name: "x".repeat(121) }, "name"], [{ email: "pas-un-email" }, "email"],
    [{ message: "   " }, "message"], [{ message: "m".repeat(2001) }, "message"], [{ phone: "abc" }, "phone"],
  ])("refuses %j", (over, field) => {
    expect(parseContact(valid(over), NOW)).toEqual({ ok: false, fields: [field] });
  });

  it("accepts an absent or blank phone as null and trims the fields", () => {
    for (const phone of [undefined, "", "  "]) {
      expect(parseContact(valid({ phone, name: " Camille ", message: " Salut " }), NOW)).toEqual({
        ok: true,
        value: { name: "Camille", email: "camille@example.test", phone: null, message: "Salut", turnstile_token: "t" },
      });
    }
  });

  it("accepts the maximum lengths and refuses a body that is not an object", () => {
    expect(parseContact(valid({ name: "x".repeat(120), message: "m".repeat(2000) }), NOW).ok).toBe(true);
    expect(parseContact(null, NOW)).toEqual({ ok: false, fields: ["name", "email", "message", "turnstile_token"] });
  });
});

describe("createContact", () => {
  it("stores the normalized email", async () => {
    expect(await createContact(deps, valid({ email: " Camille@Example.TEST " }), IP)).toEqual({ kind: "sent" });
    expect((await messages())[0].email).toBe("camille@example.test");
  });

  it("stores the message and its email together", async () => {
    await createContact(deps, valid(), IP);
    const [m] = await messages();
    expect(m).toMatchObject({ name: "Camille Durand", phone: "06 12 34 56 78", message: "Bonjour, une question.", created_at: T0 });
    expect(m.ip_hash).toBe(await sha256Hex("sel-de-test" + IP));
    expect(await notificationRows()).toMatchObject([
      { booking_id: null, contact_id: m.id, dedupe_key: `contact:${m.id}:email`, channel: "email", recipient: "owner", template: "owner_contact", due_at: T0 },
    ]);
    expect(await getContactMessage(env.DB, m.id)).toEqual(m);
  });

  it("writes nothing and answers bot when Turnstile fails", async () => {
    const d = fakeDeps({ verifyTurnstile: async () => "fail" });
    expect(await createContact(d, valid(), IP)).toEqual({ kind: "bot" });
    expect(await messages()).toEqual([]);
    expect(await notificationRows()).toEqual([]);
  });

  it("validates before consulting Turnstile", async () => {
    const verifyTurnstile = vi.fn(async () => "pass" as const);
    expect(await createContact(fakeDeps({ verifyTurnstile }), valid({ name: "" }), IP)).toEqual({ kind: "invalid", fields: ["name"] });
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it("stores the message when Turnstile is down or throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await createContact(fakeDeps({ verifyTurnstile: async () => "unavailable" }), valid(), IP)).kind).toBe("sent");
    const throwing = fakeDeps({ verifyTurnstile: async () => { throw new Error("panne"); } });
    expect((await createContact(throwing, valid(), IP)).kind).toBe("sent");
    expect(await messages()).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("refuses the message after the per-connection limit in 24 h, writing nothing", async () => {
    for (let i = 0; i < offer.maxPerIpPer24h; i++) expect((await createContact(deps, valid(), IP)).kind).toBe("sent");
    expect(await createContact(deps, valid(), IP)).toEqual({ kind: "too_many" });
    expect(await messages()).toHaveLength(offer.maxPerIpPer24h);
    expect(await notificationRows()).toHaveLength(offer.maxPerIpPer24h);
    expect((await createContact(deps, valid(), "198.51.100.7")).kind).toBe("sent");
  });

  it("keeps no fingerprint and applies no limit without a salt", async () => {
    const d = fakeDeps({ env: { ...env, IP_HASH_SALT: "" } });
    for (let i = 0; i < offer.maxPerIpPer24h + 1; i++) expect((await createContact(d, valid(), IP)).kind).toBe("sent");
    expect((await messages()).every((m) => m.ip_hash === null)).toBe(true);
  });
});

describe("contact repository", () => {
  const row = (over: Partial<ContactMessage> = {}): ContactMessage => ({
    id: crypto.randomUUID(), name: "N", email: "n@example.test", phone: null, message: "m", ip_hash: "h", created_at: T0, ...over,
  });

  it("counts recent messages by fingerprint, since a given instant", async () => {
    await insertContactMessage(env.DB, row({ created_at: "2026-11-05T10:00:00.000Z" }), []);
    await insertContactMessage(env.DB, row(), []);
    await insertContactMessage(env.DB, row({ ip_hash: "autre" }), []);
    expect(await countRecentContactByIp(env.DB, "h", "2026-11-06T10:00:00.000Z")).toBe(1);
    expect(await countRecentContactByIp(env.DB, "h", "2026-11-01T10:00:00.000Z")).toBe(2);
  });

  it("returns null for an unknown message", async () => {
    expect(await getContactMessage(env.DB, "inconnu")).toBeNull();
  });
});
