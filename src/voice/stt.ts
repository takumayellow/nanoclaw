/**
 * Voice STT integration: wires VoiceTranscriber to a callback-based interface
 * and feeds transcriptions into the message pipeline.
 *
 * Usage in discord.ts joinVC():
 *   startListening(connection.receiver, onTranscript)
 */
import { VoiceConnection } from '@discordjs/voice';
import {
  VoiceTranscriber,
  VoiceTranscriptionOpts,
  TranscriptionEvent,
} from '../voice-transcription.js';
import { logger } from '../logger.js';

export type OnTranscript = (userId: string, text: string) => void;

/** Active transcriber instance, if any. */
let activeTranscriber: VoiceTranscriber | null = null;

/**
 * Start listening on a voice connection's receiver and invoke `onTranscript`
 * for each recognized utterance.
 *
 * Calling this while a previous transcriber is active will clean up the old one first.
 */
export function startListening(
  connection: VoiceConnection,
  channelId: string,
  onTranscript: OnTranscript,
  opts?: VoiceTranscriptionOpts,
): VoiceTranscriber {
  // Tear down any previous transcriber
  if (activeTranscriber) {
    activeTranscriber.cleanup();
    activeTranscriber = null;
  }

  const transcriber = new VoiceTranscriber(channelId, {
    language: 'ja',
    ...opts,
  });

  transcriber.on('transcription', (event: TranscriptionEvent) => {
    if (event.text) {
      onTranscript(event.userId, event.text);
    }
  });

  transcriber.subscribe(connection);
  activeTranscriber = transcriber;

  logger.info({ channelId }, 'Voice STT listening started');
  return transcriber;
}

/**
 * Stop the active transcriber, if any.
 */
export function stopListening(): void {
  if (activeTranscriber) {
    activeTranscriber.cleanup();
    activeTranscriber = null;
    logger.info('Voice STT listening stopped');
  }
}

/**
 * Get the currently active transcriber (for Agent G / TTS integration).
 */
export function getActiveTranscriber(): VoiceTranscriber | null {
  return activeTranscriber;
}

/**
 * Returns true if any user is currently speaking (has an active recording
 * in the transcriber). Used by the TTS player for interrupt detection.
 */
export function isUserSpeaking(): boolean {
  if (!activeTranscriber) return false;
  // VoiceTranscriber tracks per-user recordings internally.
  // We check if the receiver's speaking map has any active speakers.
  return (activeTranscriber as any).recordings?.size > 0;
}

// Re-export types for convenience
export { VoiceTranscriber, VoiceTranscriptionOpts, TranscriptionEvent };
