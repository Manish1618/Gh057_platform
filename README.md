# CTF Platform

A multi-organiser CTF platform: any club can create an organisation, run events,
and let players register in teams. Inspired by CTF7 (events) and CTFd (scoreboard),
styled with the Gh057_Society theme (`web/static/theme/`).

## Pages

| Path | What |
|---|---|
| `/` | Published events |
| `/register`, `/login` | Accounts (log in with an app code or a recovery code) |
| `/account` | 2FA with QR code and recovery codes, password change, where you're logged in, recent security activity |
| `/e/{event}` | Event page, rules, latest announcements, create or join a team |
| `/e/{event}/challenges` | Challenge board (team members, once started) |
| `/e/{event}/scoreboard` | Live board, public, with a Big screen mode for projectors |
| `/dashboard` | Your organisations; create clubs and events, add organisers |
| `/manage/{event}` | Challenges editor, settings, publish/pause; Live tab (announcements, point changes, lockouts, submissions); Activity tab (who changed what) |

The browser app is plain HTML/CSS/JS with no build step (`web/`). Set
`SITE_NAME` to change the name in the header.

## Status

- Step 1 (done): secure core with accounts, organisations, events, teams.
- Step 2 (done): challenges, flags, hints, files, dynamic scoring, first blood,
  scoreboard with graph and freeze, organiser monitoring.
- Step 3 (done): the website in the Gh057 theme. Players: events, sign-up,
  teams, challenge board, flag submission, hints, file downloads, live
  scoreboard (rolling clock, orbit stage, gauges, capture signal, score graph,
  first-blood moments). Organisers: clubs, events, settings, and a no-code
  challenge editor (flags, hints, files, unlock order, dynamic scoring), plus a
  live submissions feed.
- Step 3b (done): the Gh057_Society scoreboard brought over in full. The orbit
  of team names moves live, rows glide when ranks change, and the layout
  shrinks itself to fit when there are many teams or a narrow screen (a flat
  list on phones). Big screen mode fills a projector.
- Team alerts (done): every teammate gets a pop-up with sound when someone on
  the team solves a challenge, draws first blood, unlocks a hint, submits a
  wrong flag, gets the team locked out, or when organisers change the team's
  points. Announcements reach everyone viewing the event. Sounds: `correct.mp3`
  and `wrong.mp3` from the old scoreboard, plus a short chime; players can mute
  them from the header.
- Game rules (done, per event): wrong-flag lockout (N wrong flags on one
  challenge locks the team out of it for M minutes; organisers can lift it),
  points lost per wrong flag, hint costs, organiser bonuses and deductions with
  a reason the team sees.
- Security pass (done): see [SECURITY.md](SECURITY.md).
- Step 4 (next): challenge machines (per-team containers) and a dry run on the
  VPS. The per-team instance limit ("instance abuse limit") arrives with it;
  the alert type already exists so teams will be told when they hit it.

The platform ships with no challenges. Organisers add their own.

## Run locally

    python3 -m pip install -r requirements-dev.txt
    COOKIE_SECURE=0 uvicorn app.main:app --reload     # SQLite at ./dev.db
    python3 -m pytest -q

Tables are created at startup and there are no migrations yet, so after
pulling a version that changes the database, start from a fresh database
(delete `dev.db`, or `docker compose down -v` on a test server).

## Deploy

    cp .env.example .env    # fill in every value; generate secrets with: openssl rand -hex 32
    docker compose up -d --build

Caddy gets a Let's Encrypt certificate for DOMAIN automatically. Only ports 80
and 443 are exposed; the app and Postgres aren't reachable from outside.
The app refuses to start in production until FLAG_PEPPER and SECRET_KEY are set.

| Setting | What it does |
|---|---|
| `DOMAIN` | Your site's name; also the only Host the app answers to |
| `DB_PASSWORD` | Postgres password |
| `FLAG_PEPPER` | Keys the stored flag hashes. Never change it after adding flags |
| `SECRET_KEY` | Encrypts 2FA secrets and keys recovery-code hashes. Never change it, or everyone's 2FA stops working |
| `ORGANISER_MFA` | `required` (default): organisers must turn on 2FA before creating or managing events. `optional` to allow skipping |
| `SITE_NAME` | Name in the header and in authenticator apps |
| `LOGIN_FAIL_IP` | Failed logins allowed per IP per 5 minutes (default 100, because a college lab often shares one public IP) |
| `SESSION_IDLE_S` | Log out after this many seconds without activity (default 12 hours) |
| `SESSION_TTL_S` | Longest a login lasts (default 7 days) |
| `MAX_UPLOAD_MB` | Largest challenge file (default 50) |

## Security

[SECURITY.md](SECURITY.md) lists each attack the platform is built to resist and
what stops it, plus the gaps still open.

## How scoring works

- Static challenges are worth their value. Dynamic ones use CTFd's formula:
  the first solver gets the full value, then it decays quadratically and hits
  the minimum after `decay` solves. Every solver's points follow the current
  value, as in CTFd.
- First blood: the earliest solve per challenge, with an optional per-event bonus.
- Hints may cost points; a team can't buy a hint it can't afford.
- Wrong flags can cost points (`wrong_penalty`). Changing the setting doesn't
  rewrite earlier attempts.
- Organiser bonuses and deductions are added to the team's score and can be undone.
- Ranking: score, then whoever reached that score first.
- Freeze: after `freeze_at`, players and the public see the board (and solve
  counts) as of that moment; organisers keep seeing it live.
- Hidden challenges don't count toward scores.

## API

| Method | Path | Who |
|---|---|---|
| POST | /api/auth/register, /login, /logout | anyone / logged in |
| GET | /api/auth/me | logged in |
| POST | /api/auth/2fa/setup, /2fa/enable, /2fa/disable, /2fa/recovery-codes | logged in |
| POST | /api/auth/password | logged in |
| GET, POST, DELETE | /api/auth/sessions, /sessions/revoke-others, /sessions/{id} | logged in (own sessions) |
| GET | /api/auth/activity | logged in (own security log) |
| POST/GET | /api/orgs | logged in (creator becomes owner) |
| POST | /api/orgs/{org}/members | org owner |
| POST/GET | /api/orgs/{org}/events | org owner/admin |
| GET | /api/events, /api/events/{event} | public (published only) |
| PATCH | /api/events/{event} | org owner/admin |
| POST | /api/events/{event}/teams, /teams/join, /teams/leave | players |
| GET | /api/events/{event}/teams, /teams/me | public / team member |
| GET | /api/events/{event}/challenges, /challenges/{id}, /challenges/{id}/solves | team members, once started |
| POST | /api/events/{event}/challenges/{id}/attempt | team members, while live |
| POST | /api/events/{event}/hints/{id}/unlock | team members, while live |
| GET | /api/events/{event}/files/{id} | team members |
| GET | /api/events/{event}/scoreboard, /scoreboard/graph | public (published events) |
| GET | /api/events/{event}/notices?after={id} | team alerts and announcements for the viewer |
| GET | /api/events/{event}/announcements | public (published events) |
| GET/POST | /api/events/{event}/manage/challenges | organisers |
| PATCH/DELETE | /api/events/{event}/manage/challenges/{id} | organisers |
| POST/DELETE | /manage/challenges/{id}/flags[/{flag}] | organisers |
| POST, PATCH/DELETE | /manage/challenges/{id}/hints, /manage/hints/{id} | organisers |
| POST, DELETE | /manage/challenges/{id}/files, /manage/files/{id} | organisers |
| GET | /manage/submissions, /manage/stats, /manage/teams | organisers |
| GET, POST, DELETE | /manage/awards[/{id}] | organisers (bonus or deduction with a reason) |
| GET, DELETE | /manage/lockouts[/{id}] | organisers (lift a lockout) |
| POST, DELETE | /manage/announcements[/{id}] | organisers |
| GET | /manage/audit | organisers (event change log) |

Event settings organisers can change (PATCH /api/events/{event}): title,
description, status (draft/published/archived), start/end, registration,
team size, pause, scoreboard freeze time, first-blood bonus, wrong-flag
lockout (threshold and minutes), points lost per wrong flag.
