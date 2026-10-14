#!/usr/bin/env bash
set -Eeuo pipefail

sudo mkdir -p /etc/systemd/resolved.conf.d /etc/docker

sudo tee /etc/systemd/resolved.conf.d/cloudflare.conf >/dev/null <<'EOF'
[Resolve]
DNS=1.1.1.1
FallbackDNS=8.8.8.8
Domains=~.
EOF

if [[ -s /etc/docker/daemon.json ]]; then
  tmp="$(mktemp)"
  sudo jq '.dns = ["1.1.1.1", "8.8.8.8"]' /etc/docker/daemon.json >"$tmp"
  sudo install -m 644 "$tmp" /etc/docker/daemon.json
  rm -f "$tmp"
else
  echo '{"dns":["1.1.1.1","8.8.8.8"]}' | sudo tee /etc/docker/daemon.json >/dev/null
fi

sudo systemctl restart systemd-resolved
sudo systemctl restart docker

# Override Azure link DNS so host lookups use 1.1.1.1 first.
while read -r iface; do
  [[ -n "$iface" ]] || continue
  sudo resolvectl dns "$iface" 1.1.1.1 8.8.8.8 || true
  sudo resolvectl domain "$iface" '~.' || true
done < <(ls /sys/class/net | grep -vE '^(lo|docker|veth|br-|tun|tap)')

echo "Host resolv.conf:"
cat /etc/resolv.conf
echo "systemd-resolved DNS:"
resolvectl status | sed -n '1,60p' || true
echo "Docker daemon.json:"
cat /etc/docker/daemon.json
