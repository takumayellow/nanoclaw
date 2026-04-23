import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  StreamType,
} from '@discordjs/voice';
import { Readable } from 'node:stream';

import { logger } from '../logger.js';
import { isUserSpeaking } from './stt.js';

/**
 * Play an audio buffer (MP3) over a Discord voice connection.
 * Supports interrupt: if isUserSpeaking() returns true during playback,
 * the player stops immediately.
 */
export async function playAudio(
  connection: VoiceConnection,
  audioBuffer: Buffer,
): Promise<void> {
  const player = createAudioPlayer();
  const stream = Readable.from(audioBuffer);
  const resource = createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
  });

  connection.subscribe(player);
  player.play(resource);

  return new Promise<void>((resolve) => {
    // Poll for user speaking to implement interrupt
    const interruptCheck = setInterval(() => {
      if (
        isUserSpeaking() &&
        player.state.status === AudioPlayerStatus.Playing
      ) {
        logger.info('User speaking detected — interrupting playback');
        player.stop();
      }
    }, 200);

    player.on(AudioPlayerStatus.Idle, () => {
      clearInterval(interruptCheck);
      resolve();
    });

    player.on('error', (err) => {
      clearInterval(interruptCheck);
      logger.error({ err }, 'Audio player error');
      resolve();
    });
  });
}
