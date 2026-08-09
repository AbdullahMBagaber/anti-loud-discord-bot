/**
 * PhonoGuard — auto-mute Discord bot
 *
 * Extends the original loudness-tracking prototype with real enforcement:
 * sustained-loudness detection, mute/auto-unmute, violation escalation,
 * bypass roles, config-driven settings, live control commands, and logging.
 *
 * Loudness detection still uses ffmpeg's `ebur128` filter to compute LUFS
 * (Loudness Units Full Scale) from each user's decoded PCM audio, exactly
 * as the original prototype did. The one structural change from the
 * original: each speaking user now gets their OWN ffmpeg process instead
 * of everyone sharing a single global process/variable. The original's
 * single shared `ffmpegProcess` + `currentUserID` meant that if two people
 * spoke at once, their audio was mixed into one measurement and attributed
 * to whichever user's `speaking` event fired most recently — which makes
 * per-user muting unreliable. Per-user processes fix that while keeping
 * the same LUFS measurement approach and threshold semantics.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
	Client,
	GatewayIntentBits,
	ActivityType,
	EmbedBuilder,
	PermissionFlagsBits,
	AuditLogEvent,
} = require('discord.js');
const {
	joinVoiceChannel,
	getVoiceConnection,
	VoiceConnectionStatus,
	EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CALIBRATION_MS = 10000;

// ---------------------------------------------------------------------------
// Config (config.json) — no hardcoded thresholds/ids. See config.json for
// the editable values and README/DEPLOY.md for what each field means.
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
	targetVoiceChannelId: '',
	logChannelId: '',
	thresholdLevel: -5,          // LUFS — matches the original prototype's hardcoded value
	sustainedMs: 300,            // how long the level must stay above threshold before muting (lower = faster mute, more false positives)
	muteDurationMs: 30000,       // flat mute duration applied on every violation (30s)
	timeoutAfterViolations: 5,   // this violation # (and beyond) => Discord timeout instead of a plain mute
	timeoutDurationMs: 120000,   // length of the Discord timeout (2 min) — blocks voice + text
	cooldownMinutes: 60,         // rolling window for violation counting (1 hour)
	bypassRoleIds: [],           // role IDs that are never muted (mods/streamers, etc.)
	enabled: false,              // whether monitoring auto-starts on boot
	commandPrefix: '!',
	timeoutRoomId: '',           // voice channel timed-out members get moved to, if set (they stay connected during a timeout, just muted)
	sounds: {                    // guild soundboard sounds played on mute/timeout (set via !setmutesound / !settimeoutsound)
		mute: null,               // { soundId, name }
		timeout: null,            // { soundId, name }
	},
};

function loadConfig() {
	try {
		const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
		const saved = JSON.parse(raw);
		// Shallow-spread would leave `sounds` pointing at the same nested object
		// as DEFAULT_CONFIG.sounds (and drop a partially-saved sounds config), so
		// merge that one level deeper.
		return { ...DEFAULT_CONFIG, ...saved, sounds: { ...DEFAULT_CONFIG.sounds, ...saved.sounds } };
	} catch (err) {
		console.warn(`Could not read config.json (${err.message}); using defaults.`);
		return { ...DEFAULT_CONFIG, sounds: { ...DEFAULT_CONFIG.sounds } };
	}
}

function saveConfig() {
	try {
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
	} catch (err) {
		console.error('Failed to write config.json:', err);
	}
}

let config = loadConfig();

if (!process.env.DISCORD_TOKEN) {
	console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMembers,   // privileged — enable "Server Members Intent" in the dev portal
		GatewayIntentBits.MessageContent, // privileged — enable "Message Content Intent" in the dev portal
	],
});

let monitoringEnabled = false;
let currentConnection = null;
let currentGuild = null;
let currentVoiceChannel = null; // the VoiceChannel we're joined to — needed for sendSoundboardSound()

const userAudio = new Map();      // userId -> { proc }            (per-user ffmpeg processes)
const loudState = new Map();      // userId -> { loudSince, triggered } (sustain/debounce tracking)
const violationState = new Map(); // userId -> { count, windowStart }   (rolling escalation window)
const botMutes = new Map();       // userId -> { timer, mutedAt, duration, violationCount } (auto-unmute bookkeeping)
const calibration = { active: false, samples: [] };

// ---------------------------------------------------------------------------
// Bypass logic (fixes a bug in the original: `roles.cache.get(predicateFn)`
// doesn't work — Collection#get looks up by key, not by predicate. This uses
// `.some()` instead, and adds the hardcoded owner/admin exemption required
// regardless of config.)
// ---------------------------------------------------------------------------

function hasBypass(member) {
	if (!member) return false;
	if (member.guild.ownerId === member.id) return true;
	if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
	if (config.bypassRoleIds.length && member.roles.cache.some(role => config.bypassRoleIds.includes(role.id))) {
		return true;
	}
	return false;
}

function isAuthorized(message) {
	return Boolean(
		message.member &&
		(message.member.permissions.has(PermissionFlagsBits.MuteMembers) ||
			message.member.permissions.has(PermissionFlagsBits.Administrator))
	);
}

// ---------------------------------------------------------------------------
// Loudness measurement — one ffmpeg (ebur128) process per speaking user
// ---------------------------------------------------------------------------

const LUFS_REGEX = /M:\s*([\-\d.]+)\s*S:\s*([\-\d.]+)\s*I:\s*([\-\d.]+)\s*LUFS\s*LRA:\s*([\-\d.]+)/;

function spawnFfmpeg() {
	const args = [
		'-loglevel', 'debug',
		'-nostats', '-hide_banner',
		'-f', 's16le',
		'-ar', '48k',
		'-ac', '2',
		'-i', 'pipe:0',
		'-filter_complex', 'ebur128',
		'-f', 'null', '-',
	];
	return spawn('ffmpeg', args);
}

const DEBUG_AUDIO = process.env.DEBUG_AUDIO === '1';

function getUserProcessor(userId) {
	const existing = userAudio.get(userId);
	if (existing) return existing;

	if (DEBUG_AUDIO) console.log(`[debug] spawning ffmpeg processor for user ${userId}`);
	const proc = spawnFfmpeg();
	let debugChunks = 0;
	let pcmBytesSeen = 0;

	proc.stderr.on('data', (data) => {
		try {
			const output = data.toString();
			if (DEBUG_AUDIO && debugChunks < 8) {
				debugChunks++;
				console.log(`[debug] ffmpeg stderr chunk #${debugChunks} for ${userId}: ${JSON.stringify(output.slice(0, 300))}`);
			}
			const match = output.match(LUFS_REGEX);
			if (!match) return;
			const momentaryLufs = parseFloat(match[1]);
			const shortTermLufs = parseFloat(match[2]);
			const level = Math.max(momentaryLufs, shortTermLufs);

			if (DEBUG_AUDIO) console.log(`[debug] parsed level for ${userId}: ${level} LUFS (calibration.active=${calibration.active}, monitoringEnabled=${monitoringEnabled})`);

			if (calibration.active) calibration.samples.push(level);

			if (!currentGuild || !monitoringEnabled) return;
			const member = currentGuild.members.cache.get(userId);
			if (!member) return;
			handleLoudnessReading(userId, level, member);
		} catch (err) {
			console.error(`Error processing loudness data for user ${userId}:`, err);
		}
	});

	proc.stdout.on('data', () => { /* discarded — ebur128 output goes to stderr */ });
	proc.on('error', (err) => console.error(`ffmpeg process error for user ${userId}:`, err));
	proc.on('close', (code, signal) => {
		if (DEBUG_AUDIO) console.log(`[debug] ffmpeg for ${userId} closed (code=${code}, signal=${signal}), saw ${pcmBytesSeen} PCM bytes total`);
		userAudio.delete(userId);
	});

	const record = { proc, trackBytes: (n) => { pcmBytesSeen += n; } };
	userAudio.set(userId, record);
	return record;
}

function stopUserProcessor(userId) {
	const record = userAudio.get(userId);
	if (record) {
		try { record.proc.kill('SIGKILL'); } catch (_) { /* already dead */ }
		userAudio.delete(userId);
	}
	loudState.delete(userId);
}

// ---------------------------------------------------------------------------
// Sustain / debounce check — require the level to stay above threshold for
// config.sustainedMs (roughly 800ms-1.5s) before treating it as a violation,
// so a single spike (cough, static) doesn't trigger a mute.
// ---------------------------------------------------------------------------

function handleLoudnessReading(userId, level, member) {
	if (hasBypass(member)) return;

	const now = Date.now();
	const state = loudState.get(userId) || { loudSince: null, triggered: false };

	if (level > config.thresholdLevel) {
		if (!state.loudSince) state.loudSince = now;
		if (!state.triggered && now - state.loudSince >= config.sustainedMs) {
			state.triggered = true;
			loudState.set(userId, state);
			triggerViolation(member, level).catch(err =>
				console.error(`Error handling violation for ${member.user?.tag ?? userId}:`, err));
			return;
		}
	} else {
		state.loudSince = null;
		state.triggered = false;
	}
	loudState.set(userId, state);
}

// ---------------------------------------------------------------------------
// Violation escalation: every violation gets a flat `muteDurationMs` mute.
// Once a user hits `timeoutAfterViolations` violations within the rolling
// `cooldownMinutes` window, they get a Discord timeout (blocks voice + text)
// for `timeoutDurationMs` instead of another plain mute.
// ---------------------------------------------------------------------------

async function triggerViolation(member, level) {
	if (!member.voice.channelId || member.voice.channelId !== config.targetVoiceChannelId) return;
	if (hasBypass(member)) return;

	const now = Date.now();
	let v = violationState.get(member.id);
	if (!v || now - v.windowStart > config.cooldownMinutes * 60000) {
		v = { count: 0, windowStart: now };
	}
	v.count += 1;
	violationState.set(member.id, v);

	if (v.count >= config.timeoutAfterViolations) {
		await timeoutMember(member, level, v.count);
		return;
	}

	await muteMember(member, level, v.count, config.muteDurationMs);
}

async function muteMember(member, level, violationCount, duration) {
	try {
		await member.voice.setMute(true, `PhonoGuard: exceeded volume threshold (violation ${violationCount})`);
	} catch (err) {
		console.error(`Failed to mute ${member.user?.tag ?? member.id}:`, err);
		return;
	}

	const existing = botMutes.get(member.id);
	if (existing?.timer) clearTimeout(existing.timer);

	const mutedAt = Date.now();
	const timer = setTimeout(() => {
		autoUnmute(member.id).catch(err => console.error(`Auto-unmute error for ${member.id}:`, err));
	}, duration);
	timer.unref?.();
	botMutes.set(member.id, { timer, mutedAt, duration, violationCount });

	await logAction({ action: 'Muted', member, level, violationCount, durationMs: duration });
	playSound('mute');
}

async function autoUnmute(userId) {
	const record = botMutes.get(userId);
	if (!record) return;
	botMutes.delete(userId);

	if (!currentGuild) return;
	const member = await currentGuild.members.fetch(userId).catch(() => null);
	if (!member || !member.voice.channelId || !member.voice.mute) return;

	// Don't undo a mute a human moderator applied/kept after ours. Discord
	// doesn't fire a voiceStateUpdate for "still muted, muted again", so we
	// check the audit log for a MemberUpdate(mute) entry newer than our own
	// mute, executed by someone other than this bot.
	try {
		const logs = await currentGuild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
		const modOverride = logs.entries.find(entry =>
			entry.target?.id === userId &&
			entry.executor?.id !== client.user.id &&
			entry.createdTimestamp > record.mutedAt &&
			entry.changes?.some(c => c.key === 'mute')
		);
		if (modOverride) {
			console.log(`Skipping auto-unmute for ${userId}; moderator ${modOverride.executor?.tag ?? modOverride.executor?.id} muted them separately.`);
			return;
		}
	} catch (err) {
		console.warn(`Could not check audit log before auto-unmuting ${userId} (missing View Audit Log permission?): ${err.message}`);
	}

	try {
		await member.voice.setMute(false, 'PhonoGuard: mute duration expired');
		await logAction({ action: 'Unmuted', member, violationCount: record.violationCount });
	} catch (err) {
		console.error(`Failed to unmute ${member.user?.tag ?? userId}:`, err);
	}
}

async function timeoutMember(member, level, violationCount) {
	try {
		await member.timeout(config.timeoutDurationMs, `PhonoGuard: ${violationCount} volume violations within ${config.cooldownMinutes} min`);
	} catch (err) {
		console.error(`Failed to time out ${member.user?.tag ?? member.id}:`, err);
		return;
	}
	await logAction({ action: 'Timed out', member, level, violationCount, durationMs: config.timeoutDurationMs });
	playSound('timeout');
	moveToTimeoutRoom(member);
}

// ---------------------------------------------------------------------------
// Soundboard — plays one of the guild's own soundboard sounds in the target
// voice channel when someone is muted/timed out. Uses Discord's native
// soundboard REST endpoint (VoiceChannel#sendSoundboardSound), not audio
// streaming, so it just fires-and-forgets alongside whatever's already
// playing. Which sound plays for which event is configured live via
// !setmutesound / !settimeoutsound (see command handlers below) and stored
// in config.sounds.{mute,timeout} as { soundId, name }.
// ---------------------------------------------------------------------------

function playSound(kind) {
	const sound = config.sounds?.[kind];
	if (!sound?.soundId || !currentVoiceChannel) return;

	currentVoiceChannel.sendSoundboardSound({ soundId: sound.soundId }).catch(err => {
		console.error(`Failed to play "${kind}" soundboard sound (${sound.name ?? sound.soundId}):`, err.message);
	});
}

async function fetchGuildSoundboardSounds(guild) {
	const sounds = await guild.soundboardSounds.fetch();
	return [...sounds.values()];
}

function findSoundboardSound(sounds, query) {
	const q = query.trim().toLowerCase();
	return sounds.find(s => s.soundId === query) || sounds.find(s => s.name.toLowerCase() === q);
}

// ---------------------------------------------------------------------------
// Timeout room — a Discord timeout blocks speaking/typing but does NOT
// disconnect someone already sitting in a voice channel, so a timed-out
// member would otherwise just sit there muted. If config.timeoutRoomId is
// set, move them there instead so they're visibly and audibly separated
// from the rest of the call for the duration of the timeout.
// ---------------------------------------------------------------------------

function moveToTimeoutRoom(member) {
	if (!config.timeoutRoomId) return;
	if (!member.voice.channelId || member.voice.channelId === config.timeoutRoomId) return;

	member.voice.setChannel(config.timeoutRoomId, 'PhonoGuard: moved to timeout room').catch(err => {
		console.error(`Failed to move ${member.user?.tag ?? member.id} to the timeout room:`, err.message);
	});
}

// ---------------------------------------------------------------------------
// Logging — embed to config.logChannelId, falls back to plain text if the
// channel can't be resolved (or is unset, in which case it's just skipped).
// ---------------------------------------------------------------------------

async function logAction({ action, member, level, violationCount, durationMs }) {
	if (!config.logChannelId || !currentGuild) return;
	const channel = await currentGuild.channels.fetch(config.logChannelId).catch(() => null);
	if (!channel || !channel.isTextBased()) return;

	const color = action === 'Unmuted' ? 0x57F287 : action === 'Timed out' ? 0xED4245 : 0xFEE75C;
	const fields = [
		{ name: 'User', value: `${member.user?.tag ?? member.id} (${member.id})`, inline: true },
		{ name: 'Violation #', value: String(violationCount ?? '-'), inline: true },
	];
	if (typeof level === 'number') fields.push({ name: 'Measured Level', value: `${level.toFixed(2)} LUFS`, inline: true });
	if (typeof durationMs === 'number') fields.push({ name: 'Mute Duration', value: `${Math.round(durationMs / 1000)}s`, inline: true });

	try {
		const embed = new EmbedBuilder()
			.setTitle(`PhonoGuard: ${action}`)
			.setColor(color)
			.addFields(fields)
			.setTimestamp();
		await channel.send({ embeds: [embed] });
	} catch (err) {
		// Fall back to plain text if embeds can't be sent for some reason.
		try {
			await channel.send(`PhonoGuard: ${action} — ${member.user?.tag ?? member.id} (violation #${violationCount ?? '-'})`);
		} catch (err2) {
			console.error('Failed to send log message:', err2);
		}
	}
}

// ---------------------------------------------------------------------------
// Voice connection + per-user audio pipeline
// ---------------------------------------------------------------------------

function attachReceiverListeners(receiver, guild) {
	receiver.speaking.on('start', async (userId) => {
		try {
			if (DEBUG_AUDIO) console.log(`[debug] speaking.start fired for ${userId} (monitoringEnabled=${monitoringEnabled}, calibration.active=${calibration.active})`);
			// Let audio through if monitoring is on OR a calibration is running —
			// calibration needs samples even if enforcement isn't enabled yet.
			if (!monitoringEnabled && !calibration.active) {
				if (DEBUG_AUDIO) console.log(`[debug] skipping ${userId}: monitoring off and no calibration running`);
				return;
			}

			let member = guild.members.cache.get(userId);
			if (!member) member = await guild.members.fetch(userId).catch(() => null);
			if (!member) {
				if (DEBUG_AUDIO) console.log(`[debug] skipping ${userId}: member not resolvable`);
				return;
			}
			// Bypass-exempt members (owner/admins/bypass roles) still get skipped for
			// real enforcement, but calibration is passive measurement only — it
			// should see everyone in the channel, including whoever is testing it.
			if (hasBypass(member) && !calibration.active) {
				if (DEBUG_AUDIO) console.log(`[debug] skipping ${userId}: bypass-exempt and not calibrating`);
				return;
			}

			const { proc, trackBytes } = getUserProcessor(userId);
			if (DEBUG_AUDIO) console.log(`[debug] subscribing to audio for ${userId}`);

			const audioStream = receiver.subscribe(userId, {
				end: { behavior: EndBehaviorType.AfterSilence, duration: 100 },
			});
			const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
			audioStream.pipe(decoder);

			let pcmChunks = 0;
			decoder.on('data', (pcmData) => {
				try {
					if (DEBUG_AUDIO && pcmChunks < 5) {
						pcmChunks++;
						console.log(`[debug] decoded PCM chunk #${pcmChunks} for ${userId}: ${pcmData.length} bytes`);
					}
					trackBytes?.(pcmData.length);
					if (proc && !proc.killed && proc.stdin.writable) {
						proc.stdin.write(pcmData);
					}
				} catch (err) {
					console.error(`Error writing audio data for user ${userId}:`, err);
				}
			});
			decoder.on('error', (err) => console.error(`Decoder error for user ${userId}:`, err));
		} catch (err) {
			// A single user's decode/setup failure must never take down the bot.
			console.error(`Error handling speaking event for user ${userId}:`, err);
		}
	});
}

async function connectToChannel(guild, channelId) {
	const channel = await guild.channels.fetch(channelId).catch(() => null);
	if (!channel || !channel.isVoiceBased()) {
		throw new Error(`Channel ${channelId} was not found or is not a voice channel.`);
	}
	const connection = joinVoiceChannel({
		channelId: channel.id,
		guildId: guild.id,
		adapterCreator: guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});
	connection.on(VoiceConnectionStatus.Disconnected, () => {
		console.warn('Voice connection disconnected.');
		monitoringEnabled = false;
		currentVoiceChannel = null;
	});
	connection.on('stateChange', (oldState, newState) => {
		console.log(`[voice] connection state: ${oldState.status} -> ${newState.status}`);
	});
	connection.on('error', (err) => console.error('[voice] connection error:', err));
	console.log(`[voice] joinVoiceChannel called for channel ${channel.id}, initial state: ${connection.state.status}`);
	currentConnection = connection;
	currentGuild = guild;
	currentVoiceChannel = channel;
	attachReceiverListeners(connection.receiver, guild);
	return connection;
}

// ---------------------------------------------------------------------------
// Cleanup when a user leaves the monitored channel
// ---------------------------------------------------------------------------

client.on('voiceStateUpdate', (oldState, newState) => {
	const userId = newState.id || oldState.id;
	if (oldState.channelId === config.targetVoiceChannelId && newState.channelId !== config.targetVoiceChannelId) {
		stopUserProcessor(userId);
	}
});

// ---------------------------------------------------------------------------
// Startup permission check
// ---------------------------------------------------------------------------

async function checkPermissions(guild) {
	const me = await guild.members.fetchMe().catch(() => null);
	if (!me) {
		console.error(`[PERMISSION ERROR] Could not resolve bot member in guild "${guild.name}".`);
		return;
	}
	const required = [
		['View Channel', PermissionFlagsBits.ViewChannel],
		['Connect', PermissionFlagsBits.Connect],
		['Mute Members', PermissionFlagsBits.MuteMembers],
		['Timeout Members', PermissionFlagsBits.ModerateMembers],
	];
	const missing = required.filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
	if (missing.length) {
		console.error(`[PERMISSION ERROR] Bot is missing required permissions in guild "${guild.name}": ${missing.join(', ')}. Enforcement will not work correctly until these are granted.`);
	} else {
		console.log(`Permission check passed for guild "${guild.name}".`);
	}

	// Soundboard playback and moving members to the timeout room are optional
	// — mute/timeout enforcement still works without them, so this is a
	// warning, not an error.
	const optionalMissing = [
		['Speak', PermissionFlagsBits.Speak],
		['Use Soundboard', PermissionFlagsBits.UseSoundboard],
		['Move Members', PermissionFlagsBits.MoveMembers],
	].filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
	if (optionalMissing.length) {
		console.warn(`[PERMISSION WARNING] Bot is missing "${optionalMissing.join(', ')}" in guild "${guild.name}" — soundboard sounds and/or moving members to the timeout room won't work until these are granted.`);
	}
}

// ---------------------------------------------------------------------------
// Commands: enable/join, disable, setthreshold, calibrate, status
// (kept as prefix commands, matching the original repo's `!join` style)
// ---------------------------------------------------------------------------

async function handleEnable(message) {
	const targetId = config.targetVoiceChannelId || message.member.voice.channelId;
	if (!targetId) {
		message.reply('No `targetVoiceChannelId` is configured and you are not in a voice channel. Join one first or set it in config.json.');
		return;
	}
	if (!config.targetVoiceChannelId) config.targetVoiceChannelId = targetId;

	try {
		if (!currentConnection || currentConnection.joinConfig.channelId !== targetId || getVoiceConnection(message.guild.id) === undefined) {
			await connectToChannel(message.guild, targetId);
		}
		monitoringEnabled = true;
		config.enabled = true;
		saveConfig();
		message.reply(`Monitoring enabled in <#${targetId}> (threshold ${config.thresholdLevel} LUFS).`);
	} catch (err) {
		console.error('Failed to enable monitoring:', err);
		message.reply(`Failed to join the voice channel: ${err.message}`);
	}
}

async function handleDisable(message) {
	monitoringEnabled = false;
	config.enabled = false;
	saveConfig();

	for (const userId of [...userAudio.keys()]) stopUserProcessor(userId);

	const conn = getVoiceConnection(message.guild.id);
	if (conn) conn.destroy();
	currentConnection = null;

	message.reply('Monitoring disabled.');
}

async function handleSetThreshold(message, rawValue) {
	const value = parseFloat(rawValue);
	if (Number.isNaN(value)) {
		message.reply('Usage: `!setthreshold <number>` (LUFS — e.g. `!setthreshold -8`)');
		return;
	}
	config.thresholdLevel = value;
	saveConfig();
	message.reply(`Threshold set to ${value} LUFS.`);
}

function parsePositiveSeconds(rawValue) {
	const value = parseFloat(rawValue);
	if (Number.isNaN(value) || value <= 0) return null;
	return value;
}

async function handleSetSustained(message, rawValue) {
	const ms = parseInt(rawValue, 10);
	if (Number.isNaN(ms) || ms < 50) {
		message.reply('Usage: `!setsustained <ms>` (e.g. `!setsustained 300`) — minimum 50ms. Lower = faster mute but more false positives from brief spikes (coughs, mic pops).');
		return;
	}
	config.sustainedMs = ms;
	saveConfig();
	message.reply(`Sustain window set to ${ms}ms — a scream now has to hold above threshold for ${ms}ms before muting.`);
}

async function handleSetMuteDuration(message, rawValue) {
	const seconds = parsePositiveSeconds(rawValue);
	if (seconds === null) {
		message.reply('Usage: `!setmuteduration <seconds>` (e.g. `!setmuteduration 30`)');
		return;
	}
	config.muteDurationMs = Math.round(seconds * 1000);
	saveConfig();
	message.reply(`Mute duration set to ${seconds}s per violation.`);
}

async function handleSetTimeoutDuration(message, rawValue) {
	const seconds = parsePositiveSeconds(rawValue);
	if (seconds === null) {
		message.reply('Usage: `!settimeoutduration <seconds>` (e.g. `!settimeoutduration 120`)');
		return;
	}
	config.timeoutDurationMs = Math.round(seconds * 1000);
	saveConfig();
	message.reply(`Timeout duration set to ${seconds}s.`);
}

async function handleSetTimeoutRoom(message, rawArg) {
	const arg = (rawArg || '').trim();
	if (arg.toLowerCase() === 'off' || arg.toLowerCase() === 'none') {
		config.timeoutRoomId = '';
		saveConfig();
		message.reply('Timeout room cleared — timed-out members will stay wherever they are.');
		return;
	}

	let channelId = arg.replace(/[<#>]/g, ''); // allow pasting a #channel mention or raw ID
	if (!channelId) channelId = message.member.voice.channelId; // default to the invoker's current voice channel

	if (!channelId) {
		message.reply('Usage: `!settimeoutroom <#voice-channel or channel ID>` (or `off` to disable) — or join a voice channel and run it with no argument to use that one.');
		return;
	}

	const channel = await message.guild.channels.fetch(channelId).catch(() => null);
	if (!channel || !channel.isVoiceBased()) {
		message.reply('That channel could not be found or is not a voice channel. Usage: `!settimeoutroom <#voice-channel or channel ID>`.');
		return;
	}

	config.timeoutRoomId = channel.id;
	saveConfig();
	message.reply(`Timeout room set to **${channel.name}** — members currently in voice get moved there when timed out.`);
}

async function handleSetTimeoutAfter(message, rawValue) {
	const count = parseInt(rawValue, 10);
	if (Number.isNaN(count) || count < 2) {
		message.reply('Usage: `!settimeoutafter <violations>` (whole number, at least 2 — e.g. `!settimeoutafter 5`)');
		return;
	}
	config.timeoutAfterViolations = count;
	saveConfig();
	message.reply(`Timeout now triggers on the ${count}th violation within the cooldown window.`);
}

async function handleSetCooldown(message, rawValue) {
	const minutes = parsePositiveSeconds(rawValue); // reuse: just needs a positive number
	if (minutes === null) {
		message.reply('Usage: `!setcooldown <minutes>` (e.g. `!setcooldown 60`)');
		return;
	}
	config.cooldownMinutes = minutes;
	saveConfig();
	message.reply(`Violation cooldown window set to ${minutes} minute(s).`);
}

async function handleSetLogChannel(message, rawArg) {
	let channelId = rawArg?.replace(/[<#>]/g, ''); // allow pasting a #channel mention or raw ID
	if (!channelId) channelId = message.channel.id; // default to the channel the command was run in
	const channel = await message.guild.channels.fetch(channelId).catch(() => null);
	if (!channel || !channel.isTextBased()) {
		message.reply('Usage: `!setlogchannel [#channel or channel ID]` — or run it with no argument to use the current channel.');
		return;
	}
	config.logChannelId = channel.id;
	saveConfig();
	message.reply(`Log channel set to <#${channel.id}>.`);
}

async function handleBypassRole(message, rawArg, add) {
	const roleId = rawArg?.replace(/[<@&>]/g, ''); // allow pasting a @role mention or raw ID
	if (!roleId) {
		message.reply(`Usage: \`!${add ? 'addbypassrole' : 'removebypassrole'} <@role or role ID>\``);
		return;
	}
	if (add) {
		if (!config.bypassRoleIds.includes(roleId)) config.bypassRoleIds.push(roleId);
		saveConfig();
		message.reply(`Added <@&${roleId}> to the bypass list.`);
	} else {
		config.bypassRoleIds = config.bypassRoleIds.filter(id => id !== roleId);
		saveConfig();
		message.reply(`Removed <@&${roleId}> from the bypass list.`);
	}
}

async function runCalibration(message) {
	if (calibration.active) {
		message.reply('Calibration is already running — wait for it to finish.');
		return;
	}
	const targetId = config.targetVoiceChannelId || message.member.voice.channelId;
	if (!targetId) {
		message.reply('No target voice channel configured and you are not in a voice channel.');
		return;
	}
	try {
		if (!currentConnection || currentConnection.joinConfig.channelId !== targetId) {
			await connectToChannel(message.guild, targetId);
		}
	} catch (err) {
		message.reply(`Failed to join the voice channel: ${err.message}`);
		return;
	}

	// Calibration is a passive measurement: it captures audio samples without
	// enforcing (it does NOT flip `monitoringEnabled`), so nobody can get
	// muted as a side effect of running !calibrate.
	calibration.active = true;
	calibration.samples = [];
	message.reply(`Calibrating for ${CALIBRATION_MS / 1000}s — have people talk normally now (this will NOT mute anyone)...`);

	setTimeout(() => {
		calibration.active = false;
		const samples = calibration.samples;
		if (samples.length === 0) {
			message.channel.send('No audio was captured during calibration — make sure people were talking in the voice channel.');
			return;
		}
		const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
		const peak = Math.max(...samples);
		message.channel.send(
			`Calibration complete (${samples.length} samples).\n` +
			`Average level: ${avg.toFixed(2)} LUFS\n` +
			`Peak level: ${peak.toFixed(2)} LUFS\n` +
			`Suggested threshold: around ${(peak + 1).toFixed(1)} to ${(peak + 3).toFixed(1)} LUFS (a few LUFS above the peak of normal talking). Set it with \`!setthreshold <value>\`.`
		);
	}, CALIBRATION_MS);
}

async function handleListSounds(message) {
	let sounds;
	try {
		sounds = await fetchGuildSoundboardSounds(message.guild);
	} catch (err) {
		message.reply(`Could not fetch this server's soundboard sounds: ${err.message}`);
		return;
	}
	if (sounds.length === 0) {
		message.reply('This server has no soundboard sounds yet — add some under Server Settings → Soundboard, then run `!listsounds` again.');
		return;
	}
	const lines = sounds.map(s => `• **${s.name}** — \`${s.soundId}\``);
	const current = `Currently set — mute: **${config.sounds?.mute?.name ?? 'none'}**, timeout: **${config.sounds?.timeout?.name ?? 'none'}**`;
	message.reply(
		`**Available soundboard sounds:**\n${lines.join('\n')}\n\n${current}\n\n` +
		'Set with `!setmutesound <name>` / `!settimeoutsound <name>` (use `off` to clear).'
	);
}

async function handleSetSound(message, rawQuery, kind) {
	const query = (rawQuery || '').trim();
	const label = kind === 'mute' ? 'mute' : 'timeout';
	if (!query) {
		message.reply(`Usage: \`!set${label}sound <sound name or ID>\` (or \`!set${label}sound off\` to clear) — run \`!listsounds\` to see what's available.`);
		return;
	}
	if (query.toLowerCase() === 'off' || query.toLowerCase() === 'none') {
		config.sounds[kind] = null;
		saveConfig();
		message.reply(`Cleared the ${label} sound — nothing will play on ${kind === 'mute' ? 'mutes' : 'timeouts'} now.`);
		return;
	}
	let sounds;
	try {
		sounds = await fetchGuildSoundboardSounds(message.guild);
	} catch (err) {
		message.reply(`Could not fetch this server's soundboard sounds: ${err.message}`);
		return;
	}
	const match = findSoundboardSound(sounds, query);
	if (!match) {
		message.reply(`No soundboard sound found matching "${query}". Run \`!listsounds\` to see the available names.`);
		return;
	}
	config.sounds[kind] = { soundId: match.soundId, name: match.name };
	saveConfig();
	message.reply(`"${match.name}" will now play whenever someone is ${kind === 'mute' ? 'muted' : 'timed out'}.`);
}

async function showStatus(message) {
	const mutedList = [...botMutes.entries()].map(([id, r]) => {
		const remaining = Math.max(0, Math.round((r.mutedAt + r.duration - Date.now()) / 1000));
		return `<@${id}> — violation #${r.violationCount}, auto-unmutes in ${remaining}s`;
	});

	const embed = new EmbedBuilder()
		.setTitle('PhonoGuard Status')
		.setColor(monitoringEnabled ? 0x57F287 : 0xED4245)
		.addFields(
			{ name: 'Monitoring', value: monitoringEnabled ? 'Enabled' : 'Disabled', inline: true },
			{ name: 'Target Voice Channel', value: config.targetVoiceChannelId ? `<#${config.targetVoiceChannelId}>` : 'Not set', inline: true },
			{ name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true },
			{ name: 'Threshold', value: `${config.thresholdLevel} LUFS`, inline: true },
			{ name: 'Sustain Window', value: `${config.sustainedMs} ms`, inline: true },
			{ name: 'Cooldown', value: `${config.cooldownMinutes} min`, inline: true },
			{
				name: 'Escalation',
				value: `${config.muteDurationMs / 1000}s mute per violation | ${config.timeoutAfterViolations}+ violations in ${config.cooldownMinutes}min \u2192 ${config.timeoutDurationMs / 1000}s timeout`,
				inline: false,
			},
			{ name: 'Timeout Room', value: config.timeoutRoomId ? `<#${config.timeoutRoomId}>` : 'Not set', inline: true },
			{
				name: 'Bypass Roles',
				value: config.bypassRoleIds.length ? config.bypassRoleIds.map(id => `<@&${id}>`).join(', ') : 'None (owner/admins are always bypassed)',
				inline: false,
			},
			{ name: 'Currently Muted by Bot', value: mutedList.length ? mutedList.join('\n') : 'No one', inline: false },
			{
				name: 'Soundboard',
				value: `Mute: ${config.sounds?.mute?.name ?? 'none'} | Timeout: ${config.sounds?.timeout?.name ?? 'none'}`,
				inline: false,
			},
		);
	message.channel.send({ embeds: [embed] });
}

client.on('messageCreate', async (message) => {
	if (message.author.bot || !message.guild) return;
	if (!message.content.startsWith(config.commandPrefix)) return;

	const [cmdRaw, ...args] = message.content.slice(config.commandPrefix.length).trim().split(/\s+/);
	const cmd = (cmdRaw || '').toLowerCase();

	try {
		switch (cmd) {
			case 'join':
			case 'enable':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleEnable(message);
				break;
			case 'disable':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleDisable(message);
				break;
			case 'setthreshold':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetThreshold(message, args[0]);
				break;
			case 'setmuteduration':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetMuteDuration(message, args[0]);
				break;
			case 'settimeoutduration':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetTimeoutDuration(message, args[0]);
				break;
			case 'settimeoutroom':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetTimeoutRoom(message, args.join(' '));
				break;
			case 'settimeoutafter':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetTimeoutAfter(message, args[0]);
				break;
			case 'setcooldown':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetCooldown(message, args[0]);
				break;
			case 'setsustained':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetSustained(message, args[0]);
				break;
			case 'setlogchannel':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetLogChannel(message, args[0]);
				break;
			case 'addbypassrole':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleBypassRole(message, args[0], true);
				break;
			case 'removebypassrole':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleBypassRole(message, args[0], false);
				break;
			case 'calibrate':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await runCalibration(message);
				break;
			case 'listsounds':
				await handleListSounds(message);
				break;
			case 'setmutesound':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetSound(message, args.join(' '), 'mute');
				break;
			case 'settimeoutsound':
				if (!isAuthorized(message)) return void message.reply('You need the "Mute Members" permission to do that.');
				await handleSetSound(message, args.join(' '), 'timeout');
				break;
			case 'status':
				await showStatus(message);
				break;
			default:
				break;
		}
	} catch (err) {
		console.error(`Error handling command "${cmd}":`, err);
		message.reply('Something went wrong running that command — check the bot logs.').catch(() => {});
	}
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

client.once('ready', async () => {
	console.log(`Bot is ready! Logged in as ${client.user.tag}`);
	client.user.setPresence({
		activities: [{ type: ActivityType.Listening, name: 'your volume lvls' }],
		status: 'online',
	});

	for (const guild of client.guilds.cache.values()) {
		await checkPermissions(guild);
	}

	if (config.enabled && config.targetVoiceChannelId) {
		const guild = client.guilds.cache.first();
		if (guild) {
			try {
				await connectToChannel(guild, config.targetVoiceChannelId);
				monitoringEnabled = true;
				console.log(`Auto-connected to voice channel ${config.targetVoiceChannelId} and resumed monitoring.`);
			} catch (err) {
				console.error('Failed to auto-connect to the configured voice channel on startup:', err);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Global safety nets — one bad event should never crash the whole process
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

function shutdown() {
	console.log('Shutting down PhonoGuard...');
	for (const userId of [...userAudio.keys()]) stopUserProcessor(userId);
	if (currentGuild) {
		const conn = getVoiceConnection(currentGuild.id);
		if (conn) conn.destroy();
	}
	client.destroy();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.DISCORD_TOKEN);
