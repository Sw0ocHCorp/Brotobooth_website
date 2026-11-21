import { describe, expect, it } from "vitest";
import { groupsIn } from "../../scripts/telegram-groups.mjs";

/** Ce que `getUpdates` de Telegram rend quand on mentionne le bot dans un groupe, ou qu'on l'y ajoute. */
const mention = (chat: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 3, from: { id: 8773926889, first_name: "Nicolas" }, chat, text: "@Brotobooth_PrestaBot bonjour", ...extra },
});
const added = (chat: Record<string, unknown>) => ({
  update_id: 2,
  my_chat_member: { chat, from: { id: 8773926889, first_name: "Nicolas" }, new_chat_member: { status: "member" } },
});

const GROUP = { id: -4123456789, title: "Brotobooth réservations", type: "group" };
const SUPERGROUP = { id: -1002233445566, title: "Brotobooth réservations", type: "supergroup" };

describe("groupsIn", () => {
  it("donne chaque groupe où le bot a été mentionné ou ajouté, une seule fois", () => {
    expect(groupsIn([mention(GROUP), added(GROUP), mention(SUPERGROUP)])).toEqual([GROUP, SUPERGROUP]);
  });

  it("ignore les conversations privées et les canaux", () => {
    const privateChat = { id: 8773926889, first_name: "Nicolas", type: "private" };
    const channel = { id: -1009988776655, title: "Annonces", type: "channel" };
    expect(groupsIn([mention(privateChat), added(channel)])).toEqual([]);
  });

  it("ne donne d'un groupe devenu supergroupe que son nouvel identifiant", () => {
    const upgraded = mention(GROUP, { migrate_to_chat_id: SUPERGROUP.id });
    expect(groupsIn([mention(GROUP), upgraded])).toEqual([{ ...SUPERGROUP }]);
  });

  it("ne garde que l'identifiant, le nom du groupe et son type : rien des personnes ni des messages", () => {
    const [group] = groupsIn([mention({ ...GROUP, username: "brotobooth_resa" })]);
    expect(Object.keys(group).sort()).toEqual(["id", "title", "type"]);
  });

  it("ne lève pas sur une mise à jour inattendue", () => {
    expect(groupsIn([null, 3, {}, { message: null }, { message: { chat: { id: "x", type: "group" } } }, { my_chat_member: {} }])).toEqual([]);
    expect(groupsIn(undefined)).toEqual([]);
  });
});
