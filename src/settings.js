// Server settings an admin changes from Discord with /setup. Stored as JSON
// values in the settings table; every key has a default here.
const db = require('./db');

const DEFAULTS = {
  log_channel: '',          // staff log: joins, leaves, staff actions
  transcript_channel: '',   // closed ticket/intake transcripts (falls back to log)
  welcome_channel: '',      // public welcome for accepted recruits (optional)
  staff_roles: [],          // full access to every staff tool
  recruiter_roles: [],      // handle intake cases
  support_roles: [],        // handle tickets
  host_roles: [],           // may post event signups
  accept_roles: [],         // roles a recruiter may give on accept
  remove_on_accept: '',     // role taken away on accept (e.g. "Guest")
  intake_category: '',      // Discord category for intake channels
  ticket_category: '',      // Discord category for ticket channels
  join_notices: true,
  intake_questions: [
    'How did you find us?',
    'How old are you?',
    'What time zone are you in? When can you play?',
    'Any previous experience? Tell us about it.',
    'Why do you want to join?',
  ],
  ticket_categories: [
    { label: 'General help', description: 'Questions and anything else' },
    { label: 'Report a member', description: 'Report behaviour to staff in private' },
    { label: 'Technical issue', description: 'Server, mods or bot problems' },
  ],
  welcome_message: 'Welcome aboard, {user}! Check the server channels to get started.',
};

function getSetting(key) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return structuredClone(DEFAULTS[key]);
  try {
    return JSON.parse(row.value);
  } catch {
    return structuredClone(DEFAULTS[key]);
  }
}

function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  db.get().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function allSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = getSetting(key);
  return out;
}

// "Label | description" per line, up to 25 (Discord's select menu limit).
function parseTicketCategories(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 25).map((line) => {
    const [label, ...rest] = line.split('|');
    return { label: label.trim().slice(0, 100), description: rest.join('|').trim().slice(0, 100) };
  }).filter((c) => c.label);
}

function formatTicketCategories(list) {
  return list.map((c) => (c.description ? `${c.label} | ${c.description}` : c.label)).join('\n');
}

module.exports = { DEFAULTS, getSetting, setSetting, allSettings, parseTicketCategories, formatTicketCategories };
