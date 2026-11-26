// Event signups: a host runs /signup, fills a form, picks who to ping, and the
// bot posts an RSVP card with a live roster. The bot reminds the people who
// signed up before the start and pings the chosen roles at the start.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, PermissionFlagsBits,
} = require('discord.js');
const crypto = require('crypto');
const db = require('./db');
const access = require('./access');
const audit = require('./audit');
const { config } = require('./config');
const { embed, tell, privateReply, ts, clip, COLORS, userTag } = require('./ui');
const { parseEventTime, formatWallClock, googleCalendarUrl } = require('./time');

const STATUSES = {
  accept: { label: 'Accept', emoji: '✅', style: ButtonStyle.Success, heading: 'Accepted' },
  tentative: { label: 'Tentative', emoji: '❓', style: ButtonStyle.Secondary, heading: 'Tentative' },
  decline: { label: 'Decline', emoji: '❌', style: ButtonStyle.Danger, heading: 'Declined' },
};
const LATE_LIMIT_SECONDS = 2 * 3600;   // never send a reminder or start ping more than 2 h late
const END_AFTER_SECONDS = 12 * 3600;   // close RSVPs this long after the start
const DRAFT_TTL_MS = 15 * 60 * 1000;
const drafts = new Map();              // token -> draft (between the form and the Post button)

// ── Data ────────────────────────────────────────────────────────────────────

const eventById = (id) => db.get().prepare('SELECT * FROM events WHERE id = ?').get(id);
const eventByMessage = (messageId) => db.get().prepare('SELECT * FROM events WHERE message_id = ?').get(messageId);
const rsvpsFor = (eventId) => db.get().prepare('SELECT * FROM rsvps WHERE event_id = ? ORDER BY updated_at').all(eventId);

function upcomingEvents(limit = 10) {
  return db.get().prepare("SELECT * FROM events WHERE status = 'open' AND starts_at > ? ORDER BY starts_at LIMIT ?")
    .all(db.now() - LATE_LIMIT_SECONDS, limit);
}

// Set (or clear, when the same status is clicked again) a member's RSVP.
// Returns { status, error }.
function setRsvp(event, userId, name, status) {
  const current = db.get().prepare('SELECT status FROM rsvps WHERE event_id = ? AND user_id = ?').get(event.id, userId);
  if (current?.status === status) {
    db.get().prepare('DELETE FROM rsvps WHERE event_id = ? AND user_id = ?').run(event.id, userId);
    return { status: null };
  }
  if (status === 'tentative' && !event.allow_tentative) return { error: 'Tentative is switched off for this event.' };
  if (status === 'accept' && event.max_participants) {
    const { n } = db.get().prepare("SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ? AND status = 'accept' AND user_id != ?")
      .get(event.id, userId);
    if (n >= event.max_participants) return { error: `This event is full (${event.max_participants} places).` };
  }
  db.get().prepare(`INSERT INTO rsvps (event_id, user_id, status, name, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, name = excluded.name, updated_at = excluded.updated_at`)
    .run(event.id, userId, status, name, db.now());
  return { status };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function rosterValue(list) {
  if (!list.length) return '—';
  const out = [];
  let length = 0;
  for (const [index, r] of list.entries()) {
    const line = `<@${r.user_id}>`;
    if (length + line.length + 20 > 1024) {
      out.push(`+${list.length - index} more`);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}

function renderEvent(event) {
  const rsvps = rsvpsFor(event.id);
  const by = (status) => rsvps.filter((r) => r.status === status);
  const accepted = by('accept');
  const cap = event.max_participants ? `/${event.max_participants}` : '';
  const cancelled = event.status === 'cancelled';
  const ended = event.status === 'ended';
  const fields = [
    { name: 'When', value: `${ts(event.starts_at, 'F')} (${ts(event.starts_at, 'R')})` },
    { name: `${STATUSES.accept.emoji} Accepted (${accepted.length}${cap})`, value: rosterValue(accepted), inline: true },
  ];
  if (event.allow_tentative) fields.push({ name: `${STATUSES.tentative.emoji} Tentative (${by('tentative').length})`, value: rosterValue(by('tentative')), inline: true });
  fields.push({ name: `${STATUSES.decline.emoji} Declined (${by('decline').length})`, value: rosterValue(by('decline')), inline: true });
  const card = embed({
    title: `${cancelled ? '❌ CANCELLED: ' : ended ? 'Ended: ' : ''}${event.title}`,
    description: event.description || undefined,
    fields,
    image: event.image_url || undefined,
    color: cancelled || ended ? COLORS.muted : undefined,
    footer: `Event #${event.id} • hosted by ${event.host_name || 'staff'}`,
  });
  const components = [];
  if (event.status === 'open') {
    const row = new ActionRowBuilder();
    for (const [key, s] of Object.entries(STATUSES)) {
      if (key === 'tentative' && !event.allow_tentative) continue;
      row.addComponents(new ButtonBuilder().setCustomId(`ev:rsvp:${key}`).setLabel(s.label).setEmoji(s.emoji).setStyle(s.style));
    }
    row.addComponents(
      new ButtonBuilder().setLabel('Add to calendar').setEmoji('📅').setStyle(ButtonStyle.Link)
        .setURL(googleCalendarUrl({ title: event.title, description: event.description, startsAt: event.starts_at })),
      new ButtonBuilder().setCustomId('ev:manage').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  }
  return { embeds: [card], components };
}

// Edits to one message are queued so an older render never lands last.
const editQueues = new Map();
function queueEdit(messageId, task) {
  const previous = editQueues.get(messageId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  editQueues.set(messageId, next);
  next.finally(() => { if (editQueues.get(messageId) === next) editQueues.delete(messageId); }).catch(() => {});
  return next;
}

async function refreshMessage(client, event) {
  if (!event.message_id) return;
  await queueEdit(event.message_id, async () => {
    const channel = await client.channels.fetch(event.channel_id);
    const message = await channel.messages.fetch(event.message_id);
    await message.edit(renderEvent(eventById(event.id)));
  });
}

// ── Form ────────────────────────────────────────────────────────────────────

function eventModal(customId, title, values = {}) {
  const input = (id, label, style, opts = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
      .setRequired(Boolean(opts.required)).setMaxLength(opts.max || 100);
    if (opts.placeholder) t.setPlaceholder(opts.placeholder);
    if (values[id] != null && values[id] !== '') t.setValue(String(values[id]));
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    input('title', 'Title', TextInputStyle.Short, { required: true, max: 200 }),
    input('description', 'Description', TextInputStyle.Paragraph, { max: 2000 }),
    input('when', `Date & time (${clip(config.timezone, 25)})`, TextInputStyle.Short, { required: true, max: 40, placeholder: '2026-06-14 19:00' }),
    input('image', 'Image URL (optional)', TextInputStyle.Short, { max: 500, placeholder: 'https://…' }),
    input('max', 'Max participants (optional)', TextInputStyle.Short, { max: 4, placeholder: 'Leave empty for no limit' }),
  );
}

// Validate the form. Returns { values } or { error }.
function readEventForm(fields, nowSeconds = db.now()) {
  const title = fields.getTextInputValue('title').trim();
  const description = fields.getTextInputValue('description').trim();
  const whenText = fields.getTextInputValue('when').trim();
  const image = fields.getTextInputValue('image').trim();
  const maxText = fields.getTextInputValue('max').trim();
  const startsAt = parseEventTime(whenText, config.timezone);
  if (!title) return { error: 'The event needs a title.' };
  if (startsAt == null) return { error: `I could not read "${whenText}". Use YYYY-MM-DD HH:MM, for example 2026-06-14 19:00 (${config.timezone}).` };
  if (startsAt < nowSeconds - 300) return { error: 'That time is in the past.' };
  if (image && !/^https:\/\/\S+$/i.test(image)) return { error: 'The image must be an https:// link.' };
  let max = null;
  if (maxText) {
    max = Number(maxText);
    if (!Number.isInteger(max) || max < 1) return { error: 'Max participants must be a whole number above 0.' };
  }
  return { values: { title, description, starts_at: startsAt, image_url: image, max_participants: max } };
}

function draftPanel(token, draft) {
  const roles = new RoleSelectMenuBuilder().setCustomId(`ev:roles:${token}`).setPlaceholder('Roles to ping at the start (optional)')
    .setMinValues(0).setMaxValues(10);
  if (draft.ping_roles.length) roles.setDefaultRoles(draft.ping_roles);
  const special = new StringSelectMenuBuilder().setCustomId(`ev:special:${token}`).addOptions(
    { label: 'No @everyone / @here', value: 'none', default: draft.ping_special === 'none' },
    { label: 'Also ping @everyone', value: 'everyone', default: draft.ping_special === 'everyone' },
    { label: 'Also ping @here', value: 'here', default: draft.ping_special === 'here' },
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ev:post:${token}`).setLabel('Post signup').setEmoji('📨').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ev:tent:${token}`).setLabel(`Tentative: ${draft.allow_tentative ? 'on' : 'off'}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ev:discard:${token}`).setLabel('Discard').setStyle(ButtonStyle.Secondary),
  );
  return {
    embeds: [embed({
      title: `Preview: ${draft.title}`,
      description: [
        `**When:** ${ts(draft.starts_at, 'F')} (${ts(draft.starts_at, 'R')})`,
        draft.max_participants ? `**Places:** ${draft.max_participants}` : null,
        '',
        'Pick who to ping when the event starts, then press **Post signup**.',
        `Members who accept get a reminder ${config.reminderMinutes} minutes before the start.`,
      ].filter((l) => l !== null).join('\n'),
    })],
    components: [new ActionRowBuilder().addComponents(roles), new ActionRowBuilder().addComponents(special), buttons],
  };
}

function takeDraft(token, userId) {
  const draft = drafts.get(token);
  if (!draft || draft.userId !== userId || Date.now() - draft.createdAt > DRAFT_TTL_MS) return null;
  return draft;
}

// ── Interactions ────────────────────────────────────────────────────────────

async function onCommand(i) {
  if (!access.host(i)) return tell(i, 'Only event hosts and staff can post signups.');
  return i.showModal(eventModal('ev:new', 'Create an event signup'));
}

async function onNewForm(i) {
  const { values, error } = readEventForm(i.fields);
  if (error) return tell(i, `⚠️ ${error}`);
  const token = crypto.randomBytes(6).toString('hex');
  const draft = { ...values, ping_roles: [], ping_special: 'none', allow_tentative: true, userId: i.user.id, channelId: i.channelId, createdAt: Date.now() };
  drafts.set(token, draft);
  for (const [key, d] of drafts) if (Date.now() - d.createdAt > DRAFT_TTL_MS) drafts.delete(key);
  return i.reply(privateReply(draftPanel(token, draft)));
}

async function onDraftChange(i, action, token) {
  const draft = takeDraft(token, i.user.id);
  if (!draft) return i.update({ content: 'This draft expired. Run /signup again.', embeds: [], components: [] });
  if (action === 'roles') draft.ping_roles = [...i.values];
  if (action === 'special') draft.ping_special = i.values[0] || 'none';
  if (action === 'tent') draft.allow_tentative = !draft.allow_tentative;
  if (action === 'discard') {
    drafts.delete(token);
    return i.update({ content: 'Draft discarded.', embeds: [], components: [] });
  }
  if (action === 'post') return postDraft(i, token, draft);
  return i.update(draftPanel(token, draft));
}

async function postDraft(i, token, draft) {
  const channel = await i.client.channels.fetch(draft.channelId).catch(() => null);
  const perms = channel?.permissionsFor?.(i.client.user);
  const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((p) => !perms?.has(PermissionFlagsBits[p]));
  if (!channel || missing.length) {
    return i.update({ content: `⚠️ I cannot post in <#${draft.channelId}>. Missing: ${missing.join(', ') || 'channel access'}.`, embeds: [], components: [] });
  }
  const hostName = i.member?.displayName || userTag(i.user);
  const result = db.get().prepare(`INSERT INTO events (channel_id, title, description, starts_at, image_url, max_participants,
    ping_roles, ping_special, allow_tentative, created_by, host_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(channel.id, draft.title, draft.description, draft.starts_at, draft.image_url, draft.max_participants,
      JSON.stringify(draft.ping_roles), draft.ping_special, draft.allow_tentative ? 1 : 0, i.user.id, clip(hostName, 80), db.now());
  const eventId = Number(result.lastInsertRowid);
  const message = await channel.send(renderEvent(eventById(eventId)));
  db.get().prepare('UPDATE events SET message_id = ? WHERE id = ?').run(message.id, eventId);
  drafts.delete(token);
  audit.record(i.user.id, 'event_create', null, { event_id: eventId, title: draft.title });
  return i.update({ content: `✅ Posted: ${message.url}`, embeds: [], components: [] });
}

async function onRsvp(i, status) {
  const event = eventByMessage(i.message.id);
  if (!event || event.status !== 'open') return tell(i, 'This event is closed.');
  const { status: now, error } = setRsvp(event, i.user.id, i.member?.displayName || userTag(i.user), status);
  if (error) return tell(i, `⚠️ ${error}`);
  await i.deferUpdate();
  await queueEdit(i.message.id, () => i.message.edit(renderEvent(eventById(event.id))));
  const said = now ? `You are marked **${STATUSES[now].heading}** for **${event.title}**.` : `Your response to **${event.title}** was removed.`;
  return i.followUp(privateReply(said));
}

async function onManage(i) {
  const event = eventByMessage(i.message.id);
  if (!event) return tell(i, 'I have no record of this event.');
  if (!access.host(i)) return tell(i, 'Only event hosts and staff can manage events.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ev:edit:${event.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ev:cancel:${event.id}`).setLabel('Cancel event').setStyle(ButtonStyle.Danger),
  );
  return i.reply(privateReply({ content: `Manage **${event.title}** (event #${event.id}).`, components: [row] }));
}

async function onEditOpen(i, eventId) {
  const event = eventById(eventId);
  if (!event || !access.host(i)) return tell(i, 'You cannot edit this event.');
  return i.showModal(eventModal(`ev:editsub:${event.id}`, 'Edit event', {
    title: event.title, description: event.description, when: formatWallClock(event.starts_at, config.timezone),
    image: event.image_url, max: event.max_participants || '',
  }));
}

async function onEditSubmit(i, eventId) {
  const event = eventById(eventId);
  if (!event || !access.host(i)) return tell(i, 'You cannot edit this event.');
  const { values, error } = readEventForm(i.fields, Math.min(db.now(), event.starts_at));
  if (error) return tell(i, `⚠️ ${error}`);
  const retimed = values.starts_at !== event.starts_at;
  db.get().prepare(`UPDATE events SET title = ?, description = ?, starts_at = ?, image_url = ?, max_participants = ?,
    reminded = CASE WHEN ? THEN 0 ELSE reminded END, started = CASE WHEN ? THEN 0 ELSE started END WHERE id = ?`)
    .run(values.title, values.description, values.starts_at, values.image_url, values.max_participants, retimed ? 1 : 0, retimed ? 1 : 0, event.id);
  await refreshMessage(i.client, eventById(event.id));
  audit.record(i.user.id, 'event_edit', null, { event_id: event.id });
  return tell(i, '✅ Event updated.');
}

async function onCancel(i, eventId, confirmed) {
  const event = eventById(eventId);
  if (!event || !access.host(i)) return tell(i, 'You cannot cancel this event.');
  if (!confirmed) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ev:cancelyes:${event.id}`).setLabel('Yes, cancel it').setStyle(ButtonStyle.Danger),
    );
    return i.update({ content: `Cancel **${event.title}**? The signup stays visible, marked cancelled, and RSVPs close.`, components: [row] });
  }
  db.get().prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(event.id);
  await refreshMessage(i.client, eventById(event.id));
  audit.record(i.user.id, 'event_cancel', null, { event_id: event.id, title: event.title });
  return i.update({ content: '✅ Event cancelled.', components: [] });
}

async function handleInteraction(i) {
  if (i.isChatInputCommand() && i.commandName === 'signup') {
    await onCommand(i);
    return true;
  }
  const id = i.customId || '';
  if (!id.startsWith('ev:')) return false;
  const [, action, arg] = id.split(':');
  if (i.isModalSubmit()) {
    if (action === 'new') await onNewForm(i);
    else if (action === 'editsub') await onEditSubmit(i, Number(arg));
    return true;
  }
  if (action === 'rsvp') await onRsvp(i, arg);
  else if (action === 'manage') await onManage(i);
  else if (action === 'edit') await onEditOpen(i, Number(arg));
  else if (action === 'cancel') await onCancel(i, Number(arg), false);
  else if (action === 'cancelyes') await onCancel(i, Number(arg), true);
  else if (['roles', 'special', 'tent', 'post', 'discard'].includes(action)) await onDraftChange(i, action, arg);
  return true;
}

// ── Reminders ───────────────────────────────────────────────────────────────

async function tick(client, nowSeconds = db.now()) {
  const lead = config.reminderMinutes * 60;
  const open = db.get().prepare("SELECT * FROM events WHERE status = 'open'").all();
  for (const event of open) {
    try {
      const late = nowSeconds - event.starts_at;
      if (!event.reminded && event.starts_at - lead <= nowSeconds) {
        db.get().prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(event.id);
        if (late < LATE_LIMIT_SECONDS && late < 0) await sendReminder(client, event);
      }
      if (!event.started && event.starts_at <= nowSeconds) {
        db.get().prepare('UPDATE events SET started = 1 WHERE id = ?').run(event.id);
        if (late < LATE_LIMIT_SECONDS) await sendStartPing(client, event);
      }
      if (late >= END_AFTER_SECONDS) {
        db.get().prepare("UPDATE events SET status = 'ended' WHERE id = ?").run(event.id);
        await refreshMessage(client, eventById(event.id));
      }
    } catch (e) {
      console.error(`[signups] event ${event.id} tick failed:`, e.message);
    }
  }
}

async function replyToEvent(client, event, content, allowedMentions) {
  const channel = await client.channels.fetch(event.channel_id);
  const reply = event.message_id ? { messageReference: event.message_id, failIfNotExists: false } : undefined;
  return channel.send({ content, allowedMentions, reply });
}

// Split mentions into messages under Discord's 2000-character limit, at most
// 100 users each (the allowedMentions limit).
function mentionChunks(userIds, headroom = 300) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const id of userIds) {
    const size = id.length + 4;
    if (current.length && (length + size > 2000 - headroom || current.length >= 100)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(id);
    length += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function sendReminder(client, event) {
  const going = rsvpsFor(event.id).filter((r) => r.status === 'accept' || r.status === 'tentative');
  if (!going.length) return;
  for (const [index, users] of mentionChunks(going.map((r) => r.user_id)).entries()) {
    const head = index === 0 ? `⏰ **${clip(event.title, 200)}** starts ${ts(event.starts_at, 'R')}.\n` : '';
    await replyToEvent(client, event, `${head}${users.map((u) => `<@${u}>`).join(' ')}`, { users });
  }
}

async function sendStartPing(client, event) {
  const roles = JSON.parse(event.ping_roles || '[]');
  const special = event.ping_special === 'everyone' ? '@everyone' : event.ping_special === 'here' ? '@here' : '';
  const pings = [special, ...roles.map((r) => `<@&${r}>`)].filter(Boolean).join(' ');
  const allowed = { roles, ...(special ? { parse: ['everyone'] } : {}) };
  await replyToEvent(client, event, `🚀 **${clip(event.title, 200)}** is starting now!${pings ? `\n${pings}` : ''}`, allowed);
}

function startScheduler(client, intervalMs = 30_000) {
  const timer = setInterval(() => tick(client).catch((e) => console.error('[signups] tick failed:', e.message)), intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  handleInteraction, startScheduler, tick, setRsvp, mentionChunks, renderEvent, readEventForm, upcomingEvents, eventById, eventByMessage, drafts,
};
