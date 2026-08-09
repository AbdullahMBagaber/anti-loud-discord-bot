# Deploying PhonoGuard on Google Cloud (Always Free tier)

This is what's actually running in production: a Compute Engine `e2-micro`
instance, which is free forever (not just a trial) in `us-west1`,
`us-central1`, or `us-east1`.

## 1. Create the instance

1. Create a Google Cloud project and enable billing (required even for
   free-tier resources, but an `e2-micro` in an eligible region isn't charged).
2. **Compute Engine → VM instances → Create Instance**.
3. Name it (e.g. `phonoguard`).
4. Region: `us-west1`, `us-central1`, or `us-east1` — only these are
   Always-Free eligible for `e2-micro`.
5. Machine type: `e2-micro` (2 vCPU burstable / 1GB RAM).
6. Boot disk: Debian (12 or later). Keep it at the free 30GB standard
   persistent disk limit.
7. Leave firewall defaults — PhonoGuard only makes outbound connections to
   Discord, so no inbound ports need to be opened beyond SSH.
8. Create the instance.

## 2. Connect

The simplest path (no SSH key management needed): open the instance in the
Cloud Console and click the **SSH** button next to it — this opens a
browser-based terminal authenticated with your Google account.

If you'd rather use a local `ssh` client with your own key pair, note that
GCP's **OS Login** feature (on by default on some projects) manages
`~/.ssh/authorized_keys` for you and will silently strip out any key you add
manually. Either use OS Login's own key-upload flow, or disable
`enable-oslogin` on the instance metadata and add your key normally — don't
mix the two.

## 3. Install dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git ffmpeg

# Node.js 22+ via NodeSource — required for @discordjs/voice's DAVE
# (end-to-end encrypted voice) support, which Discord made mandatory on
# all voice channels. Older Node/voice versions silently fail to receive
# any audio at all.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v22.x or newer

sudo npm install -g pm2
```

No build tools needed — this project deliberately avoids native
dependencies (`opusscript` instead of `@discordjs/opus`, Node's built-in
`aes-256-gcm` instead of `sodium`), since compiling those from source on a
1GB-RAM `e2-micro` is slow and version-fragile.

## 4. Clone and configure the bot

```bash
git clone https://github.com/<your-username>/anti-loud.git phonoguard
cd phonoguard
npm install

cp .env.example .env
nano .env        # set DISCORD_TOKEN=<your real bot token>

cp config.example.json config.json
nano config.json # set targetVoiceChannelId, logChannelId, bypassRoleIds, etc.
```

In the Discord Developer Portal, enable the **Server Members Intent** and
**Message Content Intent** privileged intents for the bot, and invite it
with `View Channel`, `Connect`, `Speak`, `Mute Members`, `Timeout Members`,
`Move Members`, and `Use Soundboard` permissions.

## 5. Start it with pm2

```bash
pm2 start bot.js --name phonoguard
pm2 save
pm2 startup      # run the printed command (sets pm2 to start on boot via systemd)
```

## 6. Confirm it's running

```bash
pm2 logs phonoguard
```

You should see the bot log in and the permission check results. Ctrl+C
exits the log view without stopping the process.

Useful pm2 commands going forward:

```bash
pm2 restart phonoguard --update-env   # after editing config.json, .env, or pulling updates
pm2 stop phonoguard
pm2 status
```

## 7. Verify it survives a reboot

```bash
sudo reboot
# wait ~30s, then reconnect (browser SSH button, or ssh if you set that up)
pm2 status                # phonoguard should already be "online"
pm2 logs phonoguard --lines 50
```

If it's not running after reboot, re-run the `pm2 startup` command it
printed in step 5 and `pm2 save` again.

## 8. Pulling updates

Once the repo is on GitHub, future code changes can be pulled directly
instead of copy-pasting files:

```bash
cd ~/phonoguard
git pull
npm install          # only needed if package.json changed
pm2 restart phonoguard --update-env
```
