// Slash commands. They are registered to your one server on startup, and
// only re-sent to Discord when the definitions change.
const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');

function commandBuilders() {
  return [
    new SlashCommandBuilder().setName('cas').setDescription('Open the staff control panel')
      .setContexts(InteractionContextType.Guild),
    new SlashCommandBuilder().setName('setup').setDescription('Configure the bot: channels, staff roles, intake and tickets')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild),
    new SlashCommandBuilder().setName('signup').setDescription('Post an event signup in this channel')
      .setContexts(InteractionContextType.Guild),
    new SlashCommandBuilder().setName('inviteledger').setDescription('Post which invite links were used and who joined through them')
      .setContexts(InteractionContextType.Guild),
  ];
}

const commandJson = () => commandBuilders().map((c) => c.toJSON());

function shape(c) {
  const d = typeof c.toJSON === 'function' ? c.toJSON() : c;
  return JSON.stringify({
    name: d.name, description: d.description, options: d.options || [],
    perms: d.default_member_permissions ?? null,
  });
}

async function ensureGuildCommands(client, guildId) {
  const desired = commandJson();
  const current = await client.application.commands.fetch({ guildId });
  const a = [...current.values()].map(shape).sort();
  const b = desired.map(shape).sort();
  if (JSON.stringify(a) === JSON.stringify(b)) return { changed: false, count: desired.length };
  await client.application.commands.set(desired, guildId);
  return { changed: true, count: desired.length };
}

module.exports = { commandBuilders, commandJson, ensureGuildCommands };
