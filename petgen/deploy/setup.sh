#!/usr/bin/env bash
# One-time setup of the Desktop Sidekicks worker on a fresh Ubuntu 24.04 server. Safe to re-run.
#   curl -fsSL https://raw.githubusercontent.com/Aaronlawrencedesigns/test/main/petgen/deploy/setup.sh | sudo bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "== installing packages"
apt-get update -qq
apt-get install -y -qq git ffmpeg python3-venv >/dev/null
id sidekicks >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/sidekicks --shell /usr/sbin/nologin sidekicks
if ! swapon --show | grep -q .; then
  echo "== adding 4 GB swap (making a pet needs more memory than a small server has)"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "== getting the code"
if [ -d /opt/sidekicks/.git ]; then git -C /opt/sidekicks pull -q --ff-only; else git clone -q --depth 1 https://github.com/Aaronlawrencedesigns/test.git /opt/sidekicks; fi
echo "== installing Python libraries (a few minutes)"
[ -x /opt/sidekicks-venv/bin/python ] || python3 -m venv /opt/sidekicks-venv
/opt/sidekicks-venv/bin/pip install -q --upgrade pip
/opt/sidekicks-venv/bin/pip install -q -r /opt/sidekicks/petgen/deploy/requirements.txt
if [ ! -f /etc/sidekicks.env ]; then
  install -m 600 /opt/sidekicks/petgen/deploy/sidekicks.env.example /etc/sidekicks.env
fi
install -m 644 /opt/sidekicks/petgen/deploy/sidekicks-worker.service /etc/systemd/system/sidekicks-worker.service
cat > /usr/local/bin/sidekicks-requeue <<'SH'
#!/bin/sh
# usage: sudo sidekicks-requeue <order id>   (retry a failed order, or make a skipped test order)
set -a; . /etc/sidekicks.env; set +a
cd /opt/sidekicks && exec runuser -u sidekicks -- /opt/sidekicks-venv/bin/python -m petgen.worker requeue "$1"
SH
chmod 755 /usr/local/bin/sidekicks-requeue
systemctl daemon-reload
systemctl enable -q sidekicks-worker
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libvpx-vp9 && echo "== ffmpeg has VP9: ok"
echo
echo "Done. Next: add your keys with   sudo nano /etc/sidekicks.env"
echo "then start the worker with      sudo systemctl restart sidekicks-worker"
echo "and watch it with               journalctl -u sidekicks-worker -f"
