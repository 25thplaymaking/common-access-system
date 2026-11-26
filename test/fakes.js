// Small stand-ins for discord.js objects, enough to drive the bot's
// interaction handlers end to end without connecting to Discord.
const { Collection, PermissionsBitField, ChannelType } = require('discord.js');

let nextId = 100000000000000000n;
const snowflake = () => String(nextId++);

function fakeRole(guild, name, position, extra = {}) {
  const role = { id: extra.id || snowflake(), name, position, managed: false, guild, ...extra };
  guild.roles.cache.set(role.id, role);
  return role;
}

function fakeUser(username) {
  const user = { id: snowflake(), username, globalName: null, bot: false, createdTimestamp: Date.now() - 400 * 86400000, dms: [] };
  user.send = async (payload) => { user.dms.push(payload); return { id: snowflake() }; };
  return user;
}

function fakeMember(guild, user, { roles = [], permissions = [] } = {}) {
  const cache = new Collection();
  cache.set(guild.id, guild.roles.everyone);
  for (const r of roles) cache.set(r.id, r);
  const member = {
    id: user.id,
    user,
    guild,
    nickname: null,
    joinedTimestamp: Date.now() - 30 * 86400000,
    communicationDisabledUntilTimestamp: null,
    permissions: new PermissionsBitField(permissions),
    kicked: null,
    roles: {
      cache,
      get highest() { return [...cache.values()].sort((a, b) => b.position - a.position)[0]; },
      add: async (role) => { const r = typeof role === 'string' ? guild.roles.cache.get(role) : role; cache.set(r.id, r); },
      remove: async (role) => { cache.delete(typeof role === 'string' ? role : role.id); },
    },
    get displayName() { return member.nickname || user.globalName || user.username; },
    setNickname: async (nick) => { member.nickname = nick; },
    kick: async (reason) => { member.kicked = reason; guild.members.cache.delete(user.id); },
    timeout: async (ms) => { member.communicationDisabledUntilTimestamp = ms ? Date.now() + ms : null; },
    send: (payload) => user.send(payload),
  };
  guild.members.cache.set(user.id, member);
  return member;
}

function fakeMessage(channel, payload) {
  const message = {
    id: snowflake(),
    channel,
    channelId: channel.id,
    createdTimestamp: Date.now(),
    author: { id: channel.client.user.id, username: 'cas-bot', bot: true },
    content: payload.content || '',
    embeds: (payload.embeds || []).map((e) => (e.data ? e.data : e)),
    components: payload.components || [],
    attachments: new Collection(),
    files: payload.files || [],
    payload,
    edits: [],
    get url() { return `https://discord.com/channels/${channel.guildId}/${channel.id}/${message.id}`; },
    edit: async (next) => {
      message.edits.push(next);
      if (next.embeds) message.embeds = next.embeds.map((e) => (e.data ? e.data : e));
      if (next.components) message.components = next.components;
      return message;
    },
  };
  return message;
}

function fakeChannel(client, guild, { name = 'general', type = ChannelType.GuildText, id, overwrites = [], parent = null } = {}) {
  const channel = {
    id: id || snowflake(),
    name,
    type,
    guild,
    guildId: guild.id,
    client,
    parentId: parent,
    overwrites,
    sent: [],
    deleted: false,
    isTextBased: () => type !== ChannelType.GuildCategory,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: async (payload) => {
      const msg = fakeMessage(channel, typeof payload === 'string' ? { content: payload } : payload);
      channel.sent.push(msg);
      return msg;
    },
    delete: async () => { channel.deleted = true; },
    permissionOverwrites: {
      edits: [],
      edit: async (target, perms) => { channel.permissionOverwrites.edits.push({ target, perms }); },
    },
    messages: {
      fetch: async (arg) => {
        if (typeof arg === 'string') return channel.sent.find((m) => m.id === arg);
        const all = [...channel.sent].reverse(); // newest first, like Discord
        const start = arg?.before ? all.findIndex((m) => m.id === arg.before) + 1 : 0;
        const page = all.slice(start, start + (arg?.limit || 50));
        return new Collection(page.map((m) => [m.id, m]));
      },
    },
    toString: () => `<#${channel.id}>`,
  };
  guild.channels.cache.set(channel.id, channel);
  client.registry.set(channel.id, channel);
  return channel;
}

function fakeWorld() {
  const registry = new Map();
  const users = new Map();
  const client = {
    registry,
    user: { id: snowflake(), username: 'cas-bot' },
    ws: { ping: 42 },
    channels: { fetch: async (id) => registry.get(id) || null },
    users: { fetch: async (id) => users.get(id) || null },
  };
  const guild = {
    id: process.env.DISCORD_GUILD_ID,
    name: 'Test Unit',
    memberCount: 3,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    invitesList: new Collection(),
    auditEntries: [],
  };
  guild.roles.everyone = { id: guild.id, name: '@everyone', position: 0, managed: false };
  guild.roles.cache.set(guild.id, guild.roles.everyone);
  guild.members.fetch = async (id) => guild.members.cache.get(id) || Promise.reject(new Error('Unknown Member'));
  guild.members.fetchMe = async () => guild.members.me;
  guild.channels.create = async (opts) => fakeChannel(client, guild, { name: opts.name, overwrites: opts.permissionOverwrites, parent: opts.parent });
  guild.invites = { fetch: async () => guild.invitesList };
  guild.fetchAuditLogs = async () => ({ entries: new Collection(guild.auditEntries.map((e, n) => [String(n), e])) });

  const botUser = { ...fakeUser('cas-bot'), id: client.user.id, bot: true };
  const botRole = fakeRole(guild, 'CAS', 50, { managed: true });
  guild.members.me = fakeMember(guild, botUser, { roles: [botRole], permissions: PermissionsBitField.All });

  const addMember = (username, opts) => {
    const user = fakeUser(username);
    users.set(user.id, user);
    return fakeMember(guild, user, opts);
  };
  const owner = addMember('owner', { permissions: ['Administrator'] });
  guild.ownerId = owner.id;
  return { client, guild, addMember, owner, channel: (opts) => fakeChannel(client, guild, opts), role: (name, pos, extra) => fakeRole(guild, name, pos, extra) };
}

// A fake interaction. `kind` is 'command' | 'button' | 'select' | 'modal'.
function fakeInteraction(world, member, kind, { customId, commandName, values = [], fields = {}, channel, message } = {}) {
  const i = {
    client: world.client,
    guild: world.guild,
    guildId: world.guild.id,
    user: member.user,
    member,
    memberPermissions: member.permissions,
    channel,
    channelId: channel?.id,
    message,
    customId,
    commandName,
    values,
    replied: false,
    deferred: false,
    replies: [],
    updates: [],
    modals: [],
    followUps: [],
    inGuild: () => true,
    isRepliable: () => true,
    isChatInputCommand: () => kind === 'command',
    isModalSubmit: () => kind === 'modal',
    isStringSelectMenu: () => kind === 'select',
    isButton: () => kind === 'button',
    isFromMessage: () => Boolean(message),
    fields: { getTextInputValue: (id) => { if (!(id in fields)) throw new Error(`no field ${id}`); return fields[id]; } },
    reply: async (p) => { i.replied = true; i.replies.push(p); return p; },
    update: async (p) => { i.replied = true; i.updates.push(p); if (message && message.edit) await message.edit(p); return p; },
    deferUpdate: async () => { i.deferred = true; },
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => { i.replies.push(typeof p === 'string' ? { content: p } : p); return p; },
    followUp: async (p) => { i.followUps.push(p); return p; },
    showModal: async (m) => { i.modals.push(m); },
  };
  return i;
}

// The last thing said back to the user, as text.
function lastText(i) {
  const all = [...i.replies, ...i.followUps, ...i.updates];
  const last = all[all.length - 1];
  return typeof last === 'string' ? last : last?.content || '';
}

// Every customId in a payload's components.
function customIds(payload) {
  const ids = [];
  for (const row of payload?.components || []) {
    const data = row.toJSON ? row.toJSON() : row;
    for (const c of data.components || []) if (c.custom_id) ids.push(c.custom_id);
  }
  return ids;
}

module.exports = { fakeWorld, fakeInteraction, lastText, customIds, snowflake };
