// Common Access System: entry point. One process, one Discord server.
const path = require('path');
const { Client, GatewayIntentBits, Partials, PermissionsBitField, OAuth2Scopes, Events } = require('discord.js');
const { config, configProblems } = require('./config');
const db = require('./db');

const problems = configProblems(config);
if (problems.length) {
  for (const p of problems) console.error(`[config] ${p}`);
  console.error('[config] Copy .env.example to .env and fill it in. See README.md.');
  process.exit(1);
}
db.open(path.join(config.dataDir, 'cas.sqlite'));

// Feature modules load after the database is open.
const signups = require('./signups');
const cases = require('./cases');
const intake = require('./intake');
const tickets = require('./tickets');
const members = require('./members');
const panel = require('./panel');
const setup = require('./setup');
const { ensureGuildCommands } = require('./commands');
const { tell } = require('./ui');

// Everything the bot can do needs these. Shown as an invite link on startup.
const BOT_PERMISSIONS = new PermissionsBitField([
  'ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone',
  'ManageChannels', 'ManageRoles', 'ManageNicknames', 'KickMembers', 'ModerateMembers', 'ManageGuild', 'ViewAuditLog',
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // privileged: join/leave notices, member tools
    GatewayIntentBits.GuildModeration,   // ban notices
    GatewayIntentBits.GuildInvites,      // keeps invite use counts fresh
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,    // privileged: ticket and application transcripts
  ],
  partials: [Partials.GuildMember, Partials.User],
  allowedMentions: { parse: [] },        // nothing pings unless a message says so
});

const isHome = (guildId) => guildId === config.guildId;

client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild() || !isHome(i.guildId)) {
    if (i.isRepliable()) await i.reply({ content: 'This bot only works in its own server.', flags: 64 }).catch(() => {});
    return;
  }
  try {
    const id = i.customId || '';
    if (id.startsWith('case:')) {
      const [, action, caseId] = id.split(':');
      const row = cases.caseById(Number(caseId));
      if (!row) await tell(i, 'I have no record of this case.');
      else if (!(await intake.handleCaseAction(i, action, row))) await cases.handleButton(i, action, row);
      return;
    }
    for (const module of [setup, panel, signups, intake, tickets, members]) {
      if (await module.handleInteraction(i)) return;
    }
    if (i.isRepliable()) await tell(i, 'This button is no longer active.');
  } catch (e) {
    console.error(`[interaction] ${i.customId || i.commandName || i.type} failed:`, e);
    if (i.isRepliable()) await tell(i, '⚠️ Something went wrong. The error was logged for the bot owner.').catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, (m) => {
  if (isHome(m.guild.id)) members.onJoin(client, m).catch((e) => console.error('[members] join:', e.message));
});
client.on(Events.GuildMemberRemove, (m) => {
  if (isHome(m.guild.id)) members.onLeave(client, m).catch((e) => console.error('[members] leave:', e.message));
});
client.on(Events.GuildBanAdd, (ban) => {
  if (isHome(ban.guild.id)) members.onBan(client, ban).catch((e) => console.error('[members] ban:', e.message));
});
client.on(Events.InviteCreate, (inv) => { if (inv.guild && isHome(inv.guild.id)) members.snapshotInvites(inv.guild).catch(() => {}); });
client.on(Events.InviteDelete, (inv) => { if (inv.guild && isHome(inv.guild.id)) members.snapshotInvites(inv.guild).catch(() => {}); });

client.once(Events.ClientReady, async () => {
  console.log(`[ready] ${config.botName} logged in as ${client.user.tag}`);
  const invite = client.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: BOT_PERMISSIONS });
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.warn(`[ready] I am not in server ${config.guildId} yet. Invite me with:\n  ${invite}`);
  } else {
    console.log(`[ready] serving "${guild.name}"`);
    const me = await guild.members.fetchMe();
    const missing = BOT_PERMISSIONS.missing(me.permissions);
    if (missing.length) console.warn(`[ready] missing permissions: ${missing.join(', ')}. Re-invite with:\n  ${invite}`);
    ensureGuildCommands(client, config.guildId)
      .then((r) => console.log(`[commands] ${r.changed ? 'registered' : 'up to date:'} ${r.count} commands`))
      .catch((e) => console.error('[commands] registration failed:', e.message));
    members.startInviteTracking(client, config.guildId);
  }
  const others = client.guilds.cache.filter((g) => g.id !== config.guildId);
  if (others.size) console.warn(`[ready] I am also in ${others.size} other server(s); I ignore them.`);
  signups.startScheduler(client);
});

function shutdown(signal) {
  console.log(`[exit] ${signal}, closing`);
  // Timers are unref'd, so the process ends once the gateway and database close.
  client.destroy().finally(() => db.close());
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((e) => {
  console.error('[login] failed:', e.message);
  if (/disallowed intents/i.test(e.message)) {
    console.error('[login] Turn on "Server Members Intent" and "Message Content Intent" in the Discord Developer Portal (Bot tab).');
  }
  // Let open handles close on their own; a hard exit here can crash Node on Windows.
  process.exitCode = 1;
  client.destroy().finally(() => db.close());
});
