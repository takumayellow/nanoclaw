#!/bin/bash
# =====================================================================
# nanoclaw — idle watchdog
#
# Runs every 5 min via nanoclaw-idle.timer. If no Discord voice
# connection has been active for IDLE_STOP_MINUTES (default 15),
# the VM stops itself. The user re-wakes it via:
#   1. Discord /wake slash command (Cloud Function — see wake-cloud-function/)
#   2. `gcloud compute instances start nanoclaw-vm`
#
# Activity signal: the nanoclaw container writes a heartbeat file
# /var/lib/nanoclaw/data/voice-active.timestamp whenever it joins or
# leaves a VC (see src/voice/* — heartbeat hook to be added in
# follow-up commit; see HANDOFF-gcp-deploy.md item "wire heartbeat").
#
# Safety: if the heartbeat file is missing (e.g. first boot), we still
# wait IDLE_STOP_MINUTES from boot before stopping, so the user has
# time to /join-vc after waking the VM.
# =====================================================================
set -uo pipefail

ENV_FILE=/etc/nanoclaw/.env
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

IDLE_MIN="${IDLE_STOP_MINUTES:-15}"
HEARTBEAT=/var/lib/nanoclaw/data/voice-active.timestamp
NOW=$(date +%s)
BOOT=$(stat -c %Y /proc/1 2>/dev/null || echo "$NOW")

if [[ -f "$HEARTBEAT" ]]; then
  LAST=$(stat -c %Y "$HEARTBEAT")
else
  # No activity yet — use boot time as the reference.
  LAST="$BOOT"
fi

AGE_SEC=$(( NOW - LAST ))
THRESH_SEC=$(( IDLE_MIN * 60 ))

logger -t nanoclaw-idle "age=${AGE_SEC}s threshold=${THRESH_SEC}s heartbeat=$([[ -f $HEARTBEAT ]] && echo yes || echo no)"

if (( AGE_SEC < THRESH_SEC )); then
  exit 0
fi

# Don't shut down if any user is currently SSH'd in (active dev session).
if who | grep -qE '\spts/'; then
  logger -t nanoclaw-idle "active SSH session — skipping auto-stop"
  exit 0
fi

logger -t nanoclaw-idle "idle for ${AGE_SEC}s (>= ${THRESH_SEC}s) — stopping VM"

# Best-effort: tell GCE to stop us. The VM-attached service account needs
# the role `roles/compute.instanceAdmin.v1` scoped to this instance only.
ZONE=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}')
NAME=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/name)
PROJECT=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/project/project-id)

gcloud compute instances stop "$NAME" \
  --zone="$ZONE" --project="$PROJECT" --quiet \
  || logger -t nanoclaw-idle "gcloud stop failed (will retry next tick)"
