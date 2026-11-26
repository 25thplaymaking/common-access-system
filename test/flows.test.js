// End-to-end flows through the real interaction handlers, with fake Discord
// objects standing in for the gateway.
const { freshDb, db } = require('./setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeWorld, fakeInteraction, lastText, customIds } = require('./fakes');
const settings = require('../src/settings');
const signups = require('../src/signups');
const cases = require('../src/cases');
const intake = require('../src/intake');
const tickets = require('../src/tickets');
const panel = require('../src/panel');
const setup = require('../src/setup');
const members = require('../src/members');

// Route an interaction the way index.js does.
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

const embedOf = (msg) => msg.embeds[0];
const field = (e, prefix) => e.fields.find((f) => f.name.includes(prefix));

function eventWorld() {
  freshDb();
  const w = fakeWorld();
  const events = w.channel({ name: 'events' });
  const hostRole = w.role('Host', 10);
  const host = w.addMember('host', { roles: [hostRole] });
  settings.setSetting('host_roles', [hostRole.id]);
  return { w, events, host };
}

async function postEvent(w, events, host, form) {
  await route(fakeInteraction(w, host, 'command', { commandName: 'signup', channel: events }));
  const draft = await route(fakeInteraction(w, host, 'modal', { customId: 'ev:new', channel: events, fields: form }));
  const token = customIds(draft.replies[0]).find((id) => id.startsWith('ev:post:')).split(':')[2];
  return { draft, token };
}

const FORM = { title: 'Op Thunder', description: 'Bring radios', when: '2030-06-14 19:00', image: '', max: '2' };

test('signup: a host posts an event and members RSVP with a live roster', async () => {
  const { w, events, host } = eventWorld();
  const pingRole = w.role('Members', 5);
  const { draft, token } = await postEvent(w, events, host, FORM);
  assert.match(draft.replies[0].embeds[0].data.title, /Preview: Op Thunder/);

  const roles = await route(fakeInteraction(w, host, 'select', { customId: `ev:roles:${token}`, values: [pingRole.id], channel: events }));
  assert.ok(roles.updates.length);
  const posted = await route(fakeInteraction(w, host, 'button', { customId: `ev:post:${token}`, channel: events }));
  assert.match(lastText(posted), /Posted/);
  assert.equal(events.sent.length, 1);
  const msg = events.sent[0];
  const event = signups.eventByMessage(msg.id);
  assert.equal(event.title, 'Op Thunder');
  assert.equal(event.starts_at, Date.UTC(2030, 5, 14, 23) / 1000);
  assert.deepEqual(JSON.parse(event.ping_roles), [pingRole.id]);
  assert.match(embedOf(msg).fields[0].value, /<t:\d+:F>/);

  const a = w.addMember('alice');
  const b = w.addMember('bob');
  const c = w.addMember('carol');
  await route(fakeInteraction(w, a, 'button', { customId: 'ev:rsvp:accept', message: msg, channel: events }));
  await route(fakeInteraction(w, b, 'button', { customId: 'ev:rsvp:tentative', message: msg, channel: events }));
  await route(fakeInteraction(w, b, 'button', { customId: 'ev:rsvp:accept', message: msg, channel: events }));
  let e = embedOf(msg);
  assert.match(field(e, 'Accepted').name, /\(2\/2\)/);
  assert.match(field(e, 'Accepted').value, new RegExp(`<@${a.id}>[\\s\\S]*<@${b.id}>`));
  assert.match(field(e, 'Tentative').name, /\(0\)/);

  const full = await route(fakeInteraction(w, c, 'button', { customId: 'ev:rsvp:accept', message: msg, channel: events }));
  assert.match(lastText(full), /full/);

  // Clicking your own status again takes your name off.
  const undo = await route(fakeInteraction(w, a, 'button', { customId: 'ev:rsvp:accept', message: msg, channel: events }));
  assert.match(lastText(undo), /removed/);
  e = embedOf(msg);
  assert.match(field(e, 'Accepted').name, /\(1\/2\)/);
});

test('signup: members cannot post or manage; tentative can be switched off', async () => {
  const { w, events, host } = eventWorld();
  const nobody = w.addMember('nobody');
  const refused = await route(fakeInteraction(w, nobody, 'command', { commandName: 'signup', channel: events }));
  assert.equal(refused.modals.length, 0);
  assert.match(lastText(refused), /Only event hosts/);

  const { token } = await postEvent(w, events, host, { ...FORM, max: '' });
  await route(fakeInteraction(w, host, 'button', { customId: `ev:tent:${token}`, channel: events }));
  await route(fakeInteraction(w, host, 'button', { customId: `ev:post:${token}`, channel: events }));
  const msg = events.sent[0];
  assert.ok(!customIds(msg.payload).includes('ev:rsvp:tentative'));
  const manage = await route(fakeInteraction(w, nobody, 'button', { customId: 'ev:manage', message: msg, channel: events }));
  assert.match(lastText(manage), /Only event hosts/);
  // Someone else's draft token does nothing.
  const { token: other } = await postEvent(w, events, host, FORM);
  const hijack = await route(fakeInteraction(w, nobody, 'button', { customId: `ev:post:${other}`, channel: events }));
  assert.match(lastText(hijack), /expired/);
  assert.equal(events.sent.length, 1);
});

test('signup: bad form input is explained, not posted', async () => {
  const { w, events, host } = eventWorld();
  for (const [patch, expected] of [
    [{ when: 'next friday' }, /could not read/],
    [{ when: '2001-01-01 10:00' }, /past/],
    [{ image: 'http://insecure' }, /https/],
    [{ max: '0' }, /whole number/],
  ]) {
    const i = await route(fakeInteraction(w, host, 'modal', { customId: 'ev:new', channel: events, fields: { ...FORM, ...patch } }));
    assert.match(lastText(i), expected);
  }
});

test('signup: edit retimes the event, cancel closes it', async () => {
  const { w, events, host } = eventWorld();
  const { token } = await postEvent(w, events, host, FORM);
  await route(fakeInteraction(w, host, 'button', { customId: `ev:post:${token}`, channel: events }));
  const msg = events.sent[0];
  const event = signups.eventByMessage(msg.id);
  db.get().prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(event.id);

  const open = await route(fakeInteraction(w, host, 'button', { customId: `ev:edit:${event.id}`, channel: events }));
  const prefill = open.modals[0].toJSON().components.map((r) => r.components[0]);
  assert.equal(prefill.find((c) => c.custom_id === 'when').value, '2030-06-14 19:00');

  await route(fakeInteraction(w, host, 'modal', { customId: `ev:editsub:${event.id}`, channel: events, fields: { ...FORM, when: '2030-06-15 20:00', title: 'Op Thunder II' } }));
  const edited = signups.eventById(event.id);
  assert.equal(edited.title, 'Op Thunder II');
  assert.equal(edited.reminded, 0, 'a new time re-arms the reminder');
  assert.match(embedOf(msg).title, /Op Thunder II/);

  const ask = await route(fakeInteraction(w, host, 'button', { customId: `ev:cancel:${event.id}`, channel: events }));
  assert.match(lastText(ask), /Cancel/);
  await route(fakeInteraction(w, host, 'button', { customId: `ev:cancelyes:${event.id}`, channel: events }));
  assert.equal(signups.eventById(event.id).status, 'cancelled');
  assert.match(embedOf(msg).title, /CANCELLED/);
  assert.equal(msg.components.length, 0);
});

test('signup: reminder pings who signed up, start ping hits the chosen roles, once each', async () => {
  const { w, events, host } = eventWorld();
  const role = w.role('Members', 5);
  const { token } = await postEvent(w, events, host, FORM);
  await route(fakeInteraction(w, host, 'select', { customId: `ev:roles:${token}`, values: [role.id], channel: events }));
  await route(fakeInteraction(w, host, 'select', { customId: `ev:special:${token}`, values: ['here'], channel: events }));
  await route(fakeInteraction(w, host, 'button', { customId: `ev:post:${token}`, channel: events }));
  const msg = events.sent[0];
  const a = w.addMember('alice');
  await route(fakeInteraction(w, a, 'button', { customId: 'ev:rsvp:accept', message: msg, channel: events }));
  const start = signups.eventByMessage(msg.id).starts_at;

  await signups.tick(w.client, start - 3600);
  assert.equal(events.sent.length, 1, 'nothing an hour out');
  await signups.tick(w.client, start - 20 * 60);
  assert.equal(events.sent.length, 2);
  assert.match(events.sent[1].content, new RegExp(`<@${a.id}>`));
  assert.deepEqual(events.sent[1].payload.allowedMentions, { users: [a.id] });
  await signups.tick(w.client, start - 10 * 60);
  assert.equal(events.sent.length, 2, 'reminder only once');
  await signups.tick(w.client, start + 5);
  assert.equal(events.sent.length, 3);
  assert.match(events.sent[2].content, new RegExp(`@here <@&${role.id}>`));
  assert.deepEqual(events.sent[2].payload.allowedMentions, { roles: [role.id], parse: ['everyone'] });
  await signups.tick(w.client, start + 13 * 3600);
  assert.equal(signups.eventById(signups.eventByMessage(msg.id).id).status, 'ended');
  assert.equal(events.sent.length, 3, 'no late pings');
});

function caseWorld() {
  freshDb();
  const w = fakeWorld();
  const log = w.channel({ name: 'staff-log' });
  const welcome = w.channel({ name: 'welcome' });
  const lobby = w.channel({ name: 'join-us' });
  const recruiterRole = w.role('Recruiter', 20);
  const supportRole = w.role('Support', 20);
  const memberRole = w.role('Member', 5);
  const guestRole = w.role('Guest', 2);
  const tooHigh = w.role('Officer', 60);
  const recruiter = w.addMember('recruiter', { roles: [recruiterRole] });
  const support = w.addMember('helper', { roles: [supportRole] });
  settings.setSetting('log_channel', log.id);
  settings.setSetting('welcome_channel', welcome.id);
  settings.setSetting('recruiter_roles', [recruiterRole.id]);
  settings.setSetting('support_roles', [supportRole.id]);
  settings.setSetting('accept_roles', [memberRole.id, tooHigh.id]);
  settings.setSetting('remove_on_accept', guestRole.id);
  return { w, log, welcome, lobby, recruiter, support, recruiterRole, supportRole, memberRole, guestRole, tooHigh };
}

const ANSWERS = { q0: 'A friend', q1: '25', q2: 'UTC evenings', q3: 'None', q4: 'Fun' };

test('intake: apply, get a private channel, get accepted with roles and a welcome', async () => {
  const c = caseWorld();
  const { w } = c;
  const applicant = w.addMember('newbie', { roles: [c.guestRole] });

  const start = await route(fakeInteraction(w, applicant, 'button', { customId: 'intake:start', channel: c.lobby }));
  assert.equal(start.modals[0].toJSON().components.length, 5);
  const form = await route(fakeInteraction(w, applicant, 'modal', { customId: 'intake:form', channel: c.lobby, fields: ANSWERS }));
  assert.match(lastText(form), /application is open/);
  const row = cases.openCaseFor('intake', applicant.id);
  const channel = w.guild.channels.cache.get(row.channel_id);
  assert.equal(channel.name, 'intake-0001-newbie');
  const everyone = channel.overwrites.find((o) => o.id === w.guild.id);
  assert.ok(everyone.deny.length, 'hidden from @everyone');
  assert.ok(channel.overwrites.find((o) => o.id === applicant.id));
  assert.ok(channel.overwrites.find((o) => o.id === c.recruiterRole.id));
  assert.equal(embedOf(channel.sent[0]).fields[1].value, '25');

  // A second application while one is open just points at the first.
  const again = await route(fakeInteraction(w, applicant, 'button', { customId: 'intake:start', channel: c.lobby }));
  assert.match(lastText(again), /already have an open application/);

  // The applicant cannot accept themselves.
  const self = await route(fakeInteraction(w, applicant, 'button', { customId: `case:accept:${row.id}`, channel }));
  assert.match(lastText(self), /Only recruiters/);

  const panelReply = await route(fakeInteraction(w, c.recruiter, 'button', { customId: `case:accept:${row.id}`, channel }));
  const options = panelReply.replies[0].components[0].toJSON().components[0].options.map((o) => o.value);
  assert.deepEqual(options, [c.memberRole.id], 'a role above the bot is not offered');
  await route(fakeInteraction(w, c.recruiter, 'select', { customId: `case:acceptroles:${row.id}`, values: [c.memberRole.id], channel }));
  const go = await route(fakeInteraction(w, c.recruiter, 'button', { customId: `case:acceptgo:${row.id}`, channel }));
  assert.match(lastText(go), /Accepted/);

  assert.ok(applicant.roles.cache.has(c.memberRole.id));
  assert.ok(!applicant.roles.cache.has(c.guestRole.id));
  const closed = cases.caseById(row.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'accepted');
  assert.deepEqual(channel.permissionOverwrites.edits[0], { target: applicant.id, perms: { SendMessages: false } });
  const transcript = c.log.sent.find((m) => m.files.length);
  assert.ok(transcript, 'transcript posted to the log channel');
  assert.match(transcript.files[0].attachment.toString(), /A friend/);
  assert.match(c.welcome.sent[0].content, new RegExp(`Welcome aboard, <@${applicant.id}>`));
  assert.equal(applicant.user.dms.length, 1);
  assert.ok(c.log.sent.some((m) => /Applicant accepted/.test(m.embeds[0]?.title)));
});

test('intake: deny sends the reason by DM and closes', async () => {
  const c = caseWorld();
  const applicant = c.w.addMember('maybe');
  await route(fakeInteraction(c.w, applicant, 'modal', { customId: 'intake:form', channel: c.lobby, fields: ANSWERS }));
  const row = cases.openCaseFor('intake', applicant.id);
  const channel = c.w.guild.channels.cache.get(row.channel_id);
  const modal = await route(fakeInteraction(c.w, c.recruiter, 'button', { customId: `case:deny:${row.id}`, channel }));
  assert.equal(modal.modals.length, 1);
  await route(fakeInteraction(c.w, c.recruiter, 'modal', { customId: `case:denysub:${row.id}`, channel, fields: { reason: 'Too young' } }));
  assert.equal(cases.caseById(row.id).outcome, 'denied');
  assert.match(applicant.user.dms[0], /not accepted[\s\S]*Too young/);
  const late = await route(fakeInteraction(c.w, c.recruiter, 'button', { customId: `case:accept:${row.id}`, channel }));
  assert.match(lastText(late), /already closed/);
});

test('tickets: open from the panel, member closes, staff reopens and deletes', async () => {
  const c = caseWorld();
  const { w } = c;
  const panelMsg = await c.lobby.send(tickets.panelMessage());
  const user = w.addMember('needshelp');
  const pick = await route(fakeInteraction(w, user, 'select', { customId: 'ticket:pick', values: ['1'], message: panelMsg, channel: c.lobby }));
  assert.equal(pick.modals[0].toJSON().title, 'Report a member');
  await route(fakeInteraction(w, user, 'modal', { customId: 'ticket:form:1', channel: c.lobby, fields: { subject: 'Spam', details: 'Someone spams' } }));
  const row = cases.openCaseFor('ticket', user.id);
  assert.equal(row.category, 'Report a member');
  const channel = w.guild.channels.cache.get(row.channel_id);
  assert.ok(channel.overwrites.find((o) => o.id === c.supportRole.id));
  assert.ok(!channel.overwrites.find((o) => o.id === c.recruiterRole.id), 'recruiters do not see tickets');

  const stranger = w.addMember('stranger');
  const denied = await route(fakeInteraction(w, stranger, 'button', { customId: `case:close:${row.id}`, channel, message: channel.sent[0] }));
  assert.match(lastText(denied), /cannot close/);

  await route(fakeInteraction(w, c.support, 'button', { customId: `case:claim:${row.id}`, channel, message: channel.sent[0] }));
  assert.equal(cases.caseById(row.id).claimed_by, c.support.id);

  await route(fakeInteraction(w, user, 'button', { customId: `case:close:${row.id}`, channel, message: channel.sent[0] }));
  assert.equal(cases.caseById(row.id).status, 'closed');
  const userReopen = await route(fakeInteraction(w, user, 'button', { customId: `case:reopen:${row.id}`, channel, message: channel.sent.at(-1) }));
  assert.match(lastText(userReopen), /Only staff/);
  await route(fakeInteraction(w, c.support, 'button', { customId: `case:reopen:${row.id}`, channel, message: channel.sent.at(-1) }));
  assert.equal(cases.caseById(row.id).status, 'open');

  const confirm = await route(fakeInteraction(w, c.support, 'button', { customId: `case:delete:${row.id}`, channel }));
  assert.match(lastText(confirm), /still open/);
  assert.equal(channel.deleted, false);
  await route(fakeInteraction(w, c.support, 'button', { customId: `case:deleteyes:${row.id}`, channel }));
  assert.equal(channel.deleted, true);
  assert.equal(cases.caseById(row.id).status, 'deleted');
});

test('panel: staff only, and the role list decides who can act on whom', async () => {
  freshDb();
  const w = fakeWorld();
  const log = w.channel({ name: 'log' });
  settings.setSetting('log_channel', log.id);
  const modRole = w.role('Moderator', 30);
  const seniorRole = w.role('Senior', 40);
  const giveable = w.role('Member', 5);
  const mod = w.addMember('mod', { roles: [modRole] });
  const senior = w.addMember('senior', { roles: [seniorRole] });
  const pleb = w.addMember('pleb');
  settings.setSetting('staff_roles', [modRole.id]);

  const no = await route(fakeInteraction(w, pleb, 'command', { commandName: 'cas' }));
  assert.match(lastText(no), /staff only/);
  const home = await route(fakeInteraction(w, mod, 'command', { commandName: 'cas' }));
  assert.match(home.replies[0].embeds[0].data.title, /control panel/);

  const kickSenior = await route(fakeInteraction(w, mod, 'button', { customId: `cas:m:kick:${senior.id}` }));
  assert.match(lastText(kickSenior), /above or level with you/);
  const giveHigh = await route(fakeInteraction(w, mod, 'select', { customId: `cas:m:roleadd:${pleb.id}`, values: [seniorRole.id] }));
  assert.match(lastText(giveHigh), /above or level with your highest role/);
  assert.ok(!pleb.roles.cache.has(seniorRole.id));

  await route(fakeInteraction(w, mod, 'select', { customId: `cas:m:roleadd:${pleb.id}`, values: [giveable.id] }));
  assert.ok(pleb.roles.cache.has(giveable.id));
  await route(fakeInteraction(w, mod, 'modal', { customId: `cas:m:nicksub:${pleb.id}`, fields: { nick: 'Pvt Pleb' } }));
  assert.equal(pleb.nickname, 'Pvt Pleb');
  await route(fakeInteraction(w, mod, 'select', { customId: `cas:m:tosub:${pleb.id}`, values: ['3600'] }));
  assert.ok(pleb.communicationDisabledUntilTimestamp > Date.now());
  await route(fakeInteraction(w, mod, 'modal', { customId: `cas:m:kicksub:${pleb.id}`, fields: { reason: 'Rule 1' } }));
  assert.match(pleb.kicked, /Rule 1/);
  assert.equal(log.sent.length, 4, 'every action is logged');

  const ownerAct = await route(fakeInteraction(w, senior, 'button', { customId: `cas:m:kick:${w.owner.id}` }));
  assert.match(lastText(ownerAct), /staff only|server owner/);
});

test('setup: only admins, and picks save straight away', async () => {
  freshDb();
  const w = fakeWorld();
  const pleb = w.addMember('pleb');
  const no = await route(fakeInteraction(w, pleb, 'command', { commandName: 'setup' }));
  assert.match(lastText(no), /Only server admins/);
  const admin = w.addMember('admin', { permissions: ['ManageGuild'] });
  const log = w.channel({ name: 'log' });
  const roleA = w.role('Staff', 10);
  await route(fakeInteraction(w, admin, 'select', { customId: 'setup:ch:log_channel', values: [log.id] }));
  await route(fakeInteraction(w, admin, 'select', { customId: 'setup:role:staff_roles', values: [roleA.id] }));
  await route(fakeInteraction(w, admin, 'select', { customId: 'setup:role:remove_on_accept', values: [] }));
  assert.equal(settings.getSetting('log_channel'), log.id);
  assert.deepEqual(settings.getSetting('staff_roles'), [roleA.id]);
  assert.equal(settings.getSetting('remove_on_accept'), '');
  const msg = await log.send({ content: 'setup' });
  await route(fakeInteraction(w, admin, 'modal', { customId: 'setup:modal:categories', message: msg, fields: { text: 'Apply | join\nAppeal' } }));
  assert.deepEqual(settings.getSetting('ticket_categories').map((x) => x.label), ['Apply', 'Appeal']);
  const posted = await route(fakeInteraction(w, admin, 'button', { customId: 'setup:btn:intakepanel', channel: log }));
  assert.match(lastText(posted), /Application panel posted/);
  assert.ok(customIds(log.sent.at(-1).payload).includes('intake:start'));
});

test('members: a join is credited to the invite whose count went up', async () => {
  freshDb();
  const w = fakeWorld();
  const log = w.channel({ name: 'log' });
  settings.setSetting('log_channel', log.id);
  const inviter = w.addMember('recruitbot');
  w.guild.invitesList.set('abc', { code: 'abc', uses: 3, inviterId: inviter.id, channelId: log.id });
  w.guild.invitesList.set('xyz', { code: 'xyz', uses: 0, inviterId: null, channelId: log.id });
  await members.snapshotInvites(w.guild);
  w.guild.invitesList.get('abc').uses = 4;
  const joiner = w.addMember('joiner');
  joiner.user.createdTimestamp = Date.now() - 86400000;
  await members.onJoin(w.client, joiner);
  const card = log.sent[0].embeds[0];
  assert.match(card.title, /joined/);
  assert.match(card.fields.find((f) => f.name === 'Invite').value, new RegExp(`abc.*<@${inviter.id}>`));
  assert.match(card.fields.find((f) => f.name === 'Account created').value, /new account/);

  w.guild.auditEntries.push({ target: { id: joiner.id }, executor: { id: w.owner.id }, reason: 'spam', createdTimestamp: Date.now() });
  await members.onLeave(w.client, joiner);
  assert.match(log.sent[1].embeds[0].title, /kicked/);

  const staffRole = w.role('Staff', 10);
  settings.setSetting('staff_roles', [staffRole.id]);
  const staff = w.addMember('staff', { roles: [staffRole] });
  const ledger = await route(fakeInteraction(w, staff, 'command', { commandName: 'inviteledger' }));
  assert.match(lastText(ledger), /Posted to the log channel/);
  assert.match(log.sent[2].embeds[0].description, new RegExp(`abc.*4 uses[\\s\\S]*Joined: <@${joiner.id}>`));
  assert.doesNotMatch(log.sent[2].embeds[0].description, /xyz/);
});
