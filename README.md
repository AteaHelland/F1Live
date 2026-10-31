# F1 Live

A self-hosted Formula 1 dashboard for your home network. It shows the next race weekend in
your own time zone and, while a session is running, live timing with a track map: like a
second screen next to the broadcast.

> Unofficial and not affiliated with Formula 1. It reads F1's public live-timing feed, which
> can change without notice. Car positions need your own F1 TV subscription.

## What it shows

**Between race weekends**
- The next race weekend with every session in your local time, plus a countdown
- Championship standings for drivers and teams
- Results of every race, sprint and qualifying this season
- A calendar feed (`/calendar.ics`) to subscribe to from your phone or computer

**During a session**
- Track status (green, yellow, safety car, VSC, red), shown as a colour bar across the top
- Lap count and a timing tower: positions, gap or interval (tap to switch), last lap
- Sector times, coloured for personal and overall bests
- Tyre compound, tyre age and pit stops
- Race control messages
- A track map with live car positions in team colours, with yellow-flagged sectors highlighted
- Weather: air and track temperature (with trend), humidity, wind and rain
- Tyre strategy chart: every driver's stints by compound and length
- Race trace: each driver's gap to the leader lap by lap, with safety car periods shaded
- Team radio clips you can play on the page
- Telemetry for one driver: speed, gear, RPM, throttle and brake (F1 TV only); tap a driver in
  the timing tower to switch
- Live championship standings during races and sprints, with points for the current order
- A favourite driver, highlighted everywhere, with the gaps ahead and behind (⚙ settings)
- Qualifying mode: which part is running (Q1/Q2/Q3, or SQ for sprint qualifying), the
  elimination line and drop zone in the timing tower, the cut-off time, and how much your
  favourite needs to find (or has in hand)
- Pit window: where each driver would rejoin if they pitted now ("If pit" column), with a
  ghost marker on the map for your favourite. The pit loss is a typical value per circuit,
  reduced under a safety car or VSC, and can be set by hand in ⚙ settings
- Pit stop log: every stop with lap, tyre change and time in the pit lane
- Speed traps: each driver's best speed at the intermediate points, finish line and speed trap
- Head-to-head: any two drivers side by side, with lap times and the gap between them lap by lap
- Your own layout: tap the layout button next to ⚙ to move cards up and down, between the
  two columns or hide them. Phones and wide screens keep separate layouts, saved in each browser
- The eye icon in the timing tower hides or shows a driver on the track map
- A broadcast-delay slider so the page matches your stream (TV and streaming usually run
  20–45 seconds behind the live data)

The dashboard only connects to F1's feed from 45 minutes before a session until about 90
minutes after it. It keeps the last session's data, so you can look at results afterwards.

The race trace is built by the server as laps are completed, so it starts from the first lap
the server sees. If the container restarts mid-race, the laps it missed stay empty.

## Requirements

- A machine running Docker with the Compose plugin
- Optional: an F1 TV subscription, for car positions on the track map and telemetry (F1 only
  sends those to subscribers; everything else works without it)
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

## Calendar feed

Every session of the season is available as an iCalendar feed:

| Link | What you get |
| --- | --- |
| `/calendar.ics` | All sessions |
| `/calendar.ics?main=1` | Race, qualifying and sprint only |
| `/calendar.ics?alarm=15` | All sessions, with an alert 15 minutes before (any number up to 240) |

⚙ settings has ready-made subscribe links. Add the subscription on each device ("On My
iPhone" or "On My Mac") rather than to iCloud: subscriptions in iCloud are fetched by Apple's
servers, which can't reach a server on your home network. With HTTPS from a local CA, the
device has to trust that CA first.

## F1 TV token (car positions and telemetry)

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
| `DEMO_SPEED` | `1` | In demo mode, runs the simulated session faster (e.g. `8`) to fill the charts quickly; lap times look odd at high speeds |
| `DEMO_SESSION` | `race` | In demo mode, `quali` plays a qualifying session instead of a race |
| `JOLPICA_URL` | `https://api.jolpi.ca/ergast/f1` | Calendar, standings and results API (change only for testing) |

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
- Race calendar, standings and results: api.jolpi.ca (Ergast-compatible)
- Team radio clips: played straight from livetiming.formula1.com
- Track outlines: MultiViewer's public circuit API

## Keep secrets out of git

`data/` (your token) and `login/.env` (your F1 password) are listed in `.gitignore`. Check
`git status` before committing, and don't put a real token in `docker-compose.yml`.
