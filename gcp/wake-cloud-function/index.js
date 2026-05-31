/**
 * nanoclaw — /wake Discord interaction handler (Cloud Functions Gen2, Node 22)
 *
 * Receives Discord interaction webhooks for two slash commands:
 *   /wake  → starts the nanoclaw GCE instance, then replies
 *   /sleep → stops the nanoclaw GCE instance (force-idle)
 *
 * Why a Cloud Function instead of running the command handler in the bot itself:
 *   the bot is OFF while the VM is stopped. Discord's slash-command endpoint
 *   needs to respond within 3 seconds even when our main process isn't running.
 *
 * Setup (see gcp/README.md for full walkthrough):
 *   1. gcloud functions deploy nanoclaw-wake --gen2 --runtime=nodejs22 \
 *        --region=us-central1 --source=gcp/wake-cloud-function \
 *        --entry-point=discordInteraction --trigger-http --allow-unauthenticated \
 *        --set-secrets=DISCORD_PUBLIC_KEY=DISCORD_PUBLIC_KEY:latest \
 *        --set-env-vars=GCP_PROJECT=nanoclaw-bot-takum,GCE_ZONE=us-central1-a,GCE_INSTANCE=nanoclaw-vm
 *   2. Register the function URL as the bot's Interactions Endpoint URL in the
 *      Discord developer portal.
 *   3. Register the slash commands once (see register-commands.js).
 */

import nacl from 'tweetnacl';
import { InstancesClient } from '@google-cloud/compute';

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const PROJECT = process.env.GCP_PROJECT;
const ZONE = process.env.GCE_ZONE || 'us-central1-a';
const INSTANCE = process.env.GCE_INSTANCE || 'nanoclaw-vm';
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean);

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 };

const compute = new InstancesClient();

/**
 * Verify the Ed25519 signature Discord puts on every interaction request.
 * Required — Discord rejects the endpoint URL otherwise.
 */
function verifySignature(req) {
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  const body = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body);
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + body),
      Buffer.from(signature, 'hex'),
      Buffer.from(PUBLIC_KEY, 'hex'),
    );
  } catch {
    return false;
  }
}

async function instanceStatus() {
  const [vm] = await compute.get({ project: PROJECT, zone: ZONE, instance: INSTANCE });
  return vm.status; // PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED | ...
}

async function startInstance() {
  const status = await instanceStatus();
  if (status === 'RUNNING' || status === 'STAGING' || status === 'PROVISIONING') {
    return { changed: false, status };
  }
  await compute.start({ project: PROJECT, zone: ZONE, instance: INSTANCE });
  return { changed: true, status: 'STARTING' };
}

async function stopInstance() {
  const status = await instanceStatus();
  if (status === 'TERMINATED' || status === 'STOPPING') {
    return { changed: false, status };
  }
  await compute.stop({ project: PROJECT, zone: ZONE, instance: INSTANCE });
  return { changed: true, status: 'STOPPING' };
}

function reply(text, ephemeral = true) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: text, flags: ephemeral ? 64 : 0 },
  };
}

export const discordInteraction = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  if (!verifySignature(req)) {
    res.status(401).send('invalid request signature');
    return;
  }

  const interaction = req.body;

  if (interaction.type === InteractionType.PING) {
    res.json({ type: InteractionResponseType.PONG });
    return;
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const userId =
      interaction.member?.user?.id ?? interaction.user?.id ?? '';
    if (ADMIN_USER_IDS.length && !ADMIN_USER_IDS.includes(userId)) {
      res.json(reply('権限がありません (admin only).'));
      return;
    }

    const name = interaction.data?.name;
    try {
      if (name === 'wake') {
        const { changed, status } = await startInstance();
        res.json(
          reply(
            changed
              ? 'nanoclaw VM を起動中. Discord に bot が現れるまで ~60-90 秒.'
              : `nanoclaw VM は既に ${status} 状態.`,
          ),
        );
        return;
      }
      if (name === 'sleep') {
        const { changed, status } = await stopInstance();
        res.json(
          reply(
            changed
              ? 'nanoclaw VM を停止中. 課金は ~30 秒以内に止まります.'
              : `nanoclaw VM は既に ${status} 状態.`,
          ),
        );
        return;
      }
      if (name === 'status') {
        const status = await instanceStatus();
        res.json(reply(`nanoclaw VM status: \`${status}\``));
        return;
      }
      res.json(reply(`未知のコマンド: ${name}`));
    } catch (err) {
      console.error(err);
      res.json(reply(`error: ${err.message ?? String(err)}`));
    }
    return;
  }

  res.status(400).send('unhandled interaction type');
};
