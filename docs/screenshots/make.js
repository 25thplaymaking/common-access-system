// Makes the README screenshots from the bot's real output.
//
// 1. Runs each feature through the real interaction handlers, with the fake
//    Discord objects from test/fakes.js standing in for the gateway, and
//    records every message, form and private reply the bot produces.
// 2. Opens view.html in a headless Edge or Chrome, which draws each recorded
//    scene in a Discord-like dark theme, and saves one PNG per scene to
//    docs/images. It also saves a real transcript to docs/examples.
//
// The bot's text, cards, buttons and menus come straight from src/. The
// people, roles and chat lines typed by "members" below are example data.
//
//   npm run screenshots            (set BROWSER=<path> if Edge/Chrome is elsewhere)
process.env.DISCORD_GUILD_ID = '123456789012345678';
process.env.DISCORD_BOT_TOKEN = 'screenshots-not-a-real-token';
process.env.TIMEZONE = 'America/New_York';
process.env.BOT_NAME = 'Common Access System';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const os = require('node:os');
const db = require('../../src/db');
db.open(':memory:');

const { fakeWorld, fakeInteraction, customIds } = require('../../test/fakes');
const settings = require('../../src/settings');
const signups = require('../../src/signups');
const cases = require('../../src/cases');
const intake = require('../../src/intake');
const tickets = require('../../src/tickets');
// The panel shows how long the bot has been online; pretend it started three days ago.
const realNow = Date.now;
Date.now = () => realNow() - 3 * 86400000;
const panel = require('../../src/panel');
Date.now = realNow;
const setup = require('../../src/setup');
const members = require('../../src/members');

const ROOT = path.resolve(__dirname, '..', '..');
const IMAGES = path.join(ROOT, 'docs', 'images');
const EXAMPLES = path.join(ROOT, 'docs', 'examples');

// Route an interaction the way src/index.js does.
async function route(i) {
  const id = i.customId || '';
  if (id.startsWith('case:')) {
    const [, action, caseId] = id.split(':');
    const row = cases.caseById(Number(caseId));
    if (!(await intake.handleCaseAction(i, action, row))) await cases.handleButton(i, action, row);
    return i;
  }
  for (const m of [setup, panel, signups, intake, tickets, members]) if (await m.handleInteraction(i)) return i;
  throw new Error(`nothing handled ${id || i.commandName}`);
}

// ── The example server ──────────────────────────────────────────────────────

const w = fakeWorld();
w.guild.name = 'Northwind Company';
w.guild.memberCount = 148;
w.owner.user.globalName = 'Cpt Vance';

const role = (name, position, color) => w.role(name, position, { color });
const R = {
  command: role('Command', 45, 0xe67e22),
  staff: role('Staff', 40, 0xe74c3c),
  recruiter: role('Recruiter', 30, 0x2ecc71),
  support: role('Support', 30, 0x1abc9c),
  host: role('Event Host', 25, 0x9b59b6),
  rifleman: role('Rifleman', 10, 0x3498db),
  member: role('Member', 8, 0x95a5a6),
  guest: role('Guest', 2, 0x7f8c8d),
};

function person(name, roles = [], extra = {}) {
  const m = w.addMember(name.toLowerCase().replace(/[^a-z0-9]+/g, '.'), { roles, ...extra });
  m.user.globalName = name;
  return m;
}

const ch = (name) => w.channel({ name });
const C = {
  events: ch('events'),
  joinUs: ch('join-us'),
  help: ch('help-desk'),
  welcome: ch('welcome'),
  log: ch('staff-log'),
  admin: ch('admin'),
  applications: w.channel({ name: 'Applications', type: 4 }),
  tickets: w.channel({ name: 'Tickets', type: 4 }),
};

const P = {
  reyes: person('Sgt Reyes', [R.host, R.rifleman, R.member]),
  okafor: person('Lt Okafor', [R.staff, R.recruiter, R.member]),
  lind: person('Cpl Lindqvist', [R.support, R.rifleman, R.member]),
  admin: person('Maj Brandt', [R.command, R.staff, R.member], { permissions: ['ManageGuild'] }),
};
const roster = ['Tanaka', 'Moreau', 'Kowalski', 'Novak', 'Ibarra', 'Chen', 'Duarte', 'Walsh', 'Achebe', 'Petrov', 'Sato']
  .map((n) => person(n, [R.rifleman, R.member]));

settings.setSetting('log_channel', C.log.id);
settings.setSetting('welcome_channel', C.welcome.id);
settings.setSetting('staff_roles', [R.staff.id]);
settings.setSetting('recruiter_roles', [R.recruiter.id]);
settings.setSetting('support_roles', [R.support.id]);
settings.setSetting('host_roles', [R.host.id]);
settings.setSetting('accept_roles', [R.member.id, R.rifleman.id]);
settings.setSetting('remove_on_accept', R.guest.id);
settings.setSetting('intake_category', C.applications.id);
settings.setSetting('ticket_category', C.tickets.id);
settings.setSetting('welcome_message', 'Welcome aboard, {user}! Grab the modpack in #modlist and say hi in #general. Your first op is on the events board.');

// ── Recording ───────────────────────────────────────────────────────────────

const toJSON = (x) => (x?.toJSON ? x.toJSON() : x?.data ? x.data : x);
const BOT = { name: 'Common Access System', bot: true };
// One clock for the whole story, ending before "now", so message times,
// case open/close times and transcript lines all agree.
let clock = Date.now() - 90 * 60000;
const tick = (minutes = 1) => { clock += minutes * 60000; return clock; };
db.now = () => Math.floor(clock / 1000);

function record(payload, author = BOT, extra = {}) {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  const time = extra.time || tick();
  return {
    type: 'message',
    author,
    time,
    content: p.content || '',
    // Card timestamps follow the story clock like everything else.
    embeds: (p.embeds || []).map(toJSON).map((e) => (e.timestamp ? { ...e, timestamp: new Date(time).toISOString() } : e)),
    components: (p.components || []).map(toJSON),
    files: (p.files || []).map((f) => ({ name: f.name, size: f.attachment?.length || 0 })),
    ephemeral: Boolean(p.flags & 64) || Boolean(extra.ephemeral),
    reply: extra.reply || null,
  };
}
// A message already in a fake channel, in its latest (edited) state.
const fromChannel = (msg, extra) => record({ content: msg.content, embeds: msg.embeds, components: msg.components, files: msg.files }, msg.humanAuthor || BOT, { time: msg.createdTimestamp, ...extra });

// Something a member types (example data), so channels and transcripts read naturally.
async function say(channel, member, text) {
  const msg = await channel.send({ content: text });
  msg.author = { id: member.id, username: member.user.username, bot: false };
  msg.humanAuthor = { name: member.displayName, id: member.id };
  msg.createdTimestamp = tick(2);
  return msg;
}
async function botSays(channel, payload) {
  const msg = await channel.send(payload);
  msg.createdTimestamp = tick();
  return msg;
}

const scenes = [];
function scene(id, title, items, opts = {}) { scenes.push({ id, title, items, ...opts }); }
const ia = (member, kind, opts) => fakeInteraction(w, member, kind, opts);
const lastOf = (i) => [...i.replies, ...i.followUps, ...i.updates].at(-1);

// ── Event signups ───────────────────────────────────────────────────────────

function eventTime(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${day} 19:00`;
}

async function eventScenes() {
  const form = {
    title: 'Operation Iron Gate',
    description: 'Night assault on the river crossing. Full kit, radios on the company net.\n\n**Briefing:** 30 minutes before step-off in the briefing room\n**Modpack:** current version, check #modlist',
    when: eventTime(3),
    image: '',
    max: '12',
  };
  const cmd = await route(ia(P.reyes, 'command', { commandName: 'signup', channel: C.events }));
  scene('signup-form', 'Creating an event with /signup', [{ type: 'modal', modal: toJSON(cmd.modals[0]), values: form }], { channel: 'events', width: 560 });

  const draft = await route(ia(P.reyes, 'modal', { customId: 'ev:new', channel: C.events, fields: form }));
  const token = customIds(draft.replies[0]).find((id) => id.startsWith('ev:post:')).split(':')[2];
  const picked = await route(ia(P.reyes, 'select', { customId: `ev:roles:${token}`, values: [R.rifleman.id], channel: C.events }));
  scene('signup-draft', 'Preview, pick who to ping, post', [record(picked.updates.at(-1), BOT, { ephemeral: true })], { channel: 'events' });

  await route(ia(P.reyes, 'button', { customId: `ev:post:${token}`, channel: C.events }));
  const card = C.events.sent[0];
  card.createdTimestamp = tick();
  const accept = roster.slice(0, 8);
  for (const m of accept) await route(ia(m, 'button', { customId: 'ev:rsvp:accept', message: card, channel: C.events }));
  for (const m of roster.slice(8, 10)) await route(ia(m, 'button', { customId: 'ev:rsvp:tentative', message: card, channel: C.events }));
  await route(ia(roster[10], 'button', { customId: 'ev:rsvp:decline', message: card, channel: C.events }));
  scene('signup-card', 'A live signup card', [fromChannel(card)], { channel: 'events' });

  const event = signups.eventByMessage(card.id);
  await signups.tick(w.client, event.starts_at - 30 * 60);
  await signups.tick(w.client, event.starts_at + 1);
  const reply = { author: BOT.name, text: 'Operation Iron Gate' };
  const reminder = C.events.sent[1];
  const start = C.events.sent[2];
  const startMs = event.starts_at * 1000;
  scene('signup-reminders', 'Reminder and start ping', [
    record({ content: reminder.content }, BOT, { reply, time: startMs - 30 * 60000 }),
    record({ content: start.content }, BOT, { reply, time: startMs }),
  ], { channel: 'events', now: startMs - 30 * 60000 });
  // Put the event back to "open" so it counts as upcoming on the /cas panel.
  db.get().prepare("UPDATE events SET status = 'open', reminded = 0, started = 0 WHERE id = ?").run(event.id);
}

// ── Recruitment intake ──────────────────────────────────────────────────────

let applicant;
async function intakeScenes() {
  await route(ia(P.admin, 'button', { customId: 'setup:btn:intakepanel', channel: C.joinUs }));
  const panelMsg = C.joinUs.sent[0];
  panelMsg.createdTimestamp = tick();
  scene('intake-panel', 'The application panel', [fromChannel(panelMsg)], { channel: 'join-us' });

  applicant = person('Haddad', [R.guest]);
  const answers = {
    q0: 'A friend in the unit (Tanaka) told me about your Saturday ops.',
    q1: '24',
    q2: 'US Eastern. Weeknights after 7pm and most weekends.',
    q3: 'About 300 hours in milsim, mostly as a medic in a smaller group.',
    q4: 'I want a regular team with structure and good comms.',
  };
  const start = await route(ia(applicant, 'button', { customId: 'intake:start', channel: C.joinUs }));
  scene('intake-form', 'The application form', [{ type: 'modal', modal: toJSON(start.modals[0]), values: answers }], { channel: 'join-us', width: 560 });

  await route(ia(applicant, 'modal', { customId: 'intake:form', channel: C.joinUs, fields: answers }));
  const row = cases.openCaseFor('intake', applicant.id);
  const channel = w.guild.channels.cache.get(row.channel_id);
  const caseMsg = channel.sent[0];
  caseMsg.createdTimestamp = tick();
  await route(ia(P.okafor, 'button', { customId: `case:claim:${row.id}`, channel, message: caseMsg }));
  await say(channel, P.okafor, 'Welcome Haddad, thanks for applying. Can you make the new-member training on Thursday at 19:00 Eastern?');
  await say(channel, applicant, 'Yes, I can make that. Do I need anything installed beforehand?');
  await say(channel, P.okafor, 'Just the modpack from #modlist. See you Thursday.');
  scene('intake-case', 'A private application channel', channel.sent.map((m) => fromChannel(m)), { channel: channel.name });

  await route(ia(P.okafor, 'button', { customId: `case:accept:${row.id}`, channel }));
  const picked = await route(ia(P.okafor, 'select', { customId: `case:acceptroles:${row.id}`, values: [R.member.id, R.rifleman.id], channel }));
  scene('intake-accept', 'Accepting an applicant', [record(lastOf(picked), BOT, { ephemeral: true })], { channel: channel.name });

  const logBefore = C.log.sent.length;
  await route(ia(P.okafor, 'button', { customId: `case:acceptgo:${row.id}`, channel }));
  for (const m of C.log.sent.slice(logBefore)) m.createdTimestamp = tick(0);
  const closed = channel.sent.at(-1);
  closed.createdTimestamp = tick();
  const welcomeMsg = C.welcome.sent[0];
  welcomeMsg.createdTimestamp = tick();
  scene('intake-closed', 'Accepted: channel locked, transcript saved', [fromChannel(closed)], { channel: channel.name });
  scene('intake-welcome', 'The welcome message', [fromChannel(welcomeMsg)], { channel: 'welcome' });

  const transcript = C.log.sent.find((m) => m.files.length);
  fs.mkdirSync(EXAMPLES, { recursive: true });
  fs.writeFileSync(path.join(EXAMPLES, 'sample-transcript.txt'), transcript.files[0].attachment.toString('utf8'));

  // A second, unclaimed application so the staff panel has something open.
  const second = person('Okonkwo', [R.guest]);
  await route(ia(second, 'modal', { customId: 'intake:form', channel: C.joinUs, fields: { q0: 'Reddit', q1: '31', q2: 'UK evenings', q3: 'Some', q4: 'Teamwork' } }));
}

// ── Support tickets ─────────────────────────────────────────────────────────

async function ticketScenes() {
  await route(ia(P.admin, 'button', { customId: 'setup:btn:ticketpanel', channel: C.help }));
  const panelMsg = C.help.sent[0];
  panelMsg.createdTimestamp = tick();
  scene('ticket-panel', 'The ticket panel', [{ ...fromChannel(panelMsg), openMenu: true }], { channel: 'help-desk', height: 520 });

  const user = roster[3];
  await route(ia(user, 'modal', { customId: 'ticket:form:2', channel: C.help, fields: { subject: 'Crash when joining the server', details: 'Game closes on the loading screen since the last modpack update. I verified my files and still get it.' } }));
  const row = cases.openCaseFor('ticket', user.id);
  const channel = w.guild.channels.cache.get(row.channel_id);
  channel.sent[0].createdTimestamp = tick();
  await route(ia(P.lind, 'button', { customId: `case:claim:${row.id}`, channel, message: channel.sent[0] }));
  await say(channel, P.lind, 'Thanks Novak. Can you send your crash log? It is in your profile folder under logs.');
  await say(channel, user, 'Sure, one sec.');
  scene('ticket-case', 'A private support ticket', channel.sent.map((m) => fromChannel(m)), { channel: channel.name });
}

// ── Staff panel, setup, join notices, invite ledger ─────────────────────────

async function staffScenes() {
  const home = await route(ia(P.okafor, 'command', { commandName: 'cas', channel: C.admin }));
  scene('cas-home', 'The /cas control panel', [record(home.replies[0], BOT, { ephemeral: true })], { channel: 'admin' });

  const casesView = await route(ia(P.okafor, 'button', { customId: 'cas:cases', channel: C.admin }));
  scene('cas-cases', 'Open cases at a glance', [record(lastOf(casesView), BOT, { ephemeral: true })], { channel: 'admin' });

  const target = roster[1];
  target.joinedTimestamp = Date.now() - 95 * 86400000;
  target.user.createdTimestamp = Date.now() - 3 * 365 * 86400000;
  const pick = await route(ia(P.okafor, 'select', { customId: 'cas:pick', values: [target.id], channel: C.admin }));
  scene('cas-member', 'Member tools', [record(lastOf(pick), BOT, { ephemeral: true })], { channel: 'admin' });

  const setupView = await route(ia(P.admin, 'command', { commandName: 'setup', channel: C.admin }));
  scene('setup', 'Everything is configured with /setup', [record(setupView.replies[0], BOT, { ephemeral: true })], { channel: 'admin' });

  // Join and leave notices in the staff log.
  const recruiterInvite = { code: 'nwc-recruit', uses: 41, inviterId: P.okafor.id, channelId: C.joinUs.id };
  w.guild.invitesList.set('nwc-recruit', recruiterInvite);
  w.guild.invitesList.set('reddit-ad', { code: 'reddit-ad', uses: 17, inviterId: P.admin.id, channelId: C.joinUs.id });
  w.guild.invitesList.set('unused', { code: 'unused', uses: 0, inviterId: P.reyes.id, channelId: C.joinUs.id });
  await members.snapshotInvites(w.guild);
  const before = C.log.sent.length;
  recruiterInvite.uses += 1;
  const joiner = person('Fischer');
  joiner.user.createdTimestamp = Date.now() - 2 * 86400000;
  w.guild.memberCount = 149;
  await members.onJoin(w.client, joiner);
  const kicked = roster[10];
  w.guild.auditEntries.push({ target: { id: kicked.id }, executor: { id: P.okafor.id }, reason: 'Repeated teamkilling after two warnings', createdTimestamp: Date.now() });
  w.guild.memberCount = 148;
  await members.onLeave(w.client, kicked);
  const logItems = C.log.sent.slice(before).map((m) => { m.createdTimestamp = tick(); return fromChannel(m); });
  scene('staff-log', 'Join and leave notices', logItems, { channel: 'staff-log' });

  const ledgerBefore = C.log.sent.length;
  await route(ia(P.okafor, 'command', { commandName: 'inviteledger', channel: C.admin }));
  const ledger = C.log.sent[ledgerBefore];
  ledger.createdTimestamp = tick();
  scene('invite-ledger', 'Which invite brought who', [fromChannel(ledger)], { channel: 'staff-log' });

  const transcript = C.log.sent.find((m) => m.files.length);
  scene('transcript', 'Transcripts land in your log channel', [fromChannel(transcript)], { channel: 'staff-log' });
}

// ── Names for mentions ──────────────────────────────────────────────────────

function directory() {
  const users = {};
  for (const m of w.guild.members.cache.values()) {
    const top = [...m.roles.cache.values()].filter((r) => r.color).sort((a, b) => b.position - a.position)[0];
    users[m.id] = { name: m.displayName, color: top?.color || 0 };
  }
  users[w.client.user.id] = { name: BOT.name, color: 0 };
  const roles = {};
  for (const r of w.guild.roles.cache.values()) if (r.id !== w.guild.id) roles[r.id] = { name: r.name, color: r.color || 0 };
  const channels = {};
  for (const c of w.guild.channels.cache.values()) channels[c.id] = c.name;
  return { users, roles, channels, guild: w.guild.name, timezone: process.env.TIMEZONE, now: Date.now() };
}

// ── Browser ─────────────────────────────────────────────────────────────────

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else listeners.forEach((fn) => fn(msg));
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    opened,
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

async function shoot() {
  const exe = findBrowser();
  if (!exe) throw new Error('No Edge or Chrome found. Set BROWSER to its path.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-shots-'));
  const browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('browser did not start')), 20000);
      browser.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
    });
    const c = cdp(wsUrl);
    await c.opened;
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => c.send(method, params, sessionId);
    await s('Page.enable');
    await s('Runtime.enable');
    const page = 'file:///' + path.join(__dirname, 'view.html').replace(/\\/g, '/');
    fs.mkdirSync(IMAGES, { recursive: true });
    for (const sc of scenes) {
      const width = sc.width || 760;
      await s('Emulation.setDeviceMetricsOverride', { width, height: sc.height || 900, deviceScaleFactor: sc.scale || 2, mobile: false });
      const loaded = new Promise((resolve) => c.on((m) => { if (m.method === 'Page.loadEventFired') resolve(); }));
      await s('Page.navigate', { url: `${page}?scene=${encodeURIComponent(sc.id)}` });
      await loaded;
      await s('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
      const { result } = await s('Runtime.evaluate', { expression: 'JSON.stringify(window.sceneBox())', returnByValue: true });
      const box = JSON.parse(result.value);
      if (sc.type === 'banner') box.height = sc.height;
      const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(box.height), scale: 1 } });
      fs.writeFileSync(path.join(IMAGES, `${sc.id}.png`), Buffer.from(shot.data, 'base64'));
      console.log(`  ${sc.id}.png (${width}x${Math.ceil(box.height)})`);
    }
    c.close();
  } finally {
    browser.kill();
    await new Promise((resolve) => (browser.exitCode !== null ? resolve() : browser.once('exit', resolve)));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

(async () => {
  await eventScenes();
  await intakeScenes();
  await ticketScenes();
  await staffScenes();
  // Header image for the README and the GitHub social preview (1280x640).
  scene('banner', 'Common Access System', [], { type: 'banner', ref: 'signup-card', width: 1280, height: 640, scale: 1 });
  const data = { directory: directory(), scenes };
  fs.writeFileSync(path.join(__dirname, 'scenes.js'), `window.SCENES = ${JSON.stringify(data, null, 1)};\n`);
  console.log(`Recorded ${scenes.length} scenes.`);
  if (process.argv.includes('--no-shoot')) return;
  await shoot();
})().catch((e) => { console.error(e); process.exit(1); });
