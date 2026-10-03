#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (Hetzner Cloud or similar). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/setup-server.sh | bash -s -- <user>
# or copy it over and run:  bash setup-server.sh forkfall
# It installs Docker, a firewall, automatic security updates and swap, and creates a deploy user that logs in with
# the same SSH keys as root. Safe to run twice.
set -euo pipefail
USER_NAME="${1:-forkfall}"
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

echo "==> Packages and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Docker (official repository)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> Deploy user: $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$USER_NAME"
fi
usermod -aG docker "$USER_NAME"
if [ -f /root/.ssh/authorized_keys ]; then
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
  install -m 600 -o "$USER_NAME" -g "$USER_NAME" /root/.ssh/authorized_keys "/home/$USER_NAME/.ssh/authorized_keys"
fi

echo "==> SSH: keys only"
if [ -s /root/.ssh/authorized_keys ]; then
  cat > /etc/ssh/sshd_config.d/10-forkfall.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
CONF
  systemctl reload ssh || systemctl reload sshd
else
  echo "   no SSH key for root found: leaving password login on. Add a key, then run this again."
fi

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
# Docker publishes ports past ufw; that's fine here: compose only publishes 80/443 (Caddy).

echo "==> Swap (2 GB): a memory spike slows down instead of killing a process"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo
echo "Done. Next, log in as the deploy user:  ssh $USER_NAME@<server>"
echo "When that works, you can turn off root login: set 'PermitRootLogin no' in /etc/ssh/sshd_config.d/10-forkfall.conf"
