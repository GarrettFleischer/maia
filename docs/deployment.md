# Production Deployment

This guide covers deploying Maia behind a reverse proxy with TLS and running it as a system service.

## Overview

- Maia's gateway speaks **HTTP only**. For production, put it behind a reverse proxy (Caddy or nginx) that terminates TLS.
- Bind Maia to `127.0.0.1` when using a reverse proxy so it is not exposed on the network.
- Set `MAIA_AUTH_TOKEN` and `MAIA_MASTER_KEY` in the environment; never commit them.

## Reverse Proxy with TLS

### Caddy

Caddy handles TLS automatically (e.g. Let's Encrypt). Run Maia on `127.0.0.1:3000` and proxy to it.

**Caddyfile** (e.g. `/etc/caddy/Caddyfile`):

```caddyfile
maia.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Then:

```bash
sudo systemctl reload caddy
```

Ensure `gateway.host` is `127.0.0.1` and `gateway.cors.origins` includes `https://maia.example.com`.

### Nginx

Example server block with TLS (certificates from certbot or your CA):

```nginx
server {
    listen 443 ssl http2;
    server_name maia.example.com;

    ssl_certificate     /etc/letsencrypt/live/maia.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/maia.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload nginx after changes:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Again, set Maia's `gateway.host` to `127.0.0.1` and add your frontend origin to `gateway.cors.origins`.

## Systemd Service

Run Maia as a system service with automatic restarts.

1. Create a dedicated user (optional but recommended):

   ```bash
   sudo useradd -r -s /bin/false maia
   sudo mkdir -p /var/lib/maia/data /var/lib/maia/workspace
   sudo chown -R maia:maia /var/lib/maia
   ```

2. Place config and environment:

   - Config: `/var/lib/maia/maia.config.json` (or set `MAIA_CONFIG`).
   - Secrets: use a systemd environment file (e.g. `/etc/maia/env`) with `MAIA_AUTH_TOKEN` and `MAIA_MASTER_KEY`, and `chmod 600 /etc/maia/env`.

3. Create a systemd unit **/etc/systemd/system/maia.service**:

```ini
[Unit]
Description=Maia AI Assistant
After=network.target

[Service]
Type=simple
User=maia
Group=maia
WorkingDirectory=/var/lib/maia

# Load secrets and config path
EnvironmentFile=-/etc/maia/env
Environment=MAIA_CONFIG=/var/lib/maia/maia.config.json

# Use the compiled binary (recommended): run "bun run compile" and install ./maia to /opt/maia/
ExecStart=/opt/maia/maia start
# Or from source:
# ExecStart=/usr/bin/bun run /opt/maia/src/index.ts start
Restart=on-failure
RestartSec=10

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/maia

[Install]
WantedBy=multi-user.target
```

4. If you installed Maia elsewhere, set `WorkingDirectory` and `ExecStart` to that path (e.g. `/opt/maia` with app in `/opt/maia`).

5. Enable and start:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable maia
   sudo systemctl start maia
   sudo systemctl status maia
   ```

## Docker

Use the included Dockerfile for a consistent image.

**Build:**

```bash
docker build -t maia .
```

**Run** (replace secrets and paths as needed):

```bash
docker run -d \
  --name maia \
  -p 3000:3000 \
  -e MAIA_AUTH_TOKEN="your-strong-token-at-least-16-chars" \
  -e MAIA_MASTER_KEY="your-master-passphrase" \
  -v maia-data:/app/.maia \
  maia
```

Persistent data (config, workspace, credentials, DB) lives in the `maia-data` volume. Ensure `/app/.maia` contains `maia.config.json` and that the config references `${MAIA_AUTH_TOKEN}` and uses a workspace path under `/app/.maia` (e.g. `~/.maia/workspace` which expands to `/app/.maia/workspace` in the container).

For production, run the container behind a reverse proxy and do not publish port 3000 to the host if the proxy runs on the same machine.

## Checklist

- [ ] `MAIA_AUTH_TOKEN` and `MAIA_MASTER_KEY` set and not committed
- [ ] `gateway.host` set to `127.0.0.1` when using a reverse proxy
- [ ] `gateway.cors.origins` set to your frontend origin(s)
- [ ] TLS terminated at reverse proxy (Caddy or nginx)
- [ ] Process manager (systemd or Docker) for restarts
- [ ] `MAIA_LOG_LEVEL=info` in production
