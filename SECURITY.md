# Security

## Keep your token secret

Your bot token gives full control of your bot. Keep it only in `.env` on the machine
that runs the bot. Never commit `.env`, paste the token in Discord, or share it in a
bug report. If it leaks, press **Reset Token** in the Discord Developer Portal at once
and update `.env`.

## Reporting a problem

Please report security problems privately through GitHub's
**Security → Report a vulnerability** on this repository, not in a public issue.
Include what you found and how to reproduce it. Never include a real token or
member data.
