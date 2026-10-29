# f1.home.arpa — F1 race weekend + live timing

A small container that shows:

- the next race weekend, every session in your local time, with a countdown
- during sessions: track status (flag bar + pill), positions, gap/interval, last/best lap,
  sector times (purple / green / yellow), tyre compound + tyre age, pit stops, race control
- a track map with live car positions (needs your F1 TV token — see step 5)
- a broadcast-delay slider so the data matches what you see on F1 TV

It connects to F1's live-timing feed only from 45 min before a session until ~90 min after,
and keeps the last session's data so you can look at results afterwards.

## 1. Copy it to the homelab box

From the Mac:

    scp f1live.tar.gz <you>@192.168.1.250:~

On the box:

    sudo mkdir -p /opt/f1live && sudo tar -xzf ~/f1live.tar.gz -C /opt/f1live --strip-components=1
    sudo mkdir -p /opt/f1live/data && sudo chown 1000:1000 /opt/f1live/data
    cd /opt/f1live && sudo docker compose up -d --build

Check it: `curl -s localhost:3080/healthz` → `{"ok":true,...}`

Want to see it moving before a race weekend? Set `DEMO=1` in docker-compose.yml,
`sudo docker compose up -d`, look, then set it back to `0`.

## 2. Pi-hole: add the name

Pi-hole admin → **Local DNS → DNS Records** (v6: Settings → Local DNS Records):
domain `f1.home.arpa`, IP `192.168.1.250`. (If your other names are CNAMEs to the box, do the same here.)

## 3. Caddy: HTTPS for the name

Add to the Caddyfile next to your other `.home.arpa` sites:

    f1.home.arpa {
        tls internal
        reverse_proxy 192.168.1.250:3080
    }

Then `sudo systemctl reload caddy` (or `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`
if Caddy runs in a container). The certificate is trusted the same way as your other local names.

## 4. Homepage tile (optional)

In `services.yaml`:

    - F1:
        href: https://f1.home.arpa
        description: Next race + live timing
        icon: si-f1
        siteMonitor: http://192.168.1.250:3080/healthz

Uptime Kuma: an HTTP monitor on `http://192.168.1.250:3080/healthz` works too.

## 5. F1 TV token (for car positions on the map)

Since 2025 F1 only sends car positions to F1 TV subscribers. Everything else works without it.

1. On the Mac, sign in at formula1.com (your F1 TV account).
2. Open developer tools → Storage/Application → Cookies → `https://www.formula1.com`.
3. Copy the value of the `login-session` cookie.
4. On f1.home.arpa, open ⚙ settings, paste it, Save.

The page pulls the `subscriptionToken` out of it and stores it only in `/opt/f1live/data`.
Settings shows when it expires; paste a fresh one when it does (the page falls back to
running without positions if F1 rejects it).

## Updating

Your monthly script's `docker compose pull` won't touch this (it's built locally).
To pick up the Node base image updates: `cd /opt/f1live && sudo docker compose build --pull && sudo docker compose up -d`.

## Notes

- Calendar: api.jolpi.ca (Ergast-compatible). Track outlines: MultiViewer's public circuit API.
  Live data: livetiming.formula1.com (unofficial, can change without notice).
- Data lives in `./data`: cached calendar and track outlines, the last session, the token.
