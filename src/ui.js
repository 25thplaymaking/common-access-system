// One look for everything the bot posts. Name, color and icon come from .env
// so each community can brand its own copy.
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { config } = require('./config');
const { version } = require('../package.json');

const COLORS = { ok: 0x22c55e, warn: 0xeab308, bad: 0xef4444, muted: 0x6b7280 };

function embed({ title, description, fields, color, footer, image, url } = {}) {
  const e = new EmbedBuilder().setColor(color ?? config.accentColor).setTimestamp();
  if (title) e.setTitle(String(title).slice(0, 256));
  if (url) e.setURL(url);
  if (description) e.setDescription(String(description).slice(0, 4096));
  if (Array.isArray(fields) && fields.length) {
    e.addFields(fields.slice(0, 25).map((f) => ({
      name: String(f.name || '​').slice(0, 256),
      value: String(f.value || '​').slice(0, 1024),
      inline: Boolean(f.inline),
    })));
  }
  if (image) e.setImage(image);
  const text = `${footer || config.botName} • v${version}`;
  e.setFooter(config.iconUrl ? { text, iconURL: config.iconUrl } : { text });
  return e;
}

// A private reply (only the clicker sees it).
function privateReply(content, extra = {}) {
  const base = typeof content === 'string' ? { content } : content;
  return { ...base, ...extra, flags: MessageFlags.Ephemeral };
}

// Reply privately whether or not the interaction was already answered.
async function tell(i, content) {
  const payload = typeof content === 'string' ? { content } : content;
  if (i.deferred || i.replied) return i.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

const userTag = (user) => user?.globalName || user?.username || 'Unknown';
const ts = (seconds, style = 'f') => `<t:${Math.floor(seconds)}:${style}>`;
const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

module.exports = { COLORS, embed, privateReply, tell, userTag, ts, clip };
