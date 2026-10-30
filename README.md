# F1 Live

A self-hosted Formula 1 dashboard for your home network. It shows the next race weekend in
your own time zone and, while a session is running, live timing with a track map: like a
second screen next to the broadcast.

> Unofficial and not affiliated with Formula 1. It reads F1's public live-timing feed, which
> can change without notice. Car positions need your own F1 TV subscription.

## What it shows

**Between race weekends**
- The next race weekend with every session in your local time, plus a countdown

**During a session**
- Track status (green, yellow, safety car, VSC, red), shown as a colour bar across the top
- Lap count and a timing tower: positions, gap or interval (tap to switch), last lap
- Sector times, coloured for personal and overall bests
- Tyre compound, tyre age and pit stops
- Race control messages
- A track map with live car positions in team colours, with yellow-flagged sectors highlighted
- A broadcast-delay slider so the page matches your stream (TV and streaming usually run
  20–45 seconds behind the live data)

The dashboard only connects to F1's feed from 45 minutes before a session until about 90
minutes after it. It keeps the last session's data, so you can look at results afterwards.

## Requirements

- A machine running Docker with the Compose plugin
- Optional: an F1 TV subscription, for car positions on the track map (F1 only sends those to
  subscribers; everything else works without it)
- Optional: a local DNS name and a reverse proxy for HTTPS

## Install

    git clone <this-repo-url> f1live
    cd f1live
    mkdir -p data && sudo chown 1000:1000 data
    sudo docker compose up -d --build

Open `http://<server-ip>:3080`. To check that it's running:

    curl -s localhost:3080/healthz      # → {"ok":true,...}

### Try it without a race

Set `DEMO=1` in `docker-compose.yml` and run `sudo docker compose up -d`. The page then plays
a simulated race with pit stops and yellow flags. Set it back to `0` afterwards, and delete
`data/last-session.json` so the fake race doesn't linger as the last session.

### A nicer address and HTTPS (optional)

Point a local DNS name at the server (in Pi-hole, your router or a hosts file), then put a
reverse proxy in front. With Caddy:

    f1.example.home.arpa {
        tls internal
        reverse_proxy <server-ip>:3080
    }

Any reverse proxy works. Make sure it doesn't buffer `/api/stream`, which is a live
server-sent events stream.

## F1 TV token (car positions)

There are two ways to give the dashboard your token:

1. **Automatically (recommended):** the `login/` folder holds a small companion container
   that signs in to formula1.com with your account, fetches the token and renews it before it
   expires. See [login/README.md](login/README.md).
2. **By hand:** sign in at formula1.com in a desktop browser, open developer tools →
   Application/Storage → Cookies → formula1.com, and copy the value of the `login-session`
   cookie. Paste it in the dashboard under ⚙ settings and click Save. Tokens last a few days,
   so you'll need to repeat this before each race weekend.

Settings shows where the current token came from and when it expires. The token is stored
only in `data/` on your server. If F1 rejects it, the dashboard keeps running without car
positions.

## Configuration

Set these under `environment:` in `docker-compose.yml`, then run `sudo docker compose up -d`
(a plain `docker restart` doesn't pick up changes).

| Variable | Default | What it does |
| --- | --- | --- |
| `DEMO` | `0` | `1` plays a simulated race instead of connecting to F1 |
| `LIVE_ALWAYS` | `0` | `1` stays connected to F1 all the time, not just around sessions |
| `BUFFER_SECONDS` | `150` | How much recent data the server keeps, which caps the broadcast delay |
| `F1TV_TOKEN` | – | A token to start with (one saved through settings takes priority) |
| `DATA_DIR` | `./data` | Where the calendar, track outlines, last session and token are kept |

## Updating

    git pull
    sudo docker compose build --pull
    sudo docker compose up -d

The image is built locally, so `docker compose pull` alone won't update it. After an update,
reload the page in your browser.

## Monitoring (optional)

- Health check: `http://<server-ip>:3080/healthz`, for Uptime Kuma, Homepage or similar
- The auto sign-in container has its own status check, described in `login/README.md`

## Data sources

- Live timing: livetiming.formula1.com (unofficial)
- Race calendar: api.jolpi.ca (Ergast-compatible)
- Track outlines: MultiViewer's public circuit API

## Keep secrets out of git

`data/` (your token) and `login/.env` (your F1 password) are listed in `.gitignore`. Check
`git status` before committing, and don't put a real token in `docker-compose.yml`.
