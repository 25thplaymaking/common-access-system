// /setup — server admins configure the bot from Discord: channels, staff
// roles, intake questions, ticket categories, and where the public panels go.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const access = require('./access');
const audit = require('./audit');
const intake = require('./intake');
const tickets = require('./tickets');
const {
  getSetting, setSetting, allSettings, parseTicketCategories, formatTicketCategories,
} = require('./settings');
const { embed, tell, privateReply, clip } = require('./ui');

const PAGES = {
  channels: 'Log and welcome channels',
  categories: 'Categories for private channels',
  access: 'Staff roles',
  intake: 'Recruitment intake',
  tickets: 'Support tickets',
};
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const ch = (id) => (id ? `<#${id}>` : '*not set*');
const roles = (ids) => (ids?.length ? ids.map((id) => `<@&${id}>`).join(' ') : '*none*');

function summary() {
  const s = allSettings();
  return embed({
    title: 'Setup',
    description: 'Pick a page below. Changes save as soon as you pick them.',
    fields: [
      { name: 'Log channel', value: ch(s.log_channel), inline: true },
      { name: 'Transcripts', value: s.transcript_channel ? ch(s.transcript_channel) : '*log channel*', inline: true },
      { name: 'Welcome channel', value: ch(s.welcome_channel), inline: true },
      { name: 'Intake category', value: ch(s.intake_category), inline: true },
      { name: 'Ticket category', value: ch(s.ticket_category), inline: true },
      { name: 'Join/leave notices', value: s.join_notices ? 'on' : 'off', inline: true },
      { name: 'Staff (full access)', value: roles(s.staff_roles) },
      { name: 'Recruiters', value: roles(s.recruiter_roles), inline: true },
      { name: 'Support', value: roles(s.support_roles), inline: true },
      { name: 'Event hosts', value: roles(s.host_roles), inline: true },
      { name: 'Roles given on accept', value: roles(s.accept_roles), inline: true },
      { name: 'Removed on accept', value: s.remove_on_accept ? `<@&${s.remove_on_accept}>` : '*none*', inline: true },
      { name: 'Intake questions', value: clip(s.intake_questions.map((q, n) => `${n + 1}. ${q}`).join('\n') || '*none*', 1024) },
      { name: 'Ticket categories', value: clip(s.ticket_categories.map((c) => c.label).join(', ') || '*none*', 1024) },
    ],
  });
}

function pageSelect(current) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:page').setPlaceholder('Choose a page')
    .addOptions(Object.entries(PAGES).map(([value, label]) => ({ label, value, default: value === current }))));
}

function channelSelect(key, placeholder, types) {
  const select = new ChannelSelectMenuBuilder().setCustomId(`setup:ch:${key}`).setPlaceholder(placeholder)
    .setChannelTypes(...types).setMinValues(0).setMaxValues(1);
  const value = getSetting(key);
  if (value) select.setDefaultChannels([value]);
  return new ActionRowBuilder().addComponents(select);
}

function roleSelect(key, placeholder, max = 10) {
  const select = new RoleSelectMenuBuilder().setCustomId(`setup:role:${key}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
  const value = getSetting(key);
  const ids = Array.isArray(value) ? value : value ? [value] : [];
  if (ids.length) select.setDefaultRoles(ids.slice(0, max));
  return new ActionRowBuilder().addComponents(select);
}

const button = (action, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`setup:btn:${action}`).setLabel(label).setStyle(style);

function view(page = 'channels') {
  const rows = [];
  if (page === 'channels') {
    rows.push(channelSelect('log_channel', 'Staff log channel', TEXT));
    rows.push(channelSelect('transcript_channel', 'Transcript channel (empty = log channel)', TEXT));
    rows.push(channelSelect('welcome_channel', 'Welcome channel for accepted recruits (optional)', TEXT));
    rows.push(new ActionRowBuilder().addComponents(button('joins', `Join/leave notices: ${getSetting('join_notices') ? 'on' : 'off'}`)));
  } else if (page === 'categories') {
    rows.push(channelSelect('intake_category', 'Category for application channels', [ChannelType.GuildCategory]));
    rows.push(channelSelect('ticket_category', 'Category for ticket channels', [ChannelType.GuildCategory]));
  } else if (page === 'access') {
    rows.push(roleSelect('staff_roles', 'Staff roles (full access to /cas and all tools)'));
    rows.push(roleSelect('recruiter_roles', 'Recruiter roles (handle applications)'));
    rows.push(roleSelect('support_roles', 'Support roles (handle tickets)'));
    rows.push(roleSelect('host_roles', 'Event host roles (may post /signup)'));
  } else if (page === 'intake') {
    rows.push(roleSelect('accept_roles', 'Roles a recruiter may give on accept', 25));
    rows.push(roleSelect('remove_on_accept', 'Role to remove on accept (optional)', 1));
    rows.push(new ActionRowBuilder().addComponents(
      button('questions', 'Edit questions'),
      button('welcome', 'Edit welcome message'),
      button('intakepanel', 'Post application panel here', ButtonStyle.Success),
    ));
  } else if (page === 'tickets') {
    rows.push(new ActionRowBuilder().addComponents(
      button('categories', 'Edit ticket categories'),
      button('ticketpanel', 'Post ticket panel here', ButtonStyle.Success),
    ));
  }
  rows.push(pageSelect(page));
  return { embeds: [summary()], components: rows };
}

// Which page a setting lives on, to redraw the right page after a change.
const PAGE_OF = {
  log_channel: 'channels', transcript_channel: 'channels', welcome_channel: 'channels',
  intake_category: 'categories', ticket_category: 'categories',
  staff_roles: 'access', recruiter_roles: 'access', support_roles: 'access', host_roles: 'access',
  accept_roles: 'intake', remove_on_accept: 'intake',
};

async function postPanel(i, payload, label) {
  const perms = i.channel?.permissionsFor?.(i.client.user);
  if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return tell(i, `⚠️ I cannot post in this channel (I need Send Messages and Embed Links).`);
  }
  const message = await i.channel.send(payload);
  audit.record(i.user.id, 'panel_post', null, { panel: label, channel_id: i.channel.id });
  return tell(i, `✅ ${label} posted: ${message.url}`);
}

async function onButton(i, action) {
  if (action === 'joins') {
    setSetting('join_notices', !getSetting('join_notices'));
    return i.update(view('channels'));
  }
  if (action === 'questions') {
    const current = getSetting('intake_questions');
    const modal = new ModalBuilder().setCustomId('setup:modal:questions').setTitle('Intake questions (up to 5)');
    for (let n = 0; n < 5; n += 1) {
      const input = new TextInputBuilder().setCustomId(`q${n}`).setLabel(`Question ${n + 1} (max ${intake.LABEL_MAX} characters)`)
        .setStyle(TextInputStyle.Short).setRequired(n === 0).setMaxLength(intake.LABEL_MAX);
      if (current[n]) input.setValue(clip(current[n], intake.LABEL_MAX));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return i.showModal(modal);
  }
  if (action === 'welcome') {
    const input = new TextInputBuilder().setCustomId('text').setLabel('Message ({user} and {server} are replaced)')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500).setValue(getSetting('welcome_message'));
    return i.showModal(new ModalBuilder().setCustomId('setup:modal:welcome').setTitle('Welcome message')
      .addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'categories') {
    const input = new TextInputBuilder().setCustomId('text').setLabel('One per line: Label | short description')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
      .setValue(formatTicketCategories(getSetting('ticket_categories')));
    return i.showModal(new ModalBuilder().setCustomId('setup:modal:categories').setTitle('Ticket categories (up to 25)')
      .addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'intakepanel') return postPanel(i, intake.panelMessage(i.guild.name), 'Application panel');
  if (action === 'ticketpanel') {
    if (!getSetting('ticket_categories').length) return tell(i, '⚠️ Add at least one ticket category first.');
    return postPanel(i, tickets.panelMessage(), 'Ticket panel');
  }
  return tell(i, 'Unknown setup action.');
}

async function onModal(i, which) {
  if (which === 'questions') {
    const questions = [0, 1, 2, 3, 4].map((n) => i.fields.getTextInputValue(`q${n}`).trim()).filter(Boolean);
    setSetting('intake_questions', questions);
    audit.record(i.user.id, 'setup_change', null, { setting: 'intake_questions' });
    return i.isFromMessage() ? i.update(view('intake')) : tell(i, '✅ Saved.');
  }
  if (which === 'welcome') {
    setSetting('welcome_message', i.fields.getTextInputValue('text').trim());
    audit.record(i.user.id, 'setup_change', null, { setting: 'welcome_message' });
    return i.isFromMessage() ? i.update(view('intake')) : tell(i, '✅ Saved.');
  }
  if (which === 'categories') {
    const list = parseTicketCategories(i.fields.getTextInputValue('text'));
    if (!list.length) return tell(i, '⚠️ Enter at least one category.');
    setSetting('ticket_categories', list);
    audit.record(i.user.id, 'setup_change', null, { setting: 'ticket_categories' });
    return i.isFromMessage() ? i.update(view('tickets')) : tell(i, '✅ Saved.');
  }
  return tell(i, 'Unknown form.');
}

async function handleInteraction(i) {
  const isCommand = i.isChatInputCommand() && i.commandName === 'setup';
  const id = i.customId || '';
  if (!isCommand && !id.startsWith('setup:')) return false;
  if (!access.admin(i)) {
    await tell(i, 'Only server admins (Administrator or Manage Server) can change the setup.');
    return true;
  }
  if (isCommand) {
    await i.reply(privateReply(view('channels')));
    return true;
  }
  const [, type, key] = id.split(':');
  if (type === 'page') await i.update(view(i.values[0]));
  else if (type === 'ch') {
    setSetting(key, i.values[0] || '');
    audit.record(i.user.id, 'setup_change', null, { setting: key });
    await i.update(view(PAGE_OF[key]));
  } else if (type === 'role') {
    setSetting(key, key === 'remove_on_accept' ? (i.values[0] || '') : [...i.values]);
    audit.record(i.user.id, 'setup_change', null, { setting: key });
    await i.update(view(PAGE_OF[key]));
  } else if (type === 'btn') await onButton(i, key);
  else if (type === 'modal') await onModal(i, key);
  return true;
}

module.exports = { handleInteraction, view, PAGES };
