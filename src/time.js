// Event times are typed in the community's own time zone (TIMEZONE in .env)
// and shown with Discord timestamps, so every reader sees their local time.

// Offset of `zone` from UTC, in minutes, at the given instant.
function zoneOffsetMinutes(zone, atMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs));
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

// Wall-clock time in `zone` -> unix seconds. Handles daylight saving by
// re-checking the offset at the resulting instant.
function wallClockToUnix(zone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - zoneOffsetMinutes(zone, guess) * 60000;
  ms = guess - zoneOffsetMinutes(zone, ms) * 60000;
  return Math.floor(ms / 1000);
}

// Accepts "2026-06-14 19:00", "2026-06-14 7:00pm", "14/06/2026 19:00" is NOT
// accepted (ambiguous); ISO-style dates only. Returns unix seconds or null.
function parseEventTime(text, zone) {
  const m = String(text || '').trim().toLowerCase()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ t]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let [, y, mo, d, h, mi, ampm] = m;
  y = Number(y); mo = Number(mo); d = Number(d); h = Number(h); mi = Number(mi || 0);
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null; // e.g. 2026-02-31
  return wallClockToUnix(zone, y, mo, d, h, mi);
}

// unix seconds -> "2026-06-14 19:00" in `zone` (to prefill edit forms).
function formatWallClock(unix, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(unix * 1000));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}`;
}

// Google Calendar "add event" link (no account or API needed). Discord link
// buttons allow at most 512 characters, so the text is shortened to fit.
const URL_MAX = 512;
function googleCalendarUrl({ title, description, startsAt, durationMinutes = 120 }) {
  const fmt = (unix) => new Date(unix * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const build = (text, details) => {
    const params = new URLSearchParams({ action: 'TEMPLATE', text, dates: `${fmt(startsAt)}/${fmt(startsAt + durationMinutes * 60)}` });
    if (details) params.set('details', details);
    return `https://calendar.google.com/calendar/render?${params}`;
  };
  let text = String(title || 'Event');
  while (text.length > 1 && build(text, '').length > URL_MAX) text = text.slice(0, Math.floor(text.length * 0.8));
  let details = String(description || '');
  while (details && build(text, details).length > URL_MAX) {
    details = details.length > 20 ? `${details.slice(0, Math.floor(details.length * 0.8)).trimEnd()}…` : '';
  }
  return build(text, details);
}

module.exports = { zoneOffsetMinutes, wallClockToUnix, parseEventTime, formatWallClock, googleCalendarUrl };
