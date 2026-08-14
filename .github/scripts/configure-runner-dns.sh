#!/usr/bin/env bash
set -Eeuo pipefail

sudo mkdir -p /etc/systemd/resolved.conf.d /etc/docker

sudo tee /etc/systemd/resolved.conf.d/cloudflare.conf >/dev/null <<'EOF'
[Resolve]
DNS=1.1.1.1 1.0.0.1
FallbackDNS=8.8.8.8 8.8.4.4
Domains=~.
EOF

if [[ -s /etc/docker/daemon.json ]]; then
  tmp="$(mktemp)"
  sudo jq '.dns = ["1.1.1.1", "1.0.0.1"]' /etc/docker/daemon.json >"$tmp"
  sudo install -m 644 "$tmp" /etc/docker/daemon.json
  rm -f "$tmp"
else
  echo '{"dns":["1.1.1.1","1.0.0.1"]}' | sudo tee /etc/docker/daemon.json >/dev/null
fi

sudo systemctl restart systemd-resolved
sudo systemctl restart docker

echo "Host resolv.conf:"
cat /etc/resolv.conf
echo "systemd-resolved DNS:"
resolvectl status | sed -n '1,40p' || true
echo "Docker DNS:"
docker info --format '{{json .DNS}}'
