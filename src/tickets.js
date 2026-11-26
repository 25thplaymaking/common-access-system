// Support tickets. A public panel lists the ticket categories; picking one
// opens a short form and then a private channel with the support team.
const {
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const cases = require('./cases');
const { getSetting } = require('./settings');
const { embed, tell, clip } = require('./ui');

function panelMessage() {
  const categories = getSetting('ticket_categories');
  const select = new StringSelectMenuBuilder().setCustomId('ticket:pick').setPlaceholder('Choose what you need help with')
    .addOptions(categories.slice(0, 25).map((c, index) => ({
      label: clip(c.label, 100), value: String(index), ...(c.description ? { description: clip(c.description, 100) } : {}),
    })));
  return {
    embeds: [embed({
      title: 'Contact staff',
      description: 'Need help or want to talk to staff in private? Choose a category below and a private channel will open.',
    })],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

async function onPick(i) {
  const existing = cases.openCaseFor('ticket', i.user.id);
  if (existing) return tell(i, `You already have an open ticket: <#${existing.channel_id}>`);
  const index = Number(i.values[0]);
  const category = getSetting('ticket_categories')[index];
  if (!category) return tell(i, 'That category no longer exists. Please pick again.');
  const modal = new ModalBuilder().setCustomId(`ticket:form:${index}`).setTitle(clip(category.label, 45)).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Tell us more')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)),
  );
  await i.showModal(modal);
  // Reset the menu so the same category can be picked again later.
  await i.message.edit(panelMessage()).catch(() => {});
  return null;
}

async function onForm(i, index) {
  await i.deferReply({ flags: 64 });
  const category = getSetting('ticket_categories')[index]?.label || 'General';
  const answers = [
    { question: 'Subject', answer: i.fields.getTextInputValue('subject').trim() },
    { question: 'Details', answer: i.fields.getTextInputValue('details').trim() },
  ];
  const { channel, error } = await cases.openCase(i, 'ticket', { category, answers, intro: 'Staff will reply here soon.' });
  if (error) return i.editReply(`⚠️ ${error}`);
  return i.editReply(`✅ Your ticket is open: ${channel}`);
}

async function handleInteraction(i) {
  const id = i.customId || '';
  if (id === 'ticket:pick' && i.isStringSelectMenu()) {
    await onPick(i);
    return true;
  }
  if (id.startsWith('ticket:form:') && i.isModalSubmit()) {
    await onForm(i, Number(id.split(':')[2]));
    return true;
  }
  return false;
}

module.exports = { handleInteraction, panelMessage };
