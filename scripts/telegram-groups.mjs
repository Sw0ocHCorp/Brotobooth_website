// Trouve l'identifiant d'un groupe Telegram où le bot a été ajouté. Le bot est branché sur le site (webhook) : Telegram ne
// donne ses messages par `getUpdates` que s'il est débranché. `scripts/groupe-telegram.sh` enchaîne tout et rebranche le
// bot à la fin, quoi qu'il arrive ; ce script n'en fait que deux étapes, avec le jeton dans TELEGRAM_BOT_TOKEN :
//   node scripts/telegram-groups.mjs pause   débranche le bot du site (les boutons ne répondent plus jusqu'au rebranchement)
//   node scripts/telegram-groups.mjs list    donne les groupes où le bot a été mentionné ou ajouté depuis, et les oublie
// Le jeton n'est jamais écrit. Seuls l'identifiant, le nom et le type de chaque groupe s'affichent : rien des personnes ni
// des messages.

/** Les types de conversation où le bot peut annoncer les réservations à plusieurs personnes. */
const GROUP_TYPES = new Set(["group", "supergroup"]);

const isRecord = (value) => typeof value === "object" && value !== null;

/**
 * Les groupes des mises à jour `updates` de `getUpdates`, chacun une fois, dans l'ordre où ils apparaissent :
 * `{ id, title, type }`. Un groupe devenu supergroupe (`migrate_to_chat_id`) n'est donné que sous son nouvel identifiant,
 * le seul où le bot puisse encore écrire.
 *
 * @param {unknown} updates
 * @returns {{ id: number, title: string, type: string }[]}
 */
export function groupsIn(updates) {
  const groups = new Map();
  const replaced = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!isRecord(update)) continue;
    for (const holder of [update.message, update.my_chat_member]) {
      const chat = isRecord(holder) ? holder.chat : null;
      if (!isRecord(chat) || typeof chat.id !== "number" || !GROUP_TYPES.has(chat.type)) continue;
      const title = typeof chat.title === "string" ? chat.title : "";
      if (!groups.has(chat.id)) groups.set(chat.id, { id: chat.id, title, type: chat.type });
      const upgraded = holder.migrate_to_chat_id;
      if (typeof upgraded === "number") {
        replaced.add(chat.id);
        if (!groups.has(upgraded)) groups.set(upgraded, { id: upgraded, title, type: "supergroup" });
      }
    }
  }
  return [...groups.values()].filter((group) => !replaced.has(group.id));
}

/** Un appel à l'API du bot. Une erreur ne cite que la réponse de Telegram, jamais l'adresse appelée, qui porte le jeton. */
async function call(token, method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Telegram est injoignable (${error instanceof Error ? error.name : "erreur inconnue"})`);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    const reason = typeof result?.description === "string" ? ` : ${result.description}` : "";
    throw new Error(`Telegram a refusé ${method} (${response.status}${reason})`);
  }
  return result.result;
}

async function main(command, token) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN manque");
  if (command === "pause") {
    // Les mises à jour en attente sont gardées : un appui sur un bouton pendant la pause arrivera au site au rebranchement.
    await call(token, "deleteWebhook", { drop_pending_updates: false });
    console.log("Le bot est débranché du site, le temps de trouver le groupe.");
    return;
  }
  if (command === "list") {
    const updates = await call(token, "getUpdates", { allowed_updates: ["message", "my_chat_member"], timeout: 0 });
    const groups = groupsIn(updates);
    if (groups.length === 0) {
      console.log("Aucun groupe trouvé. Dans le groupe, mentionnez le bot (tapez @ puis choisissez-le), envoyez, puis relancez.");
    } else {
      for (const { id, title, type } of groups) console.log(`${id}  ${title} (${type === "supergroup" ? "supergroupe" : "groupe"})`);
    }
    // Rien n'est marqué comme lu : rebranché, le site reçoit ce qui attend. Il ignore les messages, et traite un appui sur
    // un bouton fait pendant la pause.
    return;
  }
  throw new Error(`Commande inconnue : « ${command ?? ""} » (pause ou list)`);
}

/** Lancé par `node`, le script agit ; importé par un test (Vitest tourne dans workerd), il n'exporte que `groupsIn`. */
if (typeof process !== "undefined" && process.argv[1]) {
  await main(process.argv[2], process.env.TELEGRAM_BOT_TOKEN).catch((error) => {
    console.error(error instanceof Error ? error.message : "erreur inconnue");
    process.exitCode = 1;
  });
}
