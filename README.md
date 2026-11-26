# Common Access System

A self-hosted Discord bot for gaming communities, clans and milsim units. One bot
covers the day-to-day running of a server:

- **Event signups** with a live roster, reminders and start-time pings
- **Recruitment intake**: an application form and a private channel per applicant
- **Support tickets**: private channels between a member and your staff
- **A staff control panel** for roles, nicknames, timeouts and kicks
- **Join and leave notices** that say which invite link someone used

Everything is set up from inside Discord with `/setup`. No website or database
server is needed: the bot is one small Node.js program with one SQLite file.

## You host it yourself

There is **no hosted version** of this bot to invite. Each community runs its own
copy, with its own Discord application, on its own machine. You need:

| What | Notes |
|---|---|
| A machine that stays on | A small VPS, a home server, or a Raspberry Pi 4 or newer. The bot only works while it runs. |
| Node.js 22.13+ **or** Docker | Docker is the easiest way to keep it running and restart it after reboots. |
| Your own Discord application | Free, made in the Discord Developer Portal (steps below). Its token is yours alone. |
| About 100 MB of RAM and a few MB of disk | The database grows slowly (events, cases, the staff log). |

You are responsible for the server it runs on, keeping the token secret, backups,
and updates. Nothing is sent anywhere except to Discord.

## 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it your bot's name.
2. Open the **Bot** tab:
   - Click **Reset Token** and copy the token. This is `DISCORD_BOT_TOKEN`. Treat it like a password.
   - Under **Privileged Gateway Intents**, turn on **Server Members Intent** and **Message Content Intent**.
     The first is for join/leave notices and member tools, the second for ticket and application transcripts.
     Without them Discord refuses the login.
3. You will invite the bot in step 3; the bot prints the exact invite link when it starts.

## 2. Install and configure

```bash
git clone <the URL from this page's green Code button>
cd common-access-system
cp .env.example .env
```

Edit `.env`:

| Setting | What to put |
|---|---|
| `DISCORD_BOT_TOKEN` | The token from step 1. |
| `DISCORD_GUILD_ID` | Your server's ID: turn on Developer Mode (User Settings → Advanced), right-click your server icon → **Copy Server ID**. |
| `TIMEZONE` | The time zone your staff type event times in, e.g. `America/New_York`, `Europe/London`. Members always see times in their own zone. |
| `BOT_NAME`, `ACCENT_COLOR`, `BRAND_ICON_URL` | Optional branding for the bot's cards. |
| `REMINDER_MINUTES` | How long before an event members get a reminder (default 30). |

### Run with Docker (recommended)

```bash
docker compose up -d --build
docker compose logs -f
```

The database lives in the `cas-data` Docker volume. The container restarts by itself.

### Or run with Node.js

```bash
npm ci --omit=dev
npm start
```

Use a process manager (systemd, pm2, or similar) to keep it running after you log out
and after reboots.

## 3. Invite the bot

On first start the bot prints a line like:

```
[ready] I am not in server 123... yet. Invite me with:
  https://discord.com/oauth2/authorize?client_id=...&permissions=...&scope=bot+applications.commands
```

Open that link, pick your server and authorize. The link asks for exactly the
permissions below. When the bot joins, it registers its slash commands in your server.

Then, in **Server Settings → Roles**, drag the bot's role **above** every role it
should be able to give, remove or manage. Discord does not let a bot touch roles
above its own.

| Permission | Used for |
|---|---|
| View Channels, Send Messages, Embed Links, Attach Files, Read Message History | Posting cards, transcripts and logs |
| Manage Channels | Creating private application and ticket channels |
| Manage Roles | Giving roles on accept, and the role tools in `/cas` |
| Manage Nicknames, Kick Members, Moderate Members | Nickname, kick and timeout tools in `/cas` |
| Manage Server | Reading invite links (join attribution and `/inviteledger`) |
| View Audit Log | Saying who kicked or banned someone |
| Mention Everyone | Pinging roles, `@here` or `@everyone` when an event starts |

## 4. Set it up in Discord

Run `/setup` (you need **Administrator** or **Manage Server**). It has five pages:

1. **Log and welcome channels**: a private staff log channel (joins, leaves, staff
   actions, transcripts), an optional separate transcript channel, and an optional
   public welcome channel for accepted recruits. Join/leave notices can be turned off.
2. **Categories for private channels**: the Discord categories where application
   and ticket channels are created. Keep these categories hidden from `@everyone`.
3. **Staff roles**:
   - *Staff*: full access to `/cas`, `/inviteledger` and every case and event.
   - *Recruiters*: handle applications.
   - *Support*: handle tickets.
   - *Event hosts*: may post `/signup`. Staff can always post.
4. **Recruitment intake**: the roles a recruiter may give on accept, an optional role
   to take away on accept (for example "Guest"), up to five application questions,
   the welcome message, and a button to post the **application panel** in the
   current channel.
5. **Support tickets**: ticket categories and a button to post the **ticket panel**
   in the current channel.

Server admins (Administrator or Manage Server) count as staff everywhere.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/setup` | Server admins | Configure everything above. |
| `/cas` | Staff | Control panel: server overview, upcoming events, open cases, staff log, member tools. |
| `/signup` | Event hosts, staff | Post an event signup in the current channel. |
| `/inviteledger` | Staff | Post every used invite link, its use count and who joined through it, to the log channel. |

## How the features work

### Event signups

`/signup` opens a form: title, description, date and time (in `TIMEZONE`), an
optional image link and an optional limit on places. Next you pick which roles to
ping when the event starts (and optionally `@here` or `@everyone`), and whether
"Tentative" is offered. **Post signup** puts the card in the channel.

- Members press **Accept**, **Tentative** or **Decline**. Pressing the same button
  again takes their name off. When the places are full, Accept is refused.
- The card shows the time in each reader's own time zone and a live roster.
- **Add to calendar** opens a Google Calendar entry.
- `REMINDER_MINUTES` before the start, the bot replies to the card mentioning
  everyone who accepted or is tentative. At the start it pings the chosen roles.
  It never sends either more than two hours late (for example after downtime).
- The ⚙️ button lets hosts and staff edit the event (a new time re-arms the
  reminder) or cancel it. RSVPs close 12 hours after the start.

### Recruitment intake

Post the application panel with `/setup` → Recruitment intake. An applicant presses
**Start application**, answers your questions, and gets a private channel that only
they, your recruiters, your staff and the bot can see. One open application per person.

In the channel, recruiters can:

- **Claim** it, so others know who is handling it.
- **Accept**: pick roles from the allowed list (roles above the bot are never offered),
  then confirm. The bot gives the roles, removes the "on accept" role, posts the
  welcome message, DMs the applicant, and closes the channel.
- **Deny**: optionally type a reason, which is sent to the applicant by DM.
- **Close** without a decision.

### Support tickets

Post the ticket panel with `/setup` → Support tickets. A member picks a category,
fills in a subject and details, and gets a private channel with your support team.
The member or support staff can close it. Staff can reopen or delete it.

### Closing, transcripts and deleting

Closing an application or ticket stops the member from writing (they can still read),
saves a text transcript of the whole channel to the transcript channel (or the log
channel), and shows **Reopen** and **Delete channel**. Deleting asks for
confirmation and cannot be undone.

### Staff control panel

`/cas` shows member count, open applications and tickets, upcoming events and bot
health, plus:

- **Member tools**: pick a member to see their roles, join date and account age,
  then add or remove a role, change their nickname, time them out, or kick them
  (a reason is required).
- **Staff log**: the latest staff actions.

The panel follows Discord's role order: staff cannot act on members at or above
their own highest role, cannot give roles at or above it, and nobody can act on
the server owner. Every action is posted to the log channel.

### Join and leave notices

When someone joins, the log channel gets a card with their account age (new
accounts are flagged) and the invite they used. Discord does not report which
invite was used, so the bot compares invite use counts: if exactly one went up,
that invite is named; otherwise the card says "ambiguous" or "unknown" rather than
guessing. Leaves, kicks (with who did it and why) and bans are logged too.

## Your data

- The bot stores events and RSVPs, application and ticket records (including the
  answers people type), settings, the staff action log and join records in
  `data/cas.sqlite` (or the Docker volume).
- Transcripts are posted to your own Discord channel. They contain everything
  written in the case channel.
- Nothing is sent to anyone but Discord. Tell your members what you keep and who can
  read it, especially for applications and reports.

**Backups:** stop the bot first (the database keeps recent writes in side files
while it runs), then copy `data/cas.sqlite`. With Docker:

```bash
docker compose stop
docker compose cp cas:/app/data/cas.sqlite ./cas-backup.sqlite
docker compose start
```

## Updating

```bash
git pull
docker compose up -d --build      # or: npm ci --omit=dev && restart the bot
```

The database is kept. Slash commands update themselves when the bot starts.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Used disallowed intents` at login | Turn on both privileged intents in the Developer Portal (step 1). |
| `An invalid token was provided` | Copy the token again; it changes every time you press Reset Token. |
| Commands do not show up | Check the bot is in the server set in `DISCORD_GUILD_ID`, then restart it and reload Discord (Ctrl+R). |
| "That role is above or level with my highest role" | Move the bot's role higher in Server Settings → Roles. |
| Join cards say "Unavailable" for the invite | The bot needs the Manage Server permission to read invites. |
| `missing permissions` warning on start | Re-invite the bot with the link it prints. |
| Event time read wrong | Check `TIMEZONE` in `.env`, then restart. |

## Development

```bash
npm ci
npm test
```

The tests drive every feature through the real interaction handlers using small
fake Discord objects (`test/fakes.js`), so they need no network or token.

Code map: `src/index.js` (startup and routing), `signups.js`, `intake.js`,
`tickets.js`, `cases.js` (private channels shared by intake and tickets),
`panel.js` (`/cas`), `setup.js` (`/setup`), `members.js` (join notices and invite
ledger), `settings.js`, `access.js`, `db.js`.

## License

MIT. See [LICENSE](LICENSE).
