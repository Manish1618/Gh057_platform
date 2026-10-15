# Security

A CTF platform is attacked by the people it is built for, so every part of it
assumes the players are skilled and some of them will try. This page lists
what an attacker might try and what stops it.

## Accounts and logins

| Attack | What stops it |
|---|---|
| Stolen password database | Passwords are argon2id hashes, rehashed automatically when the parameters get stronger. 2FA secrets are encrypted with AES-256-GCM using a key derived from `SECRET_KEY`, which is not in the database. Recovery codes and session tokens are stored only as keyed or SHA-256 hashes. |
| Password guessing | 8 failed logins per account per 5 minutes, then the account waits. 100 per IP (a whole college lab can share one IP). Common passwords, passwords under 10 characters, and passwords containing the username or email are refused. |
| Finding out who has an account | Login gives the same error and takes the same time for a wrong password and an unknown email (unknown emails are checked against a dummy hash). |
| Phished or reused password | TOTP two-factor login with a QR code. Codes are checked against a window of one step either side, and a code that has been used can't be used again. Ten single-use recovery codes are shown once when 2FA is turned on. |
| Taking over an organiser account | With `ORGANISER_MFA=required` (the default in production), nobody can create organisations or events, or touch an event's settings, challenges, flags, points or announcements, until their account has 2FA on. |
| Attacker turns 2FA off on a stolen session | Turning 2FA off needs the password and a current code. Making new recovery codes needs a code from the app. |
| Attacker keeps a stolen session alive | Turning 2FA on, turning it off, and changing the password all log out every other session. The Account page lists every session (browser, IP, last active) with a button to end it or all the others. Sessions end after 12 hours idle and 7 days at most. |
| Noticing a break-in | The Account page shows your own security log: logins, failed logins, recovery-code logins, password and 2FA changes, from which IP. |

## Sessions and the browser

| Attack | What stops it |
|---|---|
| Stealing the cookie with script | The session cookie is HttpOnly, Secure, SameSite=Lax and uses the `__Host-` prefix, so no script, plain-http page or subdomain can read or plant it. |
| Cross-site script injection (XSS) | Content-Security-Policy allows scripts only from the site itself, with no inline scripts. Every value from the server is HTML-escaped before it reaches the page. Challenge descriptions use a small Markdown subset that escapes first and only allows http(s) links. |
| Cross-site request forgery | Every state change needs the per-session `X-CSRF-Token` header, and any POST/PATCH/DELETE (login and register included) carrying another site's `Origin` is refused. |
| Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'`. |
| Leaking data through other windows or caches | `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are `same-origin`; API answers are `Cache-Control: no-store` so shared lab computers don't keep them; `Referrer-Policy: same-origin`; camera, microphone and location are switched off by `Permissions-Policy`. |
| Downgrade to http | HSTS for a year; Caddy redirects http to https. |
| Host-header tricks | The app answers only to `DOMAIN` (`ALLOWED_HOSTS`). |

## Flags, scoring and the game

| Attack | What stops it |
|---|---|
| Reading flags from the database or the organiser screens | Flags are stored only as HMAC-SHA256 keyed with `FLAG_PEPPER`. Organisers can add and remove flags but never read them back. The audit log never contains a flag. |
| Brute-forcing flags | 10 wrong flags a minute per player and 30 per team. Per event, organisers can also lock a team out of a challenge after N wrong flags for M minutes, take points off for every wrong flag, and cap attempts per challenge. |
| Timing attacks on flag checks | Flags are compared in constant time, against every flag of the challenge. |
| Double-solving or racing hint purchases | One solve per team per challenge and one unlock per hint per team are database constraints; buying a hint locks the team row. |
| Seeing challenges or drafts early | Challenges appear only to team members once the event has started. Drafts, other organisations' events and hidden challenges return the same 404 as things that don't exist. |
| Players using organiser tools | Every organiser route checks membership of the event's organisation and returns 404 otherwise. Organisers can't play in their own events. |
| An organiser abusing the tools | Every organiser change (settings with old and new values, challenges, flags added or removed, hints, files, point changes, lifted lockouts, announcements) is recorded with who, when and from which IP, and shown on the event's Activity tab. |

## Files and requests

| Attack | What stops it |
|---|---|
| Uploading a script and getting it run | Files are stored under random names outside the web folder and always served as `application/octet-stream` downloads, only to players who can see the challenge. |
| Huge requests to exhaust memory or disk | 1 MB for any request, 50 MB for challenge files, enforced both by Caddy and by the app (also for chunked uploads without a length). |
| Unexpected input | Strict schemas reject unknown fields; slugs, names and lengths are whitelisted. |

## Server

| Attack | What stops it |
|---|---|
| Breaking out of the app container | Runs as a non-root user with a read-only filesystem, every Linux capability dropped and `no-new-privileges`. |
| Reaching the database from outside | Postgres sits on an internal-only network; only Caddy is published (ports 80 and 443). |
| Running with weak secrets | In production the app refuses to start unless `FLAG_PEPPER` and `SECRET_KEY` are at least 32 characters and not the example values. |
| Known-vulnerable libraries | Dependencies are pinned in `requirements.txt`. `pip-audit -r requirements.txt` reported no known vulnerabilities and `bandit -r app` reported no issues on 2026-10-15. Re-run both before each event. |

## Not done yet

- **Per-team challenge machines and their abuse limits** come with step 4
  (challenge containers). Teams will get the same kind of pop-up when they hit
  the instance limit.
- **Database migrations.** Tables are created at startup; a version that
  changes the database needs a fresh database until Alembic is added.
- **Email verification and password reset by email.** Until then an organiser
  who loses both their phone and their recovery codes needs the server admin.
- **More than one app process.** The login and flag throttles live in memory;
  use Redis before running several app processes.
- **Postgres in tests.** The suite runs on SQLite today.

## Reporting a problem

Please report security problems privately (GitHub: Security, then Report a
vulnerability) rather than in a public issue.
