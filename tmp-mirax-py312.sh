#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Prefer 3.12/3.11 — 3.14 breaks greenlet/playwright wheels
apt-get install -y -qq software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null || true
apt-get update -qq
apt-get install -y -qq python3.12 python3.12-venv python3.12-dev 2>/dev/null \
  || apt-get install -y -qq python3.11 python3.11-venv python3.11-dev

PY=""
command -v python3.12 >/dev/null && PY=python3.12
[[ -z "$PY" ]] && command -v python3.11 >/dev/null && PY=python3.11
echo "USING $PY"
$PY --version

rm -rf /home/worker/app/venv
sudo -u worker $PY -m venv /home/worker/app/venv
sudo -u worker /home/worker/app/venv/bin/pip install -U pip wheel setuptools -q
echo VENV_OK
/home/worker/app/venv/bin/python --version
