#!/bin/bash
set -euo pipefail
echo "=== UFW ==="
ufw status verbose || true
echo "=== IPTABLES ==="
iptables -L INPUT -n | head -30 || true
echo "=== LOCAL HEALTH ==="
curl -sf http://127.0.0.1:8001/health; echo
echo "=== LISTEN ==="
ss -lntp | grep -E '8001|80|443' || true
# Ensure UFW allows and is not blocking if active
ufw allow OpenSSH || true
ufw allow 8001/tcp || true
ufw allow 80/tcp || true
ufw --force enable || true
ufw status
# Also nginx on :80 as fallback for cloud firewalls that only allow 80
apt-get install -y -qq nginx >/dev/null
cat >/etc/nginx/sites-available/mirax-api <<'EOF'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 600s;
    proxy_connect_timeout 60s;
  }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/mirax-api /etc/nginx/sites-enabled/mirax-api
nginx -t && systemctl restart nginx && systemctl enable nginx
echo NGINX_OK
curl -sf http://127.0.0.1/health; echo
