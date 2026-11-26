// Settings that come from the environment (.env). Everything a server admin
// can change from Discord lives in the database instead (see settings.js).

function readConfig(env = process.env) {
  const config = {
    token: String(env.DISCORD_BOT_TOKEN || '').trim(),
    guildId: String(env.DISCORD_GUILD_ID || '').trim(),
    timezone: String(env.TIMEZONE || 'UTC').trim(),
    dataDir: String(env.DATA_DIR || './data').trim(),
    botName: String(env.BOT_NAME || 'Common Access System').trim(),
    accentColor: parseColor(env.ACCENT_COLOR, 0x3b82f6),
    iconUrl: String(env.BRAND_ICON_URL || '').trim(),
    reminderMinutes: positiveInt(env.REMINDER_MINUTES, 30),
  };
  return config;
}

function parseColor(value, fallback) {
  const text = String(value || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(text) ? parseInt(text, 16) : fallback;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Returns a list of problems; empty means the bot can start.
function configProblems(config) {
  const problems = [];
  if (!config.token) problems.push('DISCORD_BOT_TOKEN is not set');
  if (!/^\d{17,20}$/.test(config.guildId)) problems.push('DISCORD_GUILD_ID must be your server ID (17-20 digits)');
  if (!validTimezone(config.timezone)) problems.push(`TIMEZONE "${config.timezone}" is not a valid IANA zone (e.g. America/New_York)`);
  return problems;
}

const config = readConfig();

module.exports = { config, readConfig, configProblems, parseColor, validTimezone };
