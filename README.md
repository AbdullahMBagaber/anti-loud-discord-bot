# ANti Loud - Guard your users' ears from loud audio

An auto-mute Discord bot: it listens to a voice channel, measures loudness
per-user with `ffmpeg`'s `ebur128` (LUFS) filter, and mutes/times out users
who stay too loud for too long.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` to your bot's token.
3. Copy `config.example.json` to `config.json` and edit it (or use the
   in-Discord commands below) to set `targetVoiceChannelId`, `logChannelId`,
   and `bypassRoleIds` for your server. `config.json` is gitignored since it
   holds your server's real channel/role IDs.
4. In the Discord Developer Portal, enable the **Server Members Intent** and
   **Message Content Intent** privileged intents for the bot.
5. Invite the bot with `View Channel`, `Connect`, `Mute Members`, and
   `Timeout Members` (Moderate Members) permissions — the last one is
   needed for the escalation timeout.
6. `node bot.js` (or see `DEPLOY.md` for running it persistently on a server).

## Commands (prefix `!`, configurable via `commandPrefix` in config.json)

- `!enable` (alias `!join`) — join the target voice channel and start monitoring.
- `!disable` — stop monitoring and leave the voice channel.
- `!setthreshold <value>` — set the LUFS threshold used to decide "too loud".
- `!setsustained <ms>` — how long the level must stay above threshold before
  muting (minimum 50ms). Lower = faster mute, more false positives.
- `!setmuteduration <seconds>` — flat mute length applied per violation.
- `!settimeoutduration <seconds>` — length of the escalated Discord timeout.
- `!settimeoutafter <violations>` — how many violations in the cooldown
  window trigger a timeout instead of another plain mute.
- `!setcooldown <minutes>` — rolling window used to count violations.
- `!setlogchannel [#channel]` — where mute/unmute/timeout events get logged
  (defaults to the current channel if no argument given).
- `!settimeoutroom [#voice-channel]` — move timed-out members here instead
  of leaving them muted in place (defaults to your current voice channel;
  `off` clears it). A Discord timeout doesn't disconnect someone already in
  a call, so this is what actually separates them from the conversation.
- `!addbypassrole <@role>` / `!removebypassrole <@role>` — roles that are
  never muted (owner/admins are always exempt regardless).
- `!listsounds` — list the server's soundboard sounds and what's assigned.
- `!setmutesound <name>` / `!settimeoutsound <name>` — pick which of the
  server's own soundboard sounds plays on mute / timeout (`off` to clear).
- `!calibrate` — listen for 10s while people talk normally, then report the
  average/peak LUFS measured, so you can pick a sane threshold.
- `!status` — show current config and anyone currently muted by the bot.
- `!leaderboard` — Hall of Shame: most-muted/timed-out members, plus the
  server's all-time loudest-recorded-violation record.

All commands except `!status` require the "Mute Members" permission.

## How enforcement works

1. Loudness (LUFS) is measured continuously per speaking user.
2. If a user's level stays above `thresholdLevel` for `sustainedMs`
   (config.json), that counts as one violation (single spikes are ignored).
3. Violations are tracked per-user in a rolling `cooldownMinutes` window
   (default 60 min):
   - Each violation gets a flat mute of `muteDurationMs` (default 30s).
   - Once a user reaches `timeoutAfterViolations` violations (default 5)
     within that window, they get a Discord timeout of `timeoutDurationMs`
     (default 2 min) instead of another plain mute — a timeout blocks both
     voice and text for its duration.
4. Auto-muted users are automatically unmuted after their mute duration,
   unless a moderator has since muted them separately (checked via audit log).
5. Members with a role in `bypassRoleIds`, the server owner, and admins are
   never muted.
6. A timeout also moves the member into `timeoutRoomId` (if set), since a
   Discord timeout alone doesn't disconnect someone already in a call.
7. A soundboard sound plays on mute and/or timeout, if configured with
   `!setmutesound` / `!settimeoutsound`.
8. Every mute/unmute/timeout is logged as an embed in `logChannelId` (if
   set), with a random roast line and violation stats tracked in
   `stats.json` (gitignored — it's per-server data, not source). If a
   violation sets a new server-wide loudness record, the bot announces it
   in the log channel too.

See `config.example.json` for all tunable values (copy it to `config.json`
and edit, or use the in-Discord commands above) and `DEPLOY.md` for hosting
instructions (Google Cloud Compute Engine Always Free tier).
