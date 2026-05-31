# nanoclaw on GCP — deploy walkthrough

This directory contains everything needed to run nanoclaw on Google Cloud
Compute Engine with **on-demand wake / idle auto-stop** semantics
(siseneg-style "起動するときだけお金がかかる" 構成).

For the design rationale and trade-offs vs Cloud Run / GKE, see
[`docs/gcp-deploy-options.md`](../docs/gcp-deploy-options.md).

---

## Architecture in one diagram

```
┌────────────────────────┐  /wake             ┌──────────────────────────┐
│  Discord client (you)  │ ─────────────────► │  Cloud Function          │
└────────────────────────┘  slash command     │  nanoclaw-wake           │
                                              │  (HTTPS, Gen2, Node 22)  │
                                              └────────┬─────────────────┘
                                                       │ compute.start
                                                       ▼
                                              ┌──────────────────────────┐
                                              │  Compute Engine          │
                                              │  nanoclaw-vm (e2-small)  │
                                              │  - startup-script.sh     │
                                              │    pulls secrets         │
                                              │    docker pull + run     │
                                              │  - nanoclaw container    │
                                              │    (Dockerfile)          │
                                              │  - idle-watchdog timer   │
                                              │    every 5m → stop if    │
                                              │    no VC for 15m         │
                                              └──────────────────────────┘
                                                       │
                                                       ▼ Discord WS + voice UDP
                                              ┌──────────────────────────┐
                                              │  Discord guild           │
                                              └──────────────────────────┘
```

---

## Files in this directory

| File | Purpose |
|---|---|
| `startup-script.sh` | VM boot: pull secrets, pull container image, install + start systemd service, install idle-watchdog timer |
| `shutdown-script.sh` | VM stop: gracefully `docker stop` so bot leaves VC cleanly |
| `idle-watchdog.sh` | runs every 5m via systemd timer; stops VM after `IDLE_STOP_MINUTES` of no VC activity |
| `wake-cloud-function/` | Cloud Function that receives Discord `/wake` `/sleep` `/status` interactions and calls `compute.start/stop` |

---

## Prerequisites

- GCP project with billing enabled (existing: `nanoclaw-bot-takum`)
- `gcloud` CLI installed locally and `gcloud auth login` done
- Discord application with bot token + public key (existing)
- Artifact Registry repo for the container image

---

## Step 1 — Create / verify the Artifact Registry repo

```bash
PROJECT=nanoclaw-bot-takum
REGION=us-central1

gcloud artifacts repositories create nanoclaw \
  --project="$PROJECT" --repository-format=docker --location="$REGION" \
  --description="nanoclaw container images" \
  || echo "repo already exists, continuing"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

## Step 2 — Build and push the container image

From the **repo root** (one level up from this directory):

```bash
PROJECT=nanoclaw-bot-takum
REGION=us-central1
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/nanoclaw/nanoclaw:latest"

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

This takes ~3-5 min on a decent connection. The image is multi-stage (~250 MB
final) and includes ffmpeg for `@discordjs/voice`.

## Step 3 — Store secrets in Secret Manager

```bash
gcloud services enable secretmanager.googleapis.com --project="$PROJECT"

# Repeat for every secret in .env.gcp.example. Example:
printf %s "$DISCORD_BOT_TOKEN_VALUE" | \
  gcloud secrets create DISCORD_BOT_TOKEN --project="$PROJECT" --data-file=-

printf %s "$OPENAI_API_KEY_VALUE" | \
  gcloud secrets create OPENAI_API_KEY --project="$PROJECT" --data-file=-
```

Updating later:

```bash
printf %s "$NEW_VALUE" | gcloud secrets versions add OPENAI_API_KEY --project="$PROJECT" --data-file=-
```

`startup-script.sh` always reads the latest version.

> **DO NOT** put real secret values in this repo. Even in `.env.gcp.example`.
> `.gitignore` already excludes `.env*` but the example file is committed —
> keep it as placeholders only.

## Step 4 — Create the VM service account

The VM needs to read Secret Manager and stop itself (idle watchdog):

```bash
SA=nanoclaw-vm-sa
gcloud iam service-accounts create "$SA" \
  --project="$PROJECT" \
  --display-name="nanoclaw VM runtime"

SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

# Read all secrets (project-wide; tighten per-secret if you want)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role=roles/secretmanager.secretAccessor

# Pull container images
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role=roles/artifactregistry.reader

# Stop self (idle-watchdog). Scope this to the single instance if possible.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role=roles/compute.instanceAdmin.v1
```

## Step 5 — Create the VM

```bash
ZONE=us-central1-a
INSTANCE=nanoclaw-vm

gcloud compute instances create "$INSTANCE" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --service-account="$SA_EMAIL" \
  --scopes=cloud-platform \
  --metadata=IDLE_STOP_MINUTES=15,REGION=$REGION,IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/nanoclaw/nanoclaw:latest" \
  --metadata-from-file=startup-script=gcp/startup-script.sh,shutdown-script=gcp/shutdown-script.sh
```

> **Note on machine type:** `e2-micro` works for STT/TTS via OpenAI API (the
> CPU stays mostly idle since heavy lifting is remote). If you ever move STT
> in-process (e.g. local whisper.cpp) you'll want `e2-small` or larger.

## Step 6 — Deploy the wake Cloud Function

```bash
# One-time: install deps locally and confirm the bundle is small
cd gcp/wake-cloud-function
npm install
cd -

# Public key from Discord developer portal → General Information → Public Key
printf %s "$DISCORD_PUBLIC_KEY" | \
  gcloud secrets create DISCORD_PUBLIC_KEY --project="$PROJECT" --data-file=-

gcloud functions deploy nanoclaw-wake \
  --project="$PROJECT" \
  --gen2 --region="$REGION" \
  --runtime=nodejs22 \
  --source=gcp/wake-cloud-function \
  --entry-point=discordInteraction \
  --trigger-http --allow-unauthenticated \
  --set-secrets=DISCORD_PUBLIC_KEY=DISCORD_PUBLIC_KEY:latest \
  --set-env-vars="GCP_PROJECT=${PROJECT},GCE_ZONE=${ZONE},GCE_INSTANCE=${INSTANCE},ADMIN_USER_IDS=${ADMIN_USER_IDS}" \
  --service-account="$SA_EMAIL"
```

Capture the function URL printed at the end and paste it into the Discord
developer portal → your bot → **Interactions Endpoint URL**, then save.
(Discord will ping-test it; if signature verification fails the save will be
rejected.)

## Step 7 — Register slash commands

Once, from a machine that has the bot token:

```bash
cd gcp/wake-cloud-function
DISCORD_BOT_TOKEN=... \
DISCORD_APPLICATION_ID=... \
DISCORD_GUILD_ID=...                # optional, for instant per-guild reg
  node register-commands.js
```

## Step 8 — Smoke test

In Discord:

1. `/status` → should reply `RUNNING` (since we just created the VM).
2. `/sleep` → reply "stopping", then `/status` after 30s → `TERMINATED`.
3. `/wake` → reply "starting", after ~60-90s the bot icon should turn green.
4. Join a VC, `/join-vc`, speak → bot should respond with synthesized voice.
5. Leave the VC and wait 15 min → idle-watchdog stops the VM automatically.

---

## Cost estimate

Assumes Tokyo region (`asia-northeast1`) pricing for `e2-small`:

| Scenario | Hours / month | VM cost | Notes |
|---|---|---|---|
| Always-on (24/7) | 730h | ~$13/mo | current `e2-micro` is in Always Free → $0 today |
| Idle-stop, 2h/day active use | 60h | ~$1/mo | + Cloud Function calls negligible |
| Idle-stop, 1h/day | 30h | ~$0.5/mo | |

Cloud Function `/wake` is well within the free tier (first 2M invocations/mo).
Secret Manager: first 6 active versions free, then $0.06/secret/mo.

Storage (20GB SSD): ~$3.4/mo regardless of VM uptime.

**Conclusion:** the on-demand setup costs ~$1-5/mo depending on disk choice,
versus $0/mo for the current always-on `e2-micro` (Always Free). The user
explicitly asked for on-demand semantics, so we accept the small cost in
exchange for not having a permanently-online bot in the guild.

---

## Operations cheatsheet

| Action | Command |
|---|---|
| Manual wake | `gcloud compute instances start nanoclaw-vm --zone=$ZONE --project=$PROJECT` |
| Manual sleep | `gcloud compute instances stop nanoclaw-vm --zone=$ZONE --project=$PROJECT` |
| Tail container logs | `gcloud compute ssh nanoclaw-vm --zone=$ZONE -- 'sudo journalctl -u nanoclaw -f'` |
| Tail startup log | `... 'sudo tail -f /var/log/nanoclaw-startup.log'` |
| Push new image | `docker build -t $IMAGE . && docker push $IMAGE` then `/sleep` + `/wake` to redeploy |
| Rotate a secret | `printf %s "$NEW" \| gcloud secrets versions add KEY --data-file=-` then `/sleep`+`/wake` |
| Disable auto-stop | `gcloud compute ssh nanoclaw-vm -- 'sudo systemctl disable --now nanoclaw-idle.timer'` |
