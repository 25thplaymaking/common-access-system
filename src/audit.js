// Staff actions are written to the database and posted to the log channel.
const db = require('./db');
const { getSetting } = require('./settings');
const { embed } = require('./ui');

function record(actorId, action, targetId = null, detail = {}) {
  db.get().prepare('INSERT INTO audit (at, actor_id, action, target_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(db.now(), String(actorId), action, targetId ? String(targetId) : null, JSON.stringify(detail));
}

function recent(limit = 10) {
  return db.get().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
}

// Post to the log channel if one is set. Never throws: logging must not break
// the action it describes.
async function postLog(client, payload) {
  const channelId = getSetting('log_channel');
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return null;
    return await channel.send({ ...payload, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('[audit] log post failed:', e.message);
    return null;
  }
}

// Record a staff action and post a short card about it.
async function staffAction(client, { actor, action, target, summary, fields = [], color }) {
  record(actor.id, action, target?.id, { summary });
  await postLog(client, {
    embeds: [embed({
      title: summary,
      color,
      fields: [{ name: 'By', value: `<@${actor.id}>`, inline: true },
        ...(target ? [{ name: 'Member', value: `<@${target.id}>`, inline: true }] : []), ...fields],
    })],
  });
}

module.exports = { record, recent, postLog, staffAction };
