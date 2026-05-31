/**
 * Voice activity heartbeat — touches a sentinel file on every meaningful
 * voice event (join, transcript, TTS reply, leave). The GCE idle watchdog
 * (`gcp/idle-watchdog.sh`) checks this file's mtime to decide whether to
 * auto-stop the VM.
 *
 * The path is configurable via NANOCLAW_VOICE_HEARTBEAT, which the GCE
 * systemd unit sets to /var/lib/nanoclaw/data/voice-active.timestamp.
 * When unset (local dev, tests), this module is a no-op.
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HEARTBEAT_PATH = process.env.NANOCLAW_VOICE_HEARTBEAT;

let warnedOnce = false;

/**
 * Update the heartbeat file's mtime to "now". Safe to call from any voice
 * code path — failures are swallowed (logged at most once) so a missing
 * directory never crashes the bot.
 */
export function touchHeartbeat(): void {
  if (!HEARTBEAT_PATH) return;
  try {
    const dir = dirname(HEARTBEAT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(HEARTBEAT_PATH)) writeFileSync(HEARTBEAT_PATH, '');
    const now = new Date();
    utimesSync(HEARTBEAT_PATH, now, now);
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn('[voice/heartbeat] touch failed:', err);
    }
  }
}
