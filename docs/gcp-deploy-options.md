# GCP deployment — option comparison

The user's brief: "siseneg と同じような感じで、起動するときだけお金がかかる感じで GCP に置きたい."

Discord voice bots have a few quirks that constrain which GCP product fits:

- Persistent **WebSocket** to Discord gateway (idle but always-on)
- Persistent **UDP** for voice (`@discordjs/voice` uses Opus over UDP)
- Stateful per-user session in SQLite (`better-sqlite3`)
- ffmpeg dependency
- Cold-start cost matters because `/wake` is human-driven

## Options considered

### A. Compute Engine + idle auto-stop  *(chosen)*

```
[Discord /wake] → Cloud Function → compute.start
                                   ↓
                              GCE VM boots
                                   ↓
                              startup-script: pull image, start container
                                   ↓
                              Bot online (~60-90s after /wake)
                                   ↓
                              idle-watchdog timer: stop after 15m no VC
```

**Pros**

- Discord WS + voice UDP work natively, no platform restrictions
- Container image is the same artifact as local dev — easy to debug
- Idle stop is a single `gcloud compute instances stop`; trivial to verify cost
- SQLite on a persistent disk survives stop/start cycles
- Tailscale SSH works fine for ad-hoc debugging

**Cons**

- ~60-90s cold start (image pull + node boot + discord login)
- User has to think about wake/sleep, although /wake is a single slash command
- Storage charged 24/7 even when VM is stopped (~$3.4/mo for 20GB SSD)

**Cost** (Tokyo `asia-northeast1`, e2-small, 2h/day active use): ~$4/mo total.

### B. Cloud Run + CPU always-on, min-instances=1

**Pros**

- "Real" serverless feel; no VM lifecycle to manage
- Built-in HTTPS, autoscaling, easy revisions

**Cons**

- **Voice UDP is not supported** on Cloud Run. Cloud Run only exposes HTTP(S)
  ingress; outbound UDP from the container is allowed, but Discord voice
  requires the container to accept inbound voice RTP after the WS handshake,
  which works through NAT only on long-lived instances.
- Min-instances=1 with CPU-always-on **defeats the cost goal** — billed
  continuously at ~$15-30/mo for the smallest CPU+memory combo that fits
  nanoclaw + ffmpeg.
- `better-sqlite3` on Cloud Run requires a Cloud Storage FUSE mount or
  migration to Firestore — both add complexity.

**Verdict:** rejected. Doesn't actually save money in the configuration
required by Discord voice, and adds storage migration work.

### C. GKE Autopilot

**Pros**

- Kubernetes-native idle scale-down via KEDA / cluster-autoscaler

**Cons**

- Autopilot has a flat **$72/mo control-plane charge** plus pod CPU/memory.
  Massively over budget for a single-pod hobby bot.
- Operational complexity (Helm chart, Workload Identity, Ingress) is
  unjustified at this scale.

**Verdict:** rejected. Right answer at 10+ workloads, wrong answer for one.

### D. Cloud Run *Jobs* (one-shot, triggered)

Considered for completeness. Cloud Run Jobs have a 24h max execution time,
which kills the persistent Discord WS use case. Rejected.

---

## Decision: **Option A**

Captured in:

- [`gcp/startup-script.sh`](../gcp/startup-script.sh)
- [`gcp/shutdown-script.sh`](../gcp/shutdown-script.sh)
- [`gcp/idle-watchdog.sh`](../gcp/idle-watchdog.sh)
- [`gcp/wake-cloud-function/index.js`](../gcp/wake-cloud-function/index.js)
- [`Dockerfile`](../Dockerfile)
- Deploy walkthrough: [`gcp/README.md`](../gcp/README.md)

## Open questions for follow-up

1. **Heartbeat wiring** — `idle-watchdog.sh` reads
   `/var/lib/nanoclaw/data/voice-active.timestamp`. The nanoclaw process
   needs to `touch` this file on every voice receive/send tick. To be added
   in a tiny follow-up commit to `src/voice/stt.ts` and `src/voice/player.ts`.
   Until then, the watchdog falls back to "stop 15m after boot regardless,"
   which is safe but coarse.

2. **Tokyo vs us-central1** — current VM is `us-central1` (Always Free).
   Moving to `asia-northeast1` for latency costs ~$4/mo but cuts STT/TTS
   round-trip noticeably for JP users. Recommend after one week of
   on-demand testing.

3. **Container Registry vs Artifact Registry** — picked Artifact Registry
   (Container Registry is deprecated). No action.

4. **Spot VM** — would cut cost ~70% but adds preemption risk mid-conversation.
   Probably worth it once the bot is stable; deferred.
