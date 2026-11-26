// Join, leave, kick and ban notices for the staff log, and the invite ledger.
//
// Discord does not say which invite a member used. The bot keeps a snapshot
// of every invite's use count; a join that raises exactly one count is
// credited to that invite. Two raised counts are reported as "ambiguous" and
// none as "unknown", never guessed.
const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const db = require('./db');
const access = require('./access');
const audit = require('./audit');
const { getSetting } = require('./settings');
const { embed, tell, ts, clip, COLORS } = require('./ui');

const NEW_ACCOUNT_DAYS = 7;
const snapshots = new Map(); // guildId -> Map(code -> uses)

async function readInvites(guild) {
  try {
    return await guild.invites.fetch();
  } catch {
    return null; // needs Manage Server
  }
}

async function snapshotInvites(guild) {
  const invites = await readInvites(guild);
  if (!invites) return null;
  const uses = new Map();
  invites.forEach((inv) => uses.set(inv.code, inv.uses ?? 0));
  snapshots.set(guild.id, uses);
  return uses;
}

// Compare two use-count maps. Pure, so it is easy to test.
function diffInvites(before, after) {
  if (!before || !after) return { source: 'unavailable', codes: [] };
  const gained = [];
  after.forEach((uses, code) => { if (uses > (before.get(code) ?? 0)) gained.push(code); });
  if (gained.length === 1) return { source: 'invite', codes: gained };
  return { source: gained.length ? 'ambiguous' : 'unknown', codes: gained.slice(0, 5) };
}

async function attributeJoin(guild) {
  const before = snapshots.get(guild.id);
  const invites = await readInvites(guild);
  if (!invites) return { source: 'unavailable', codes: [] };
  const after = new Map();
  invites.forEach((inv) => after.set(inv.code, inv.uses ?? 0));
  snapshots.set(guild.id, after);
  const result = diffInvites(before, after);
  if (result.source === 'invite') {
    const inv = invites.get(result.codes[0]);
    result.inviterId = inv?.inviterId || null;
    result.channelId = inv?.channelId || null;
  }
  return result;
}

function inviteLine(attr) {
  if (attr.source === 'invite') {
    return `\`${attr.codes[0]}\`${attr.inviterId ? ` by <@${attr.inviterId}>` : ''}${attr.channelId ? ` (<#${attr.channelId}>)` : ''}`;
  }
  if (attr.source === 'ambiguous') return `Ambiguous: ${attr.codes.map((c) => `\`${c}\``).join(', ')}`;
  if (attr.source === 'unknown') return 'Unknown (vanity link, server discovery, or an invite I cannot see)';
  return 'Unavailable (I need the Manage Server permission to read invites)';
}

const ageDays = (ms) => Math.floor((Date.now() - ms) / 86_400_000);

function roleList(member) {
  const roles = [...member.roles.cache.values()].filter((r) => r.id !== member.guild.id).sort((a, b) => b.position - a.position);
  return roles.length ? clip(roles.map((r) => `<@&${r.id}>`).join(' '), 1024) : 'none';
}

async function onJoin(client, member) {
  const attr = await attributeJoin(member.guild);
  db.get().prepare('INSERT INTO joins (user_id, invite_code, source, at) VALUES (?, ?, ?, ?)')
    .run(member.id, attr.source === 'invite' ? attr.codes[0] : null, attr.source, db.now());
  if (!getSetting('join_notices')) return;
  const days = ageDays(member.user.createdTimestamp);
  await audit.postLog(client, {
    embeds: [embed({
      title: member.user.bot ? '🤖 Bot added' : '📥 Member joined',
      color: COLORS.ok,
      description: `<@${member.id}> (${member.user.username})`,
      fields: [
        { name: 'Account created', value: `${ts(member.user.createdTimestamp / 1000, 'R')}${days < NEW_ACCOUNT_DAYS ? ' ⚠️ new account' : ''}`, inline: true },
        { name: 'Members now', value: String(member.guild.memberCount ?? '?'), inline: true },
        { name: 'Invite', value: inviteLine(attr) },
      ],
    })],
  });
}

// Who did it and why, from the audit log, if it happened in the last few seconds.
async function auditActor(guild, targetId, type) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    for (const entry of logs.entries.values()) {
      if (entry.target?.id === targetId && Date.now() - entry.createdTimestamp < 10_000) {
        return { executorId: entry.executor?.id || null, reason: entry.reason || null };
      }
    }
  } catch { /* needs View Audit Log */ }
  return { executorId: null, reason: null };
}

async function onLeave(client, member) {
  if (!getSetting('join_notices')) return;
  const kick = await auditActor(member.guild, member.id, AuditLogEvent.MemberKick);
  const fields = [
    { name: 'Joined', value: member.joinedTimestamp ? ts(member.joinedTimestamp / 1000, 'R') : 'unknown', inline: true },
    { name: 'Members now', value: String(member.guild.memberCount ?? '?'), inline: true },
    { name: 'Roles held', value: roleList(member) },
  ];
  if (kick.executorId) {
    fields.push({ name: 'Kicked by', value: `<@${kick.executorId}>`, inline: true });
    if (kick.reason) fields.push({ name: 'Reason', value: clip(kick.reason, 1024) });
  }
  await audit.postLog(client, {
    embeds: [embed({
      title: kick.executorId ? '👢 Member kicked' : '📤 Member left',
      color: kick.executorId ? COLORS.warn : COLORS.muted,
      description: `<@${member.id}> (${member.user?.username || member.id})`,
      fields,
    })],
  });
}

async function onBan(client, ban) {
  if (!getSetting('join_notices')) return;
  const actor = await auditActor(ban.guild, ban.user.id, AuditLogEvent.MemberBanAdd);
  const fields = [];
  if (actor.executorId) fields.push({ name: 'Banned by', value: `<@${actor.executorId}>`, inline: true });
  if (actor.reason || ban.reason) fields.push({ name: 'Reason', value: clip(actor.reason || ban.reason, 1024) });
  await audit.postLog(client, {
    embeds: [embed({ title: '🔨 Member banned', color: COLORS.bad, description: `<@${ban.user.id}> (${ban.user.username})`, fields })],
  });
}

// ── /inviteledger ───────────────────────────────────────────────────────────

function ledgerEmbeds(invites, joinsByCode) {
  const used = [...invites.values()].filter((inv) => (inv.uses ?? 0) > 0).sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0));
  if (!used.length) return [embed({ title: '🔗 Invite ledger', description: 'No invite link has been used yet.' })];
  const lines = used.map((inv) => {
    const joined = joinsByCode.get(inv.code) || [];
    const who = joined.length ? `\n  Joined: ${joined.slice(-10).map((id) => `<@${id}>`).join(' ')}${joined.length > 10 ? ` +${joined.length - 10}` : ''}` : '';
    return `**\`${inv.code}\`** • ${inv.uses} use${inv.uses === 1 ? '' : 's'} • ${inv.inviterId ? `<@${inv.inviterId}>` : 'unknown creator'}${inv.channelId ? ` • <#${inv.channelId}>` : ''}${who}`;
  });
  const embeds = [];
  let chunk = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > 3800) {
      embeds.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(line);
    length += line.length + 1;
  }
  if (chunk.length) embeds.push(chunk);
  return embeds.slice(0, 10).map((part, index) => embed({
    title: index === 0 ? '🔗 Invite ledger' : '🔗 Invite ledger (continued)',
    description: part.join('\n'),
  }));
}

async function onInviteLedger(i) {
  if (!access.staff(i)) return tell(i, 'Only staff can read the invite ledger.');
  await i.deferReply({ flags: 64 });
  if (!i.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return i.editReply('⚠️ I need the Manage Server permission to read invites.');
  }
  const invites = await readInvites(i.guild);
  if (!invites) return i.editReply('⚠️ Discord refused to list the invites.');
  const joinsByCode = new Map();
  for (const row of db.get().prepare('SELECT user_id, invite_code FROM joins WHERE invite_code IS NOT NULL ORDER BY at').all()) {
    if (!joinsByCode.has(row.invite_code)) joinsByCode.set(row.invite_code, []);
    joinsByCode.get(row.invite_code).push(row.user_id);
  }
  const embeds = ledgerEmbeds(invites, joinsByCode);
  const posted = await audit.postLog(i.client, { embeds });
  audit.record(i.user.id, 'invite_ledger');
  if (posted) return i.editReply(`✅ Posted to the log channel: ${posted.url}`);
  return i.editReply({ content: 'No log channel is set in /setup, so here it is privately:', embeds, allowedMentions: { parse: [] } });
}

async function handleInteraction(i) {
  if (i.isChatInputCommand() && i.commandName === 'inviteledger') {
    await onInviteLedger(i);
    return true;
  }
  return false;
}

function startInviteTracking(client, guildId, intervalMs = 60_000) {
  const refresh = () => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) snapshotInvites(guild).catch(() => {});
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  onJoin, onLeave, onBan, handleInteraction, startInviteTracking, snapshotInvites, diffInvites, inviteLine, ledgerEmbeds,
};
