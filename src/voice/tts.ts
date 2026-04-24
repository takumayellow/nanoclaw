import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

/**
 * Convert text to speech using OpenAI TTS API.
 * Returns an MP3 audio buffer.
 */
export async function textToSpeech(text: string): Promise<Buffer> {
  const apiKey =
    process.env.OPENAI_API_KEY ||
    readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.error(
      { status: response.status, body },
      'OpenAI TTS API request failed',
    );
    throw new Error(`OpenAI TTS failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
