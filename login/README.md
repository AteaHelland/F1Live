# F1 TV auto sign-in

A companion container that keeps the dashboard's F1 TV token fresh, so you never have to
copy cookies by hand. It signs in to formula1.com with a headless browser, reads the
subscription token and sends it to the dashboard. The dashboard's settings then show
"Gathered automatically from formula1.com".

## How it works

- It checks every 6 hours and only signs in when the token has less than 36 hours left
  (or half its lifetime, if F1 hands out short tokens).
- It keeps the browser session in `data/`, so most renewals don't need the password at all.
- If F1 shows a captcha or rejects the password, it stops after 3 failed tries so the account
  doesn't get locked. It saves a screenshot of what the browser saw to `data/last-error.png`.
  Until it's fixed, you can paste a token by hand in the dashboard.

Your email and password stay in `.env` on your server and are only sent to formula1.com.

## Install

From the dashboard folder:

    cd login
    cp .env.example .env
    nano .env                          # your F1 TV email and password
    chmod 600 .env
    mkdir -p data && sudo chown 1000:1000 data

In `docker-compose.yml`, set `DASHBOARD_URL` to the address the container can reach the
dashboard on, usually `http://<server-ip>:3080`. Then:

    sudo docker compose up -d --build
    sudo docker logs -f f1tv-login

When it's working, the log shows `new token sent to dashboard`. The first build takes a few
minutes, because it downloads a headless Chromium.

## Check and renew

    curl -s localhost:3081/status           # 200 when the token is valid, 503 when not
    curl -s -X POST localhost:3081/run      # sign in and send a token now

Manual runs are limited to one every few minutes. A monitor on `http://<server-ip>:3081/status`
(Uptime Kuma or similar) goes red when the token has expired or renewal keeps failing, so you
find out before a race weekend.

## Settings

Set these in `docker-compose.yml`:

| Variable | Default | What it does |
| --- | --- | --- |
| `DASHBOARD_URL` | `http://192.168.1.250:3080` | Where to send the token. Change this |
| `CHECK_HOURS` | `6` | How often to check the token |
| `RENEW_HOURS` | `36` | Renew when less than this many hours are left |
| `MAX_FAILURES` | `3` | Failed sign-ins in a row before it stops trying |
| `PORT` | `3081` | Port for `/status` and `/run` |

`F1_EMAIL` and `F1_PASSWORD` go in `.env`, which is kept out of git.

## Troubleshooting

- **"F1 showed a bot check (captcha)"**: F1 wants proof you're human. Paste a token by hand
  this time, then `curl -X POST localhost:3081/run` later.
- **"F1 rejected the sign-in"**: check the email and password in `.env`, then run
  `sudo docker compose up -d` and `/run` again.
- **"couldn't find the sign-in form"**: F1 has probably changed its sign-in page. Look at
  `data/last-error.png` and the log, which shows the page it ended up on.

## Updating

    sudo docker compose build --pull
    sudo docker compose up -d
