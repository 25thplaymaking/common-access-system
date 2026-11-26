const { freshDb } = require('./setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEventTime, formatWallClock, googleCalendarUrl } = require('../src/time');
const { mentionChunks } = require('../src/signups');
const { readConfig, configProblems } = require('../src/config');
const settings = require('../src/settings');
const { diffInvites } = require('../src/members');
const cases = require('../src/cases');
const { commandJson } = require('../src/commands');
const setup = require('../src/setup');

test('event times are read in the configured zone, across daylight saving', () => {
  // New York is UTC-4 in June and UTC-5 in January.
  assert.equal(parseEventTime('2026-06-14 19:00', 'America/New_York'), Date.UTC(2026, 5, 14, 23, 0) / 1000);
  assert.equal(parseEventTime('2026-01-14 19:00', 'America/New_York'), Date.UTC(2026, 0, 15, 0, 0) / 1000);
  assert.equal(parseEventTime('2026-06-14 7:30pm', 'America/New_York'), Date.UTC(2026, 5, 14, 23, 30) / 1000);
  assert.equal(parseEventTime('2026-06-14 12am', 'UTC'), Date.UTC(2026, 5, 14, 0, 0) / 1000);
  assert.equal(parseEventTime('2026-06-14 19:00', 'Europe/Berlin'), Date.UTC(2026, 5, 14, 17, 0) / 1000);
  assert.equal(parseEventTime('2026-06-14 19:00', 'Australia/Sydney'), Date.UTC(2026, 5, 14, 9, 0) / 1000);
});

test('bad event times are refused, not guessed', () => {
  for (const bad of ['', 'tomorrow', '14/06/2026 19:00', '2026-02-31 10:00', '2026-06-14 25:00', '2026-06-14 13pm', '2026-13-01 10:00']) {
    assert.equal(parseEventTime(bad, 'UTC'), null, bad);
  }
});

test('a stored time prints back as the same wall clock (edit form round trip)', () => {
  for (const zone of ['America/New_York', 'Europe/London', 'Asia/Kolkata']) {
    const unix = parseEventTime('2026-03-29 01:30', zone) ?? parseEventTime('2026-03-29 03:30', zone);
    assert.equal(parseEventTime(formatWallClock(unix, zone), zone), unix, zone);
  }
});

test('calendar link carries the title and a UTC time window', () => {
  const url = new URL(googleCalendarUrl({ title: 'Op Night', startsAt: Date.UTC(2026, 5, 14, 23) / 1000 }));
  assert.equal(url.searchParams.get('text'), 'Op Night');
  assert.equal(url.searchParams.get('dates'), '20260614T230000Z/20260615T010000Z');
});

test('config: missing token, bad server id and bad zone are all reported', () => {
  const problems = configProblems(readConfig({ DISCORD_GUILD_ID: 'abc', TIMEZONE: 'Mars/Base' }));
  assert.equal(problems.length, 3);
  assert.deepEqual(configProblems(readConfig({ DISCORD_BOT_TOKEN: 'x', DISCORD_GUILD_ID: '123456789012345678' })), []);
  assert.equal(readConfig({ ACCENT_COLOR: '#ff0000' }).accentColor, 0xff0000);
  assert.equal(readConfig({ ACCENT_COLOR: 'red' }).accentColor, 0x3b82f6);
});

test('settings fall back to defaults and save JSON values', () => {
  freshDb();
  assert.deepEqual(settings.getSetting('staff_roles'), []);
  assert.equal(settings.getSetting('intake_questions').length, 5);
  settings.setSetting('staff_roles', ['1', '2']);
  assert.deepEqual(settings.getSetting('staff_roles'), ['1', '2']);
  assert.throws(() => settings.setSetting('nope', 1));
  // Defaults are copies: changing one must not change the next read.
  settings.getSetting('ticket_categories').push({ label: 'x' });
  assert.equal(settings.getSetting('ticket_categories').length, 3);
});

test('ticket categories parse from "Label | description" lines', () => {
  const list = settings.parseTicketCategories('Help | general help\n\n  Report  \nA | b | c');
  assert.deepEqual(list, [
    { label: 'Help', description: 'general help' },
    { label: 'Report', description: '' },
    { label: 'A', description: 'b | c' },
  ]);
  assert.equal(settings.formatTicketCategories(list), 'Help | general help\nReport\nA | b | c');
  assert.equal(settings.parseTicketCategories(Array.from({ length: 30 }, (_, n) => `C${n}`).join('\n')).length, 25);
});

test('invite attribution: one raised count is credited, two are ambiguous, none is unknown', () => {
  const before = new Map([['aaa', 1], ['bbb', 5]]);
  assert.deepEqual(diffInvites(before, new Map([['aaa', 2], ['bbb', 5]])), { source: 'invite', codes: ['aaa'] });
  assert.deepEqual(diffInvites(before, new Map([['aaa', 2], ['bbb', 6]])), { source: 'ambiguous', codes: ['aaa', 'bbb'] });
  assert.deepEqual(diffInvites(before, new Map([['aaa', 1], ['bbb', 5]])), { source: 'unknown', codes: [] });
  assert.deepEqual(diffInvites(before, new Map([['aaa', 1], ['bbb', 5], ['new', 1]])), { source: 'invite', codes: ['new'] });
  assert.equal(diffInvites(null, before).source, 'unavailable');
});

test('case channel names are safe and numbered', () => {
  assert.equal(cases.channelName('ticket', 7, 'Big Boss!!'), 'ticket-0007-big-boss');
  assert.equal(cases.channelName('intake', 123, '日本'), 'intake-0123-member');
});

test('transcripts include messages, embeds and files in order', () => {
  const row = { kind: 'ticket', number: 3, opener_name: 'Ann', opener_id: '1', created_at: 0, closed_at: 60, outcome: 'closed' };
  const messages = [
    { createdTimestamp: 0, author: { username: 'ann' }, content: 'hello', embeds: [], attachments: new Map() },
    { createdTimestamp: 1000, author: { username: 'bot', bot: true }, content: '', embeds: [{ title: 'T', description: 'D', fields: [{ name: 'Q', value: 'A' }] }], attachments: new Map([['x', { name: 'a.png', url: 'https://cdn/a.png' }]]) },
  ];
  const text = cases.transcriptText(row, messages, 'Guild');
  assert.match(text, /Ticket #0003 — Guild/);
  assert.match(text, /ann: hello/);
  assert.match(text, /bot \[bot\]: \[embed\] T D\n {4} {2}Q: A\n {4}\[file\] a\.png/);
});

test('slash commands are valid and /setup is hidden from non-admins by default', () => {
  const cmds = commandJson();
  assert.deepEqual(cmds.map((c) => c.name).sort(), ['cas', 'inviteledger', 'setup', 'signup']);
  assert.equal(cmds.find((c) => c.name === 'setup').default_member_permissions, '32');
  for (const c of cmds) assert.ok(c.description.length <= 100);
});

test('every /setup page fits Discord limits (5 rows, ids under 100 chars)', () => {
  freshDb();
  for (const page of Object.keys(setup.PAGES)) {
    const v = setup.view(page);
    assert.ok(v.components.length <= 5, page);
    for (const row of v.components) {
      const data = row.toJSON();
      assert.ok(data.components.length >= 1 && data.components.length <= 5);
      for (const c of data.components) assert.ok((c.custom_id || '').length <= 100);
    }
    assert.ok(v.embeds[0].data.fields.length <= 25);
  }
});

test('calendar links stay under Discord\'s 512-character button limit', () => {
  const url = googleCalendarUrl({ title: 'T'.repeat(200), description: 'word '.repeat(400), startsAt: 1_900_000_000 });
  assert.ok(url.length <= 512, String(url.length));
  assert.ok(new URL(url).searchParams.get('text').startsWith('TTT'));
  const short = googleCalendarUrl({ title: 'Op', description: 'Bring radios', startsAt: 1_900_000_000 });
  assert.equal(new URL(short).searchParams.get('details'), 'Bring radios');
});

test('reminder mentions are split under 2000 characters and 100 users per message', () => {
  const ids = Array.from({ length: 250 }, (_, n) => String(100000000000000000n + BigInt(n)));
  const chunks = mentionChunks(ids);
  assert.deepEqual(chunks.flat(), ids);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= 100);
    assert.ok(c.map((u) => `<@${u}>`).join(' ').length <= 1700);
  }
});
