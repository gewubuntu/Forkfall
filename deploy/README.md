# Running Forkfall on a server

One server runs everything: the referee (game server, API, live WebSocket, card metadata) serves the web app too, and
[Caddy](https://caddyserver.com) sits in front with automatic HTTPS. Tested on a Hetzner Cloud server with Ubuntu 24.04;
any Linux box with Docker works.

| File | What it does |
| --- | --- |
| `Dockerfile` | Builds the web app and runs the referee as a single Node process (graceful shutdown on `SIGTERM`) |
| `compose.yaml` | Referee + Caddy, one data volume, log rotation, health check |
| `Caddyfile` | HTTPS for your domain, security headers, reverse proxy (WebSockets included) |
| `.env.example` | Settings and secrets template: copy to `.env` on the server |
| `setup-server.sh` | One-time hardening of a fresh Ubuntu server |
| `backup.sh` | Nightly backup of the data volume |

## 1. Create the server

Hetzner Cloud console → *Add Server*:
- **Location:** Falkenstein or Nuremberg.
- **Image:** Ubuntu 24.04.
- **Type:** 4 vCPU / 8 GB (shared vCPU is fine). This leaves room for other projects; Forkfall alone uses about 150 MB.
- **SSH key:** add yours. Don't use a root password.
- **Backups:** on (+20%). These are Hetzner's own daily snapshots, a second layer next to `backup.sh`.

Optional: a Hetzner *Firewall* allowing only 22, 80 and 443. The setup script also configures `ufw` on the server.

## 2. Point your domain at it

Create DNS records for the name players will use, e.g. `play.example.com`:
- **A** → the server's IPv4
- **AAAA** → its IPv6

Caddy can only get a certificate once this resolves.

## 3. Harden the server (once)

```bash
scp deploy/setup-server.sh root@<server-ip>:
ssh root@<server-ip> 'bash setup-server.sh forkfall'
```

The script:
- installs Docker, `ufw` (only SSH, HTTP and HTTPS open), `fail2ban`, automatic security updates and 2 GB of swap;
- creates the `forkfall` user with your SSH key;
- turns off SSH password login.

Check that `ssh forkfall@<server-ip>` works, then you can also turn off root login (the script prints how).

## 4. Configure

```bash
ssh forkfall@<server-ip>
git clone https://github.com/gewubuntu/Forkfall.git && cd Forkfall/deploy
cp .env.example .env && chmod 600 .env
nano .env
```

| Setting | Value |
| --- | --- |
| `DOMAIN` | The name from step 2 |
| `ACME_EMAIL` | Your e-mail address |
| `RPC_URL` | A dedicated Base Sepolia RPC |
| `HOUSE_PRIVATE_KEY` | The referee key (testnet only) |
| `VITE_BASE_SEPOLIA_RPC_URL` | The RPC players' browsers use |
| `VITE_WALLETCONNECT_PROJECT_ID` | Your WalletConnect project id |

The contracts must be deployed first: `pnpm deploy:base-sepolia` (see the main README, *Deploying to Base Sepolia*), with `contracts/deployments/84532.json` committed. Set `METADATA_BASE=https://<DOMAIN>/metadata` for that deploy so card metadata is served from this server.

Before the contracts exist, `OFFCHAIN=1` runs the game without chain checks. That's enough to try the setup, but results can't settle.

## 5. Start

```bash
docker compose up -d --build
docker compose ps               # referee: healthy
docker compose logs -f referee  # the startup summary; Ctrl-C to stop following
```

Open `https://<DOMAIN>`. The first start takes a few minutes, because it builds the image and fetches the certificate.

## Updating

```bash
cd ~/Forkfall && git pull && cd deploy && docker compose up -d --build
```

What happens during an update:
- The old referee gets `SIGTERM`.
- It finishes requests in flight, saves state and exits.
- The new one resumes every running match, and downtime doesn't count against anyone's turn timer.
- Players keep their page open and see "Reconnecting to the referee…" for a few seconds; nobody has to sign in again.

## Backups

```bash
crontab -e
# add:
15 3 * * * /home/forkfall/Forkfall/deploy/backup.sh >> /home/forkfall/backup.log 2>&1
```

This keeps the last 14 archives in `~/backups/forkfall`. Copy them off the server too (e.g. `rclone` or `restic` to object storage).

The referee key is **not** in the backups: it only lives in `deploy/.env`. Keep a copy of that file somewhere safe and offline.

To restore an archive into a fresh volume:

```bash
docker compose down
docker run --rm -v forkfall_forkfall-data:/data -v ~/backups/forkfall:/b alpine:3 sh -c 'rm -rf /data/* && tar xzf /b/<archive>.tgz -C /data'
docker compose up -d
```

## Day to day

| Task | Command |
| --- | --- |
| Logs | `docker compose logs -f referee` (rotated: 5 × 10 MB) |
| Restart | `docker compose restart referee` (running matches resume) |
| Stop | `docker compose down` (data and certificates stay in their volumes) |
| Shell in the container | `docker compose exec referee sh` |
| Publish season rewards | `docker compose exec referee pnpm rewards:publish` (with the variables the main README lists) |

**Watch the referee key's ETH balance.** Settlements, quest payouts and league starts all spend gas from it.
