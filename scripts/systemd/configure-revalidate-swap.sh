#!/usr/bin/env bash
set -euo pipefail

swap_path="${REVALIDATE_SWAP_PATH:-/swapfile}"
swap_size="${REVALIDATE_SWAP_SIZE:-4G}"

if ! swapon --noheadings --show=NAME | grep -Fxq "$swap_path"; then
  if [[ ! -f "$swap_path" ]]; then
    fallocate -l "$swap_size" "$swap_path"
    chmod 600 "$swap_path"
    mkswap "$swap_path"
  fi
  swapon "$swap_path"
fi

if ! grep -Eq "^[[:space:]]*${swap_path//\//\\/}[[:space:]]" /etc/fstab; then
  cp -a /etc/fstab "/etc/fstab.codex-pre-revalidate-swap"
  printf '%s none swap sw 0 0\n' "$swap_path" >>/etc/fstab
fi

mkdir -p /etc/systemd/system/giorgio-revalidate.service.d
cat >/etc/systemd/system/giorgio-revalidate.service.d/20-memory-safety.conf <<'EOF'
[Service]
MemorySwapMax=4G
Environment=REVALIDATE_WORKER_HEAP_MB=1536
EOF
systemctl daemon-reload

swapon --show
systemctl show giorgio-revalidate -p MemoryMax -p MemorySwapMax --no-pager
