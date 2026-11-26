// Recruitment intake. A public panel has a Start button; the applicant fills a
// form and gets a private channel with the recruiters. A recruiter accepts
// (gives the picked roles) or denies (with an optional reason sent by DM).
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const access = require('./access');
const audit = require('./audit');
const cases = require('./cases');
const { getSetting } = require('./settings');
const { embed, tell, privateReply, clip, COLORS } = require('./ui');

const LABEL_MAX = 45; // Discord's limit for a form field label
const picks = new Map(); // `${caseId}:${staffId}` -> role ids picked for accept

function panelMessage(guildName) {
  return {
    embeds: [embed({
      title: `Join ${guildName}`,
      description: 'Want to join? Press **Start application**, answer a few questions, and a recruiter will talk to you in a private channel.',
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('intake:start').setLabel('Start application').setEmoji('📝').setStyle(ButtonStyle.Success),
    )],
  };
}

function questionModal(questions) {
  const modal = new ModalBuilder().setCustomId('intake:form').setTitle('Application');
  questions.slice(0, 5).forEach((q, index) => {
    const input = new TextInputBuilder().setCustomId(`q${index}`).setLabel(clip(q, LABEL_MAX))
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    if (q.length > LABEL_MAX) input.setPlaceholder(clip(q, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

async function onStart(i) {
  const existing = cases.openCaseFor('intake', i.user.id);
  if (existing) return tell(i, `You already have an open application: <#${existing.channel_id}>`);
  const questions = getSetting('intake_questions').filter(Boolean);
  if (!questions.length) return tell(i, 'Applications are not set up yet. Please ask a staff member.');
  return i.showModal(questionModal(questions));
}

async function onForm(i) {
  await i.deferReply({ flags: 64 });
  const questions = getSetting('intake_questions').filter(Boolean).slice(0, 5);
  const answers = questions.map((question, index) => {
    let answer = '';
    try { answer = i.fields.getTextInputValue(`q${index}`); } catch { /* questions changed mid-form */ }
    return { question, answer: answer.trim() };
  });
  const { channel, error } = await cases.openCase(i, 'intake', {
    answers, intro: 'Thanks for applying! A recruiter will be with you soon. You can add anything else here.',
  });
  if (error) return i.editReply(`⚠️ ${error}`);
  return i.editReply(`✅ Your application is open: ${channel}`);
}

// ── Accept ──────────────────────────────────────────────────────────────────

// Roles a recruiter may hand out: configured, still existing, and below the bot.
function acceptableRoles(guild) {
  const me = guild.members.me;
  return getSetting('accept_roles')
    .map((id) => guild.roles.cache.get(id))
    .filter((role) => role && !role.managed && role.id !== guild.id && (!me || role.position < me.roles.highest.position));
}

function acceptPanel(row, guild, picked) {
  const roles = acceptableRoles(guild);
  const components = [];
  if (roles.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`case:acceptroles:${row.id}`).setPlaceholder('Roles to give (optional)')
      .setMinValues(0).setMaxValues(Math.min(roles.length, 25))
      .addOptions(roles.slice(0, 25).map((r) => ({ label: clip(r.name, 100), value: r.id, default: picked.includes(r.id) })))));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`case:acceptgo:${row.id}`).setLabel('Accept applicant').setEmoji('✅').setStyle(ButtonStyle.Success),
  ));
  const removeRole = getSetting('remove_on_accept');
  const lines = [
    `Accepting <@${row.opener_id}>.`,
    roles.length ? 'Pick the roles to give, then press **Accept applicant**.' : 'No accept roles are set up in /setup, so no roles will be given.',
    removeRole ? `<@&${removeRole}> will be removed.` : null,
    'The application closes and the transcript is saved.',
  ].filter(Boolean);
  return privateReply({ content: lines.join('\n'), components, allowedMentions: { parse: [] } });
}

async function applyAccept(i, row) {
  const guild = i.guild;
  const member = await guild.members.fetch(row.opener_id).catch(() => null);
  if (!member) return { error: 'The applicant has left the server.' };
  const allowed = new Set(acceptableRoles(guild).map((r) => r.id));
  const chosen = (picks.get(`${row.id}:${i.user.id}`) || []).filter((id) => allowed.has(id));
  const given = [];
  for (const id of chosen) {
    if (member.roles.cache.has(id)) continue;
    await member.roles.add(id, `Accepted by ${i.user.username}`);
    given.push(id);
  }
  const removeId = getSetting('remove_on_accept');
  let removed = null;
  if (removeId && member.roles.cache.has(removeId)) {
    await member.roles.remove(removeId, `Accepted by ${i.user.username}`).then(() => { removed = removeId; })
      .catch((e) => console.error('[intake] could not remove role:', e.message));
  }
  picks.delete(`${row.id}:${i.user.id}`);
  return { member, given, removed };
}

async function welcome(client, member) {
  const channelId = getSetting('welcome_channel');
  const text = getSetting('welcome_message').replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', member.guild.name);
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    await channel?.send({ content: text, allowedMentions: { users: [member.id] } }).catch((e) => console.error('[intake] welcome failed:', e.message));
  }
  await member.send(text.replaceAll(`<@${member.id}>`, member.displayName)).catch(() => {}); // DMs may be closed
}

async function handleCaseAction(i, action, row) {
  if (row.kind !== 'intake') return false;
  if (!['accept', 'acceptroles', 'acceptgo', 'deny', 'denysub'].includes(action)) return false;
  if (!access.handler(i, 'intake')) {
    await tell(i, 'Only recruiters and staff can do that.');
    return true;
  }
  if (row.status !== 'open') {
    await tell(i, 'This application is already closed.');
    return true;
  }
  if (action === 'accept') {
    await i.reply(acceptPanel(row, i.guild, picks.get(`${row.id}:${i.user.id}`) || []));
  } else if (action === 'acceptroles') {
    picks.set(`${row.id}:${i.user.id}`, [...i.values]);
    await i.update(acceptPanel(row, i.guild, [...i.values]));
  } else if (action === 'acceptgo') {
    await i.deferUpdate();
    const { member, given, removed, error } = await applyAccept(i, row).catch((e) => ({ error: e.message }));
    if (error) {
      await i.editReply({ content: `⚠️ ${error}`, components: [] });
      return true;
    }
    const roleText = given.length ? given.map((r) => `<@&${r}>`).join(' ') : 'none';
    await cases.closeCase(i.client, row, i.user.id, 'accepted', `Roles given: ${roleText}${removed ? `\nRemoved: <@&${removed}>` : ''}`);
    await welcome(i.client, member);
    await audit.staffAction(i.client, {
      actor: i.user, action: 'intake_accept', target: member.user, summary: '✅ Applicant accepted', color: COLORS.ok,
      fields: [{ name: 'Roles given', value: roleText }],
    });
    await i.editReply({ content: '✅ Accepted.', components: [] });
  } else if (action === 'deny') {
    const modal = new ModalBuilder().setCustomId(`case:denysub:${row.id}`).setTitle('Deny application').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (sent to the applicant by DM)')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
    );
    await i.showModal(modal);
  } else if (action === 'denysub') {
    await i.deferReply({ flags: 64 });
    const reason = i.fields.getTextInputValue('reason').trim();
    await cases.closeCase(i.client, row, i.user.id, 'denied', reason ? `Reason: ${reason}` : '');
    const user = await i.client.users.fetch(row.opener_id).catch(() => null);
    const dm = `Your application to **${i.guild.name}** was not accepted.${reason ? `\nReason: ${reason}` : ''}`;
    await user?.send(dm).catch(() => {});
    await audit.staffAction(i.client, {
      actor: i.user, action: 'intake_deny', target: user || { id: row.opener_id }, summary: '⛔ Applicant denied', color: COLORS.bad,
      fields: reason ? [{ name: 'Reason', value: clip(reason, 1024) }] : [],
    });
    await i.editReply('Application denied and closed.');
  }
  return true;
}

async function handleInteraction(i) {
  if (i.customId === 'intake:start') {
    await onStart(i);
    return true;
  }
  if (i.customId === 'intake:form' && i.isModalSubmit()) {
    await onForm(i);
    return true;
  }
  return false;
}

module.exports = { handleInteraction, handleCaseAction, panelMessage, questionModal, acceptableRoles, LABEL_MAX };
