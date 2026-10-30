# f1tv-login

Keeps the F1 TV token on f1.home.arpa fresh. A headless browser signs in to formula1.com,
reads the subscription token from the `login-session` cookie and posts it to the dashboard's
`/api/token` (the same thing the Save button in ⚙ settings does).

- Checks every 6 hours. It only signs in when less than 36 hours are left on the token (or half
  its lifetime, if F1 hands out short ones).
- It keeps the browser session in `data/`, so most renewals don't type the password at all.
- If F1 shows a captcha or rejects the password, it stops after 3 failed tries so the account
  doesn't get locked. Check `data/last-error.png` to see what the browser saw, fix it, then
  `curl -X POST localhost:3081/run`.

## Install

    cd /opt/f1live
    tar -xzf ~/f1tv-login.tar.gz            # creates /opt/f1live/login
    cd login
    cp .env.example .env && nano .env       # your F1 email and password
    chmod 600 .env
    mkdir -p data && sudo chown 1000:1000 data
    sudo docker compose up -d --build
    sudo docker logs -f f1tv-login          # look for "new token sent to dashboard"

## Check / renew

    curl -s localhost:3081/status           # 200 when the token is valid, 503 when not
    curl -s -X POST localhost:3081/run      # sign in and send a token now

Uptime Kuma: an HTTP monitor on `http://192.168.1.250:3081/status` goes red when the token has
expired or sign-in keeps failing.

## Updating

    cd /opt/f1live/login && sudo docker compose build --pull && sudo docker compose up -d
