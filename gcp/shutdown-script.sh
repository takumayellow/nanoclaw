#!/bin/bash
# =====================================================================
# nanoclaw — Compute Engine VM shutdown script
#
# GCP invokes this on `instances stop` (and on preemption for spot VMs)
# with ~30s budget. We use it to politely leave any active Discord
# voice channel so the bot does not appear as a ghost member.
#
# Attach via:
#   gcloud compute instances add-metadata nanoclaw-vm \
#     --metadata-from-file=shutdown-script=gcp/shutdown-script.sh
# =====================================================================
set -uo pipefail

LOG=/var/log/nanoclaw-shutdown.log
exec > >(tee -a "$LOG") 2>&1
echo "=== nanoclaw shutdown: $(date -Is) ==="

# Stop the systemd service — its ExecStop runs `docker stop -t 25 nanoclaw`,
# which sends SIGTERM. tini forwards it to node, which triggers our
# graceful-shutdown handler (Discord client.destroy() + DB close).
systemctl stop nanoclaw.service || true

# Flush logs in case journald is buffering
sync
journalctl --flush || true

echo "=== nanoclaw shutdown complete: $(date -Is) ==="
