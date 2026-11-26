// Private case channels, shared by recruitment intake and support tickets.
// A case is a text channel only the member, the handling staff and the bot
// can see. Closing locks it, saves a transcript, and offers Delete/Reopen.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder,
} = require('discord.js');
const db = require('./db');
const access = require('./access');
const audit = require('./audit');
const { getSetting } = require('./settings');
const { embed, tell, ts, clip, COLORS, userTag } = require('./ui');

const KIND = {
  intake: { prefix: 'intake', title: 'Application', category: 'intake_category', handlerRoles: 'recruiter_roles' },
  ticket: { prefix: 'ticket', title: 'Ticket', category: 'ticket_category', handlerRoles: 'support_roles' },
};
const TRANSCRIPT_MAX_MESSAGES = 2000;
const P = PermissionFlagsBits;
const MEMBER_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const STAFF_ALLOW = [...MEMBER_ALLOW, P.ManageMessages];
const BOT_ALLOW = [...STAFF_ALLOW, P.ManageChannels];

// ── Data ────────────────────────────────────────────────────────────────────

const caseById = (id) => db.get().prepare('SELECT * FROM cases WHERE id = ?').get(id);
const caseByChannel = (channelId) => db.get().prepare('SELECT * FROM cases WHERE channel_id = ?').get(channelId);
const openCaseFor = (kind, userId) => db.get()
  .prepare("SELECT * FROM cases WHERE kind = ? AND opener_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(kind, userId);
const openCases = (limit = 25) => db.get().prepare("SELECT * FROM cases WHERE status = 'open' ORDER BY id LIMIT ?").all(limit);

function nextNumber(kind) {
  const row = db.get().prepare('SELECT MAX(number) AS n FROM cases WHERE kind = ?').get(kind);
  return (row?.n || 0) + 1;
}

const answersOf = (row) => {
  try { return JSON.parse(row.answers || '[]'); } catch { return []; }
};

// Staff roles plus the kind's own handler roles, without duplicates.
const handlerRoleIds = (kind) => [...new Set([...getSetting('staff_roles'), ...getSetting(KIND[kind].handlerRoles)])];

function slug(text) {
  return String(text || 'member').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'member';
}

function channelName(kind, number, username) {
  return `${KIND[kind].prefix}-${String(number).padStart(4, '0')}-${slug(username)}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function caseButtons(row) {
  const id = row.id;
  const b = (action, label, style, emoji) => {
    const btn = new ButtonBuilder().setCustomId(`case:${action}:${id}`).setLabel(label).setStyle(style);
    if (emoji) btn.setEmoji(emoji);
    return btn;
  };
  if (row.status !== 'open') {
    return [new ActionRowBuilder().addComponents(
      b('reopen', 'Reopen', ButtonStyle.Secondary, '🔓'),
      b('delete', 'Delete channel', ButtonStyle.Danger, '🗑️'),
    )];
  }
  const buttons = [b('claim', row.claimed_by ? 'Claimed' : 'Claim', ButtonStyle.Secondary, '🙋')];
  if (row.kind === 'intake') {
    buttons.push(b('accept', 'Accept', ButtonStyle.Success, '✅'), b('deny', 'Deny', ButtonStyle.Danger, '⛔'));
  }
  buttons.push(b('close', 'Close', ButtonStyle.Secondary, '🔒'));
  return [new ActionRowBuilder().addComponents(buttons)];
}

function caseCard(row) {
  const fields = answersOf(row).map((a) => ({ name: clip(a.question, 256), value: clip(a.answer || '—', 1024) }));
  const meta = [
    `**Member:** <@${row.opener_id}>`,
    row.category ? `**Category:** ${row.category}` : null,
    `**Opened:** ${ts(row.created_at, 'f')}`,
    row.claimed_by ? `**Handled by:** <@${row.claimed_by}>` : null,
  ].filter(Boolean).join('\n');
  return embed({ title: `${KIND[row.kind].title} #${String(row.number).padStart(4, '0')}`, description: meta, fields });
}

// ── Open ────────────────────────────────────────────────────────────────────

// Creates the channel and the case row. Returns { row, channel } or { error }.
async function openCase(i, kind, { category = '', answers = [], intro = '' } = {}) {
  const existing = openCaseFor(kind, i.user.id);
  if (existing) return { error: `You already have an open ${KIND[kind].title.toLowerCase()}: <#${existing.channel_id}>` };
  const guild = i.guild;
  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(P.ManageChannels)) return { error: 'I need the Manage Channels permission to open private channels. Ask an admin.' };

  const number = nextNumber(kind);
  const roles = handlerRoleIds(kind).filter((id) => guild.roles.cache.has(id));
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: i.user.id, allow: MEMBER_ALLOW },
    { id: me.id, allow: BOT_ALLOW },
    ...roles.map((id) => ({ id, allow: STAFF_ALLOW })),
  ];
  const parentId = getSetting(KIND[kind].category);
  const parent = parentId ? guild.channels.cache.get(parentId) : null;
  const channel = await guild.channels.create({
    name: channelName(kind, number, i.user.username),
    type: ChannelType.GuildText,
    parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
    permissionOverwrites: overwrites,
    topic: `${KIND[kind].title} for ${userTag(i.user)} (${i.user.id})`,
    reason: `${KIND[kind].title} opened by ${i.user.username}`,
  });
  const result = db.get().prepare(`INSERT INTO cases (kind, number, channel_id, opener_id, opener_name, category, answers, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, number, channel.id, i.user.id, clip(i.member?.displayName || userTag(i.user), 80),
    category, JSON.stringify(answers), db.now());
  const row = caseById(Number(result.lastInsertRowid));
  await channel.send({
    content: [`<@${i.user.id}>`, ...roles.map((r) => `<@&${r}>`)].join(' ') + (intro ? `\n${intro}` : ''),
    embeds: [caseCard(row)],
    components: caseButtons(row),
    allowedMentions: { users: [i.user.id], roles },
  });
  audit.record(i.user.id, `${kind}_open`, i.user.id, { case_id: row.id, channel_id: channel.id });
  return { row, channel };
}

// ── Transcript ──────────────────────────────────────────────────────────────

async function fetchAllMessages(channel, max = TRANSCRIPT_MAX_MESSAGES) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function transcriptText(row, messages, guildName) {
  const lines = [
    `${KIND[row.kind].title} #${String(row.number).padStart(4, '0')} — ${guildName}`,
    `Member: ${row.opener_name} (${row.opener_id})`,
    `Opened: ${new Date(row.created_at * 1000).toISOString()}`,
    row.closed_at ? `Closed: ${new Date(row.closed_at * 1000).toISOString()}${row.outcome ? ` (${row.outcome})` : ''}` : null,
    '',
  ].filter((l) => l !== null);
  for (const m of messages) {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const who = `${m.author?.username || 'unknown'}${m.author?.bot ? ' [bot]' : ''}`;
    const parts = [m.content || ''];
    for (const e of m.embeds || []) {
      parts.push(`[embed] ${e.title || ''} ${e.description || ''}`.trim());
      for (const f of e.fields || []) parts.push(`  ${f.name}: ${f.value}`);
    }
    for (const a of m.attachments?.values?.() || []) parts.push(`[file] ${a.name} ${a.url}`);
    lines.push(`[${when}] ${who}: ${parts.filter(Boolean).join('\n    ')}`);
  }
  return lines.join('\n');
}

async function saveTranscript(client, row, channel) {
  const targetId = getSetting('transcript_channel') || getSetting('log_channel');
  if (!targetId) return null;
  try {
    const messages = await fetchAllMessages(channel);
    const text = transcriptText(row, messages, channel.guild?.name || '');
    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `${channel.name}.txt` });
    const target = await client.channels.fetch(targetId);
    const sent = await target.send({
      embeds: [embed({
        title: `Transcript: ${KIND[row.kind].title} #${String(row.number).padStart(4, '0')}`,
        description: `**Member:** <@${row.opener_id}>\n**Outcome:** ${row.outcome || 'closed'}\n**Closed by:** <@${row.closed_by}>\n**Messages:** ${messages.length}`,
        color: COLORS.muted,
      })],
      files: [file],
      allowedMentions: { parse: [] },
    });
    return sent.url;
  } catch (e) {
    console.error(`[cases] transcript for case ${row.id} failed:`, e.message);
    return null;
  }
}

// ── Close / reopen / delete ─────────────────────────────────────────────────

// Locks the channel and saves the transcript. `note` is shown in the channel.
async function closeCase(client, row, actorId, outcome, note = '') {
  db.get().prepare("UPDATE cases SET status = 'closed', outcome = ?, closed_at = ?, closed_by = ? WHERE id = ?")
    .run(outcome, db.now(), actorId, row.id);
  const closed = caseById(row.id);
  const channel = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel) return { row: closed };
  await channel.permissionOverwrites.edit(row.opener_id, { SendMessages: false }, { reason: 'Case closed' }).catch((e) => {
    console.error(`[cases] could not lock case ${row.id}:`, e.message);
  });
  const transcriptUrl = await saveTranscript(client, closed, channel);
  await channel.send({
    embeds: [embed({
      title: `🔒 Closed: ${outcome}`,
      description: [`Closed by <@${actorId}>.`, note, transcriptUrl ? `Transcript saved: ${transcriptUrl}` : null].filter(Boolean).join('\n'),
      color: COLORS.muted,
    })],
    components: caseButtons(closed),
    allowedMentions: { parse: [] },
  });
  audit.record(actorId, `${row.kind}_close`, row.opener_id, { case_id: row.id, outcome });
  return { row: closed, transcriptUrl };
}

// Only the member who opened a ticket may close it besides staff; intake
// cases are closed by recruiters only.
function mayClose(i, row) {
  if (access.handler(i, row.kind)) return true;
  return row.kind === 'ticket' && row.opener_id === i.user.id;
}

async function handleButton(i, action, row) {
  if (action === 'claim') {
    if (!access.handler(i, row.kind)) return tell(i, 'Only staff handling these can claim them.');
    if (row.status !== 'open') return tell(i, 'This case is closed.');
    db.get().prepare('UPDATE cases SET claimed_by = ? WHERE id = ?').run(i.user.id, row.id);
    const updated = caseById(row.id);
    await i.update({ embeds: [caseCard(updated)], components: caseButtons(updated) });
    await i.followUp({ content: `🙋 <@${i.user.id}> is handling this.`, allowedMentions: { parse: [] } });
    audit.record(i.user.id, `${row.kind}_claim`, row.opener_id, { case_id: row.id });
    return null;
  }
  if (action === 'close') {
    if (!mayClose(i, row)) return tell(i, 'You cannot close this.');
    if (row.status !== 'open') return tell(i, 'This case is already closed.');
    await i.deferUpdate();
    await i.message.edit({ components: [] }).catch(() => {});
    await closeCase(i.client, row, i.user.id, 'closed');
    return null;
  }
  if (action === 'reopen') {
    if (!access.handler(i, row.kind)) return tell(i, 'Only staff can reopen this.');
    if (row.status !== 'closed') return tell(i, 'This case is not closed.');
    db.get().prepare("UPDATE cases SET status = 'open', outcome = NULL, closed_at = NULL, closed_by = NULL WHERE id = ?").run(row.id);
    await i.channel.permissionOverwrites.edit(row.opener_id, { SendMessages: true }, { reason: 'Case reopened' }).catch(() => {});
    const updated = caseById(row.id);
    await i.update({ components: [] });
    await i.channel.send({ content: `🔓 Reopened by <@${i.user.id}>.`, embeds: [caseCard(updated)], components: caseButtons(updated), allowedMentions: { parse: [] } });
    audit.record(i.user.id, `${row.kind}_reopen`, row.opener_id, { case_id: row.id });
    return null;
  }
  if (action === 'delete' || action === 'deleteyes') {
    if (!access.handler(i, row.kind)) return tell(i, 'Only staff can delete this channel.');
    if (action === 'delete') {
      const confirm = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`case:deleteyes:${row.id}`).setLabel('Yes, delete the channel').setStyle(ButtonStyle.Danger),
      );
      const hint = row.status === 'open' ? 'This case is still open and no transcript has been saved. ' : '';
      return tell(i, { content: `${hint}Delete this channel for good? It cannot be undone.`, components: [confirm] });
    }
    db.get().prepare("UPDATE cases SET status = 'deleted' WHERE id = ?").run(row.id);
    audit.record(i.user.id, `${row.kind}_delete`, row.opener_id, { case_id: row.id });
    await i.reply({ content: 'Deleting this channel…' }).catch(() => {});
    const channel = await i.client.channels.fetch(row.channel_id).catch(() => null);
    await channel?.delete(`Deleted by ${i.user.username}`).catch((e) => console.error(`[cases] delete failed:`, e.message));
    return null;
  }
  return tell(i, 'Unknown action.');
}

module.exports = {
  KIND, caseById, caseByChannel, openCaseFor, openCases, openCase, closeCase, caseCard, caseButtons,
  handleButton, transcriptText, channelName, handlerRoleIds, answersOf,
};
