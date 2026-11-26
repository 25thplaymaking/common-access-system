// Loaded first by every test file: a fixed server id, a real time zone, and
// a fresh in-memory database.
process.env.DISCORD_GUILD_ID = '123456789012345678';
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real';
process.env.TIMEZONE = 'America/New_York';
const db = require('../src/db');

function freshDb() {
  db.close();
  db.open(':memory:');
}

freshDb();
module.exports = { freshDb, db };
