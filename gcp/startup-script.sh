#!/bin/bash
# =====================================================================
# nanoclaw — Compute Engine VM startup script (idempotent)
#
# Runs as root every time the VM boots. Pulls latest container image from
# Artifact Registry, fetches secrets from Secret Manager, writes them
# to /etc/nanoclaw/.env, and starts the systemd-managed container.
#
# Attach via:
#   gcloud compute instances create nanoclaw-vm \
#     --metadata-from-file=startup-script=gcp/startup-script.sh
#
# Or for an existing VM:
#   gcloud compute instances add-metadata nanoclaw-vm \
#     --metadata-from-file=startup-script=gcp/startup-script.sh
# =====================================================================
set -euo pipefail

LOG=/var/log/nanoclaw-startup.log
exec > >(tee -a "$LOG") 2>&1
echo "=== nanoclaw startup: $(date -Is) ==="

# -- config (override via instance metadata: PROJECT_ID, REGION, IMAGE, etc.) --
PROJECT_ID="$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/project/project-id || echo nanoclaw-bot-takum)"
REGION="$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/REGION 2>/dev/null || echo us-central1)"
IMAGE="$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/IMAGE 2>/dev/null \
  || echo ${REGION}-docker.pkg.dev/${PROJECT_ID}/nanoclaw/nanoclaw:latest)"

ENV_DIR=/etc/nanoclaw
ENV_FILE="${ENV_DIR}/.env"
DATA_DIR=/var/lib/nanoclaw

mkdir -p "$ENV_DIR" "$DATA_DIR"/{data,store,logs,groups}

# -- ensure docker + gcloud CLI are present (Container-Optimized OS already has docker) --
if ! command -v docker >/dev/null 2>&1; then
  echo "docker missing — installing"
  apt-get update
  apt-get install -y --no-install-recommends docker.io
  systemctl enable --now docker
fi

# -- authenticate docker to Artifact Registry using VM service account --
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet || true

# -- pull secrets from Secret Manager into /etc/nanoclaw/.env --
# Each secret is named identically to its env-var key (e.g. DISCORD_BOT_TOKEN).
# Latest version is always used. If a secret is missing, that var is skipped.
SECRETS=(
  DISCORD_BOT_TOKEN
  DISCORD_APPLICATION_ID
  DISCORD_GUILD_IDS
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  GH_TOKEN
  ADMIN_USER_IDS
  TAILSCALE_AUTH_KEY
)

: > "${ENV_FILE}.new"
for key in "${SECRETS[@]}"; do
  value=$(gcloud secrets versions access latest \
    --secret="$key" --project="$PROJECT_ID" 2>/dev/null || true)
  if [[ -n "$value" ]]; then
    # Escape backslashes and dollar signs so docker --env-file is literal.
    printf '%s=%s\n' "$key" "$value" >> "${ENV_FILE}.new"
  else
    echo "WARN: secret $key not found in Secret Manager; skipping" >&2
  fi
done
# Static (non-secret) tunables
{
  echo "NODE_ENV=production"
  echo "IDLE_STOP_MINUTES=${IDLE_STOP_MINUTES:-15}"
} >> "${ENV_FILE}.new"

chmod 600 "${ENV_FILE}.new"
mv "${ENV_FILE}.new" "$ENV_FILE"

# -- optional: bring up Tailscale so we can SSH without a public IP --
if grep -q '^TAILSCALE_AUTH_KEY=..' "$ENV_FILE" && ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if command -v tailscale >/dev/null 2>&1; then
  TS_KEY=$(grep -E '^TAILSCALE_AUTH_KEY=' "$ENV_FILE" | cut -d= -f2-)
  if [[ -n "$TS_KEY" ]]; then
    tailscale up --authkey="$TS_KEY" --ssh --hostname=nanoclaw-vm --accept-routes || true
  fi
fi

# -- pull the latest image --
docker pull "$IMAGE" || {
  echo "ERROR: failed to pull $IMAGE" >&2
  exit 1
}

# -- install systemd unit if not present --
if [[ ! -f /etc/systemd/system/nanoclaw.service ]]; then
  cat > /etc/systemd/system/nanoclaw.service <<UNIT
[Unit]
Description=nanoclaw Discord bot (container)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
ExecStartPre=-/usr/bin/docker rm -f nanoclaw
ExecStart=/usr/bin/docker run --rm --name nanoclaw \\
  --env-file ${ENV_FILE} \\
  -v ${DATA_DIR}/data:/app/data \\
  -v ${DATA_DIR}/store:/app/store \\
  -v ${DATA_DIR}/logs:/app/logs \\
  -v ${DATA_DIR}/groups:/app/groups \\
  ${IMAGE}
ExecStop=/usr/bin/docker stop -t 25 nanoclaw

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi

# -- install idle-watchdog + wake-on-demand pieces --
install -m 0755 /opt/nanoclaw/idle-watchdog.sh /usr/local/bin/nanoclaw-idle-watchdog.sh 2>/dev/null || true

if [[ ! -f /etc/systemd/system/nanoclaw-idle.timer ]]; then
  cat > /etc/systemd/system/nanoclaw-idle.service <<'UNIT'
[Unit]
Description=nanoclaw idle watchdog (auto-stop VM when no VC activity)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/nanoclaw-idle-watchdog.sh
UNIT

  cat > /etc/systemd/system/nanoclaw-idle.timer <<'UNIT'
[Unit]
Description=Run nanoclaw idle watchdog every 5 min

[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now nanoclaw-idle.timer
fi

systemctl enable --now nanoclaw.service

echo "=== nanoclaw startup complete: $(date -Is) ==="
