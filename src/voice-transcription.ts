/**
 * Voice transcription module: captures Discord voice audio via @discordjs/voice,
 * detects silence boundaries, and transcribes speech using OpenAI Whisper API.
 *
 * Emits 'transcription' events with { userId, text, channelId }.
 */
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import {
  VoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface TranscriptionEvent {
  userId: string;
  userName: string;
  text: string;
  channelId: string;
}

export interface VoiceTranscriptionOpts {
  /** Milliseconds of silence before treating speech as complete. Default: 1500 */
  silenceThreshold?: number;
  /** Max recording duration per utterance in ms. Default: 60000 (60s) */
  maxDuration?: number;
  /** Whisper model to use. Default: 'whisper-1' */
  model?: string;
  /** Language hint for Whisper (ISO-639-1). Default: undefined (auto-detect) */
  language?: string;
}

const DEFAULT_SILENCE_THRESHOLD = 1500;
const DEFAULT_MAX_DURATION = 60_000;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20; // Opus frame duration

/** Per-user recording state */
interface UserRecording {
  chunks: Buffer[];
  silenceTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

function getOpenAIApiKey(): string {
  const env = readEnvFile(['OPENAI_API_KEY']);
  return process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';
}

/**
 * Transcribe a PCM audio buffer (s16le, 48kHz, stereo) using OpenAI Whisper API.
 * Converts to WAV in-memory before sending.
 */
async function transcribeWithWhisper(
  pcmBuffer: Buffer,
  model: string,
  language?: string,
): Promise<string> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — cannot transcribe voice');
    return '';
  }

  // Build WAV header for PCM data (s16le, 48kHz, stereo)
  const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE, CHANNELS);

  // Construct multipart form data manually
  const boundary = `----VoiceBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  // file part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
  );
  parts.push(wavBuffer);
  parts.push(Buffer.from('\r\n'));

  // model part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    ),
  );

  // language part (optional)
  if (language) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`,
      ),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const response = await fetch(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    logger.error(
      { status: response.status, body: errText },
      'Whisper API request failed',
    );
    return '';
  }

  const result = (await response.json()) as { text?: string };
  return result.text?.trim() || '';
}

/** Convert raw PCM (s16le) to a WAV buffer */
function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  numChannels: number,
): Buffer {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export class VoiceTranscriber extends EventEmitter {
  private recordings = new Map<string, UserRecording>();
  private opts: Required<
    Pick<VoiceTranscriptionOpts, 'silenceThreshold' | 'maxDuration' | 'model'>
  > &
    Pick<VoiceTranscriptionOpts, 'language'>;
  private connection: VoiceConnection | null = null;
  private channelId: string;
  private userNames = new Map<string, string>();
  private encoder: OpusScript;

  constructor(channelId: string, opts?: VoiceTranscriptionOpts) {
    super();
    this.channelId = channelId;
    this.opts = {
      silenceThreshold: opts?.silenceThreshold ?? DEFAULT_SILENCE_THRESHOLD,
      maxDuration: opts?.maxDuration ?? DEFAULT_MAX_DURATION,
      model: opts?.model ?? 'whisper-1',
      language: opts?.language,
    };
    this.encoder = new OpusScript(
      SAMPLE_RATE,
      CHANNELS,
      OpusScript.Application.VOIP,
    );
  }

  /** Set display name for a user (call when user info is available) */
  setUserName(userId: string, name: string): void {
    this.userNames.set(userId, name);
  }

  /** Start listening on a voice connection */
  subscribe(connection: VoiceConnection): void {
    this.connection = connection;
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      this.startRecording(userId, receiver);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.cleanup();
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanup();
    });

    logger.info({ channelId: this.channelId }, 'Voice transcriber subscribed');
  }

  private startRecording(
    userId: string,
    receiver: VoiceConnection['receiver'],
  ): void {
    // If already recording this user, just reset the silence timer
    const existing = this.recordings.get(userId);
    if (existing) {
      this.resetSilenceTimer(userId, existing);
      return;
    }

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.opts.silenceThreshold,
      },
    });

    const recording: UserRecording = {
      chunks: [],
      silenceTimer: null,
      startedAt: Date.now(),
      maxTimer: null,
    };

    this.recordings.set(userId, recording);

    // Decode opus to PCM
    opusStream.on('data', (chunk: Buffer) => {
      try {
        const pcm = this.encoder.decode(chunk);
        recording.chunks.push(pcm);
      } catch {
        // Skip corrupt frames
      }
      this.resetSilenceTimer(userId, recording);
    });

    opusStream.on('end', () => {
      this.finalizeRecording(userId);
    });

    opusStream.on('error', (err: Error) => {
      logger.error({ userId, err: err.message }, 'Opus stream error');
      this.cleanupUser(userId);
    });

    // Max duration safety
    recording.maxTimer = setTimeout(() => {
      logger.debug({ userId }, 'Max recording duration reached');
      this.finalizeRecording(userId);
    }, this.opts.maxDuration);

    logger.debug({ userId, channelId: this.channelId }, 'Started recording');
  }

  private resetSilenceTimer(userId: string, recording: UserRecording): void {
    if (recording.silenceTimer) {
      clearTimeout(recording.silenceTimer);
    }
    recording.silenceTimer = setTimeout(() => {
      this.finalizeRecording(userId);
    }, this.opts.silenceThreshold);
  }

  private async finalizeRecording(userId: string): Promise<void> {
    const recording = this.recordings.get(userId);
    if (!recording) return;

    this.cleanupTimers(recording);
    this.recordings.delete(userId);

    if (recording.chunks.length === 0) {
      logger.debug({ userId }, 'Empty recording, skipping transcription');
      return;
    }

    const pcmBuffer = Buffer.concat(recording.chunks);
    const durationMs = (pcmBuffer.length / (SAMPLE_RATE * CHANNELS * 2)) * 1000;

    // Skip very short utterances (< 0.5s) — likely noise
    if (durationMs < 500) {
      logger.debug(
        { userId, durationMs },
        'Recording too short, skipping transcription',
      );
      return;
    }

    logger.info(
      { userId, durationMs: Math.round(durationMs), channelId: this.channelId },
      'Transcribing voice audio',
    );

    try {
      const text = await transcribeWithWhisper(
        pcmBuffer,
        this.opts.model,
        this.opts.language,
      );

      if (text) {
        const event: TranscriptionEvent = {
          userId,
          userName: this.userNames.get(userId) || userId,
          text,
          channelId: this.channelId,
        };
        this.emit('transcription', event);
        logger.info(
          { userId, textLength: text.length, channelId: this.channelId },
          'Voice transcription complete',
        );
      }
    } catch (err) {
      logger.error(
        { userId, err: (err as Error).message },
        'Voice transcription failed',
      );
    }
  }

  private cleanupTimers(recording: UserRecording): void {
    if (recording.silenceTimer) clearTimeout(recording.silenceTimer);
    if (recording.maxTimer) clearTimeout(recording.maxTimer);
  }

  private cleanupUser(userId: string): void {
    const recording = this.recordings.get(userId);
    if (recording) {
      this.cleanupTimers(recording);
      this.recordings.delete(userId);
    }
  }

  /** Stop all recordings and detach from connection */
  cleanup(): void {
    for (const [userId, recording] of this.recordings) {
      this.cleanupTimers(recording);
      logger.debug({ userId }, 'Cleaned up recording');
    }
    this.recordings.clear();
    this.connection = null;
    logger.info({ channelId: this.channelId }, 'Voice transcriber cleaned up');
  }

  /** Get the channel ID this transcriber is attached to */
  getChannelId(): string {
    return this.channelId;
  }
}
