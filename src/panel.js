// /cas — the staff control panel. Shows the server at a glance and gives
// member tools (roles, nickname, timeout, kick) with hierarchy checks and a
// log entry for every action.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
} = require('discord.js');
const access = require('./access');
const audit = require('./audit');
const cases = require('./cases');
const signups = require('./signups');
const { embed, tell, privateReply, ts, clip, COLORS } = require('./ui');
const { config } = require('./config');

const startedAt = Math.floor(Date.now() / 1000);
const TIMEOUTS = [
  { label: 'Remove timeout', value: '0' },
  { label: '10 minutes', value: String(10 * 60) },
  { label: '1 hour', value: String(3600) },
  { label: '1 day', value: String(86400) },
  { label: '1 week', value: String(7 * 86400) },
];

const btn = (id, label, style = ButtonStyle.Secondary, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};
const navRow = () => new ActionRowBuilder().addComponents(
  btn('cas:home', 'Overview', ButtonStyle.Secondary, '🏠'),
  btn('cas:events', 'Events', ButtonStyle.Secondary, '📅'),
  btn('cas:cases', 'Open cases', ButtonStyle.Secondary, '📂'),
  btn('cas:member', 'Member tools', ButtonStyle.Primary, '🧑'),
  btn('cas:log', 'Staff log', ButtonStyle.Secondary, '📜'),
);

function homeView(i) {
  const open = cases.openCases(100);
  const intakes = open.filter((c) => c.kind === 'intake').length;
  return {
    embeds: [embed({
      title: `${i.guild.name} control panel`,
      fields: [
        { name: 'Members', value: String(i.guild.memberCount ?? '?'), inline: true },
        { name: 'Open applications', value: String(intakes), inline: true },
        { name: 'Open tickets', value: String(open.length - intakes), inline: true },
        { name: 'Upcoming events', value: String(signups.upcomingEvents(100).length), inline: true },
        { name: 'Bot online since', value: ts(startedAt, 'R'), inline: true },
        { name: 'Gateway ping', value: `${Math.max(0, i.client.ws.ping)} ms`, inline: true },
      ],
    })],
    components: [navRow()],
  };
}

function eventsView() {
  const events = signups.upcomingEvents(10);
  const lines = events.map((e) => `**${clip(e.title, 80)}** • ${ts(e.starts_at, 'f')} (${ts(e.starts_at, 'R')})${e.message_id ? ` • [signup](https://discord.com/channels/${config.guildId}/${e.channel_id}/${e.message_id})` : ''}`);
  return { embeds: [embed({ title: '📅 Upcoming events', description: lines.join('\n') || 'No upcoming events. Post one with /signup.' })], components: [navRow()] };
}

function casesView() {
  const open = cases.openCases(25);
  const lines = open.map((c) => `${c.kind === 'intake' ? '📝' : '🎫'} <#${c.channel_id}> • <@${c.opener_id}>${c.category ? ` • ${c.category}` : ''} • ${ts(c.created_at, 'R')}${c.claimed_by ? ` • handled by <@${c.claimed_by}>` : ' • unclaimed'}`);
  return { embeds: [embed({ title: '📂 Open cases', description: lines.join('\n') || 'Nothing open.' })], components: [navRow()] };
}

function logView() {
  const rows = audit.recent(15);
  const lines = rows.map((r) => {
    let summary = '';
    try { summary = JSON.parse(r.detail).summary || ''; } catch { /* ignore */ }
    return `${ts(r.at, 'R')} • <@${r.actor_id}> • \`${r.action}\`${r.target_id ? ` → <@${r.target_id}>` : ''}${summary ? ` • ${clip(summary, 60)}` : ''}`;
  });
  return { embeds: [embed({ title: '📜 Recent staff actions', description: lines.join('\n') || 'Nothing logged yet.' })], components: [navRow()] };
}

function memberPicker() {
  return {
    embeds: [embed({ title: '🧑 Member tools', description: 'Pick a member.' })],
    components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('cas:pick').setPlaceholder('Choose a member')), navRow()],
  };
}

function memberView(member) {
  const roles = [...member.roles.cache.values()].filter((r) => r.id !== member.guild.id).sort((a, b) => b.position - a.position);
  const timedOut = member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now();
  const id = member.id;
  return {
    embeds: [embed({
      title: `🧑 ${member.displayName}`,
      description: `<@${id}> (${member.user.username})`,
      fields: [
        { name: 'Joined server', value: member.joinedTimestamp ? ts(member.joinedTimestamp / 1000, 'R') : 'unknown', inline: true },
        { name: 'Account created', value: ts(member.user.createdTimestamp / 1000, 'R'), inline: true },
        { name: 'Timed out', value: timedOut ? `until ${ts(member.communicationDisabledUntilTimestamp / 1000, 'f')}` : 'no', inline: true },
        { name: `Roles (${roles.length})`, value: clip(roles.map((r) => `<@&${r.id}>`).join(' ') || 'none', 1024) },
      ],
    })],
    components: [
      new ActionRowBuilder().addComponents(
        btn(`cas:m:addrole:${id}`, 'Add role', ButtonStyle.Success, '➕'),
        btn(`cas:m:rmrole:${id}`, 'Remove role', ButtonStyle.Secondary, '➖'),
        btn(`cas:m:nick:${id}`, 'Nickname', ButtonStyle.Secondary, '✏️'),
        btn(`cas:m:timeout:${id}`, 'Timeout', ButtonStyle.Secondary, '⏳'),
        btn(`cas:m:kick:${id}`, 'Kick', ButtonStyle.Danger, '👢'),
      ),
      navRow(),
    ],
  };
}

// ── Hierarchy checks ────────────────────────────────────────────────────────

const isOwner = (i) => i.guild.ownerId === i.user.id;

// May the staff member act on this target at all? Returns an error or null.
function targetProblem(i, target, botPermission) {
  const me = i.guild.members.me;
  if (target.id === i.guild.ownerId) return 'Nobody can do that to the server owner.';
  if (target.id === me.id) return 'I will not do that to myself.';
  if (botPermission && !me.permissions.has(botPermission)) return 'I am missing the Discord permission for that.';
  if (target.roles.highest.position >= me.roles.highest.position) return 'That member is above or level with me in the role list.';
  if (!isOwner(i) && target.id !== i.user.id && target.roles.highest.position >= i.member.roles.highest.position) {
    return 'That member is above or level with you in the role list.';
  }
  return null;
}

function roleProblem(i, role) {
  const me = i.guild.members.me;
  if (!role || role.id === i.guild.id) return 'Pick a real role.';
  if (role.managed) return 'That role is managed by an integration and cannot be given by hand.';
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I need the Manage Roles permission.';
  if (role.position >= me.roles.highest.position) return 'That role is above or level with my highest role.';
  if (!isOwner(i) && role.position >= i.member.roles.highest.position) return 'That role is above or level with your highest role.';
  return null;
}

async function fetchTarget(i, userId) {
  return i.guild.members.fetch(userId).catch(() => null);
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function memberAction(i, action, userId) {
  const target = await fetchTarget(i, userId);
  if (!target) return tell(i, 'That member is no longer in the server.');
  const reason = (text) => `${text} (by ${i.user.username} via /cas)`;

  if (action === 'addrole' || action === 'rmrole') {
    const select = new RoleSelectMenuBuilder().setCustomId(`cas:m:${action === 'addrole' ? 'roleadd' : 'rolerm'}:${userId}`)
      .setPlaceholder(action === 'addrole' ? 'Role to give' : 'Role to take away');
    return i.update({ components: [new ActionRowBuilder().addComponents(select), navRow()] });
  }
  if (action === 'roleadd' || action === 'rolerm') {
    const role = i.guild.roles.cache.get(i.values[0]);
    const problem = roleProblem(i, role) || targetProblem(i, target, PermissionFlagsBits.ManageRoles);
    if (problem) return tell(i, `⚠️ ${problem}`);
    if (action === 'roleadd') await target.roles.add(role, reason('Role given'));
    else await target.roles.remove(role, reason('Role removed'));
    await audit.staffAction(i.client, {
      actor: i.user, action: action === 'roleadd' ? 'role_add' : 'role_remove', target: target.user,
      summary: action === 'roleadd' ? '➕ Role given' : '➖ Role removed', fields: [{ name: 'Role', value: `<@&${role.id}>` }],
    });
    return i.update(memberView(await fetchTarget(i, userId)));
  }
  if (action === 'nick') {
    const problem = targetProblem(i, target, PermissionFlagsBits.ManageNicknames);
    if (problem) return tell(i, `⚠️ ${problem}`);
    const input = new TextInputBuilder().setCustomId('nick').setLabel('New nickname (empty to clear)')
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(32);
    if (target.nickname) input.setValue(target.nickname);
    return i.showModal(new ModalBuilder().setCustomId(`cas:m:nicksub:${userId}`).setTitle('Set nickname')
      .addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'nicksub') {
    const problem = targetProblem(i, target, PermissionFlagsBits.ManageNicknames);
    if (problem) return tell(i, `⚠️ ${problem}`);
    const nick = i.fields.getTextInputValue('nick').trim();
    const before = target.displayName;
    await target.setNickname(nick || null, reason('Nickname changed'));
    await audit.staffAction(i.client, {
      actor: i.user, action: 'nickname', target: target.user, summary: '✏️ Nickname changed',
      fields: [{ name: 'From', value: clip(before, 100), inline: true }, { name: 'To', value: clip(nick || '(cleared)', 100), inline: true }],
    });
    return tell(i, '✅ Nickname updated.');
  }
  if (action === 'timeout') {
    const select = new StringSelectMenuBuilder().setCustomId(`cas:m:tosub:${userId}`).setPlaceholder('How long?').addOptions(TIMEOUTS);
    return i.update({ components: [new ActionRowBuilder().addComponents(select), navRow()] });
  }
  if (action === 'tosub') {
    const problem = targetProblem(i, target, PermissionFlagsBits.ModerateMembers);
    if (problem) return tell(i, `⚠️ ${problem}`);
    if (target.permissions.has(PermissionFlagsBits.Administrator)) return tell(i, '⚠️ Administrators cannot be timed out.');
    const seconds = Number(i.values[0]);
    await target.timeout(seconds ? seconds * 1000 : null, reason(seconds ? 'Timed out' : 'Timeout removed'));
    const label = TIMEOUTS.find((t) => t.value === i.values[0])?.label || `${seconds}s`;
    await audit.staffAction(i.client, {
      actor: i.user, action: 'timeout', target: target.user, summary: seconds ? '⏳ Member timed out' : '⏳ Timeout removed',
      color: seconds ? COLORS.warn : undefined, fields: [{ name: 'Length', value: label }],
    });
    return i.update(memberView(await fetchTarget(i, userId)));
  }
  if (action === 'kick') {
    const problem = targetProblem(i, target, PermissionFlagsBits.KickMembers);
    if (problem) return tell(i, `⚠️ ${problem}`);
    const input = new TextInputBuilder().setCustomId('reason').setLabel('Reason (required; this kicks them)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400);
    return i.showModal(new ModalBuilder().setCustomId(`cas:m:kicksub:${userId}`).setTitle(`Kick ${clip(target.displayName, 35)}`)
      .addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'kicksub') {
    const problem = targetProblem(i, target, PermissionFlagsBits.KickMembers);
    if (problem) return tell(i, `⚠️ ${problem}`);
    const text = i.fields.getTextInputValue('reason').trim();
    await target.kick(reason(text));
    await audit.staffAction(i.client, {
      actor: i.user, action: 'kick', target: target.user, summary: '👢 Member kicked', color: COLORS.warn,
      fields: [{ name: 'Reason', value: clip(text, 1024) }],
    });
    return tell(i, `✅ Kicked ${target.user.username}.`);
  }
  return tell(i, 'Unknown action.');
}

async function handleInteraction(i) {
  const isCommand = i.isChatInputCommand() && i.commandName === 'cas';
  const id = i.customId || '';
  if (!isCommand && !id.startsWith('cas:')) return false;
  if (!access.staff(i)) {
    await tell(i, 'The control panel is for staff only.');
    return true;
  }
  if (isCommand) {
    await i.reply(privateReply(homeView(i)));
    return true;
  }
  const [, view, action, userId] = id.split(':');
  if (view === 'home') await i.update(homeView(i));
  else if (view === 'events') await i.update(eventsView());
  else if (view === 'cases') await i.update(casesView());
  else if (view === 'log') await i.update(logView());
  else if (view === 'member') await i.update(memberPicker());
  else if (view === 'pick') {
    const target = await fetchTarget(i, i.values[0]);
    await (target ? i.update(memberView(target)) : tell(i, 'That member is not in the server.'));
  } else if (view === 'm') await memberAction(i, action, userId);
  return true;
}

module.exports = { handleInteraction, targetProblem, roleProblem };
