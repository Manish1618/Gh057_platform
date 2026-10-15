"""Player side: challenges, flag attempts, hints, scoreboard, team notices."""
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import current_user, get_visible_event, optional_user, org_role
from ..models import (Attachment, Challenge, Event, Hint, HintUnlock, Lockout, Notice, Solve,
                      Submission, Team, TeamMember, User, aware)
from ..notices import notify, view as notice_view
from ..schemas import AttemptIn
from ..scoring import (board_extras, challenge_value, check_flag, freeze_cutoff,
                       score_series, solve_counts, standings, team_score)
from ..security import limiter

router = APIRouter(prefix="/api/events", tags=["play"])


def _now():
    return datetime.now(timezone.utc)


def _player(db: Session, slug: str, user: User):
    """(event, team, is_org). Players need a team and a started event;
    organisers can preview the board but never submit."""
    ev = get_visible_event(db, slug, user)
    is_org = bool(org_role(db, ev.org_id, user))
    m = db.query(TeamMember).filter_by(event_id=ev.id, user_id=user.id).first()
    team = db.get(Team, m.team_id) if m else None
    if not is_org:
        if not team:
            raise HTTPException(403, "Join or create a team for this event first")
        if ev.starts_at and aware(ev.starts_at) > _now():
            raise HTTPException(403, "The event hasn't started yet")
    return ev, team, is_org


def _require_live(ev: Event):
    if ev.status != "published":
        raise HTTPException(403, "This event isn't open")
    if ev.paused:
        raise HTTPException(403, "Submissions are paused by the organisers")
    if ev.ends_at and aware(ev.ends_at) < _now():
        raise HTTPException(403, "The event has ended")


def _visible_challenge(db: Session, ev: Event, cid: int) -> Challenge:
    ch = db.get(Challenge, cid)
    if not ch or ch.event_id != ev.id or ch.state != "visible":
        raise HTTPException(404, "Challenge not found")
    return ch


def _solved_slugs(db: Session, ev: Event, team: Team | None) -> dict[str, int]:
    if not team:
        return {}
    rows = (db.query(Challenge.slug, Challenge.id).join(Solve, Solve.challenge_id == Challenge.id)
              .filter(Solve.event_id == ev.id, Solve.team_id == team.id))
    return dict(rows.all())


def _unlocked(ch: Challenge, solved: dict[str, int], is_org: bool) -> bool:
    return is_org or all(r in solved for r in (ch.requires or []))


def _wrong_count(db: Session, ch: Challenge, team: Team) -> int:
    return (db.query(func.count(Submission.id))
              .filter_by(challenge_id=ch.id, team_id=team.id, correct=False).scalar())


@router.get("/{slug}/challenges")
def list_challenges(slug: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    cutoff = freeze_cutoff(ev, is_org)
    counts = solve_counts(db, ev, cutoff)
    solved = _solved_slugs(db, ev, team)
    out = []
    for ch in db.query(Challenge).filter_by(event_id=ev.id, state="visible").order_by(Challenge.category, Challenge.value):
        out.append({"id": ch.id, "name": ch.name, "category": ch.category,
                    "value": challenge_value(ch, counts.get(ch.id, 0)),
                    "solves": counts.get(ch.id, 0), "solved": ch.slug in solved,
                    "locked": not _unlocked(ch, solved, is_org)})
    return out


@router.get("/{slug}/challenges/{cid}")
def get_challenge(slug: str, cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    ch = _visible_challenge(db, ev, cid)
    solved = _solved_slugs(db, ev, team)
    if not _unlocked(ch, solved, is_org):
        raise HTTPException(403, "Solve the required challenges first")
    counts = solve_counts(db, ev, freeze_cutoff(ev, is_org))
    unlocked_hints = set()
    if team:
        unlocked_hints = {h for (h,) in db.query(HintUnlock.hint_id).filter_by(team_id=team.id, event_id=ev.id)}
    hints = []
    for h in ch.hints:
        open_ = is_org or h.cost == 0 or h.id in unlocked_hints
        hints.append({"id": h.id, "cost": h.cost, "unlocked": open_, "content": h.content if open_ else None})
    return {"id": ch.id, "name": ch.name, "category": ch.category, "description": ch.description,
            "value": challenge_value(ch, counts.get(ch.id, 0)), "solves": counts.get(ch.id, 0),
            "solved": ch.slug in solved, "max_attempts": ch.max_attempts,
            "attempts": _wrong_count(db, ch, team) if team else 0, "hints": hints,
            "files": [{"id": a.id, "filename": a.filename, "size": a.size, "sha256": a.sha256} for a in ch.files]}


@router.get("/{slug}/files/{fid}")
def download(slug: str, fid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    a = db.get(Attachment, fid)
    ch = _visible_challenge(db, ev, a.challenge_id) if a else None
    if not a or not ch or not _unlocked(ch, _solved_slugs(db, ev, team), is_org):
        raise HTTPException(404, "File not found")
    path = os.path.join(settings.upload_dir, a.stored_as)
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    # always a download, never rendered in the page
    return FileResponse(path, media_type="application/octet-stream", filename=a.filename,
                        content_disposition_type="attachment")


def _last_lockout(db: Session, ch: Challenge, team: Team) -> Lockout | None:
    return (db.query(Lockout).filter(Lockout.challenge_id == ch.id, Lockout.team_id == team.id)
              .order_by(Lockout.until.desc()).first())


def _wait_text(seconds: float) -> str:
    m, s = divmod(max(int(seconds), 1), 60)
    return f"{m}m {s:02d}s" if m else f"{s}s"


@router.post("/{slug}/challenges/{cid}/attempt")
def attempt(slug: str, cid: int, body: AttemptIn, request: Request,
            user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    if is_org or not team:
        raise HTTPException(403, "Organisers can't submit flags in their own event")
    _require_live(ev)
    ch = _visible_challenge(db, ev, cid)
    solved = _solved_slugs(db, ev, team)
    if not _unlocked(ch, solved, False):
        raise HTTPException(403, "Solve the required challenges first")
    if ch.slug in solved:
        return {"correct": False, "status": "already_solved", "message": "Your team already solved this"}

    now = _now()
    last_lock = _last_lockout(db, ch, team)
    if last_lock and aware(last_lock.until) > now:
        raise HTTPException(429, "Your team is locked out of this challenge for another "
                                 f"{_wait_text((aware(last_lock.until) - now).total_seconds())} after too many wrong flags")
    w = 60
    if (limiter.blocked(f"flag:u{user.id}", settings.flag_fail_user, w)
            or limiter.blocked(f"flag:t{team.id}", settings.flag_fail_team, w)):
        raise HTTPException(429, "Too many wrong flags. Wait a minute.")
    wrong = _wrong_count(db, ch, team)
    if ch.max_attempts and wrong >= ch.max_attempts:
        raise HTTPException(403, "Your team has no attempts left for this challenge")

    ok = check_flag(ch.flags, body.flag)
    ip = request.client.host if request.client else ""
    penalty = 0 if ok else ev.wrong_penalty
    db.add(Submission(event_id=ev.id, challenge_id=ch.id, team_id=team.id, user_id=user.id,
                      correct=ok, provided="" if ok else body.flag.strip()[:256], ip=ip, penalty=penalty))
    if not ok:
        out = {"correct": False, "status": "incorrect", "message": "Wrong flag",
               "attempts_left": ch.max_attempts - wrong - 1 if ch.max_attempts else None,
               "penalty": penalty, "locked_for": None}
        if penalty:
            notify(db, ev, "penalty", team.id, user.username, ch.name, -penalty)
            out["message"] = f"Wrong flag · -{penalty} points"
        if out["attempts_left"] == 0:
            notify(db, ev, "attempts", team.id, user.username, ch.name)
        if ev.lockout_threshold:
            # wrong flags since the last lockout began (the whole team counts)
            q = db.query(func.count(Submission.id)).filter(
                Submission.challenge_id == ch.id, Submission.team_id == team.id, Submission.correct.is_(False))
            if last_lock:
                q = q.filter(Submission.created > last_lock.created)
            db.flush()
            if q.scalar() >= ev.lockout_threshold:
                db.add(Lockout(event_id=ev.id, team_id=team.id, challenge_id=ch.id,
                               until=now + timedelta(minutes=ev.lockout_minutes)))
                notify(db, ev, "lockout", team.id, user.username, ch.name,
                       text=f"{ev.lockout_minutes} min")
                out["locked_for"] = ev.lockout_minutes * 60
                out["message"] += f" · team locked out of this challenge for {ev.lockout_minutes} min"
        db.commit()
        limiter.fail(f"flag:u{user.id}", w)
        limiter.fail(f"flag:t{team.id}", w)
        return out

    before = solve_counts(db, ev).get(ch.id, 0)
    first = before == 0
    gained = challenge_value(ch, before + 1) + (ev.first_blood_bonus if first else 0)
    db.add(Solve(event_id=ev.id, challenge_id=ch.id, team_id=team.id, user_id=user.id))
    notify(db, ev, "first_blood" if first else "solve", team.id, user.username, ch.name, gained)
    try:
        db.commit()
    except IntegrityError:  # a teammate solved it a moment ago
        db.rollback()
        return {"correct": False, "status": "already_solved", "message": "Your team already solved this"}
    return {"correct": True, "status": "correct", "first_blood": first, "points": gained,
            "message": "Correct! First blood!" if first else "Correct!"}


@router.post("/{slug}/hints/{hid}/unlock")
def unlock_hint(slug: str, hid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    if is_org or not team:
        raise HTTPException(403, "Only players unlock hints")
    _require_live(ev)
    h = db.get(Hint, hid)
    ch = _visible_challenge(db, ev, h.challenge_id) if h else None
    if not h or not ch:
        raise HTTPException(404, "Hint not found")
    if not _unlocked(ch, _solved_slugs(db, ev, team), False):
        raise HTTPException(403, "Solve the required challenges first")
    if db.query(HintUnlock.id).filter_by(hint_id=h.id, team_id=team.id).first():
        return {"id": h.id, "content": h.content}
    # Lock the team row (Postgres) so two teammates can't overspend at once.
    db.query(Team).filter_by(id=team.id).with_for_update().first()
    if h.cost and team_score(db, ev, team.id) < h.cost:
        raise HTTPException(403, "Your team doesn't have enough points for this hint")
    db.add(HintUnlock(event_id=ev.id, hint_id=h.id, team_id=team.id, user_id=user.id))
    notify(db, ev, "hint", team.id, user.username, ch.name, -h.cost)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return {"id": h.id, "content": h.content}


def _board_viewer(db: Session, slug: str, user: User | None):
    ev = get_visible_event(db, slug, user)
    return ev, freeze_cutoff(ev, bool(org_role(db, ev.org_id, user)))


@router.get("/{slug}/scoreboard")
def scoreboard(slug: str, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    ev, cutoff = _board_viewer(db, slug, user)
    rows = standings(db, ev, cutoff)
    for r in rows:
        r.pop("team_id")
        r["last"] = r["last"].isoformat() if r["last"] else None
    out = {"frozen": cutoff is not None, "standings": rows, "server_time": _now().timestamp()}
    # challenge categories and activity only once the event is under way
    started = not ev.starts_at or aware(ev.starts_at) <= _now()
    if started or org_role(db, ev.org_id, user):
        out.update(board_extras(db, ev, cutoff))
    else:
        out.update({"teams": db.query(func.count(Team.id)).filter_by(event_id=ev.id).scalar(),
                    "challenges": 0, "solves": 0, "categories": [], "feed": [], "buckets": []})
    return out


@router.get("/{slug}/scoreboard/graph")
def scoreboard_graph(slug: str, top: int = Query(10, ge=1, le=25),
                     user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    ev, cutoff = _board_viewer(db, slug, user)
    return {"frozen": cutoff is not None, "series": score_series(db, ev, top, cutoff)}


@router.get("/{slug}/challenges/{cid}/solves")
def challenge_solves(slug: str, cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev, team, is_org = _player(db, slug, user)
    ch = _visible_challenge(db, ev, cid)
    q = (db.query(Team.name, Solve.created).join(Team, Team.id == Solve.team_id)
           .filter(Solve.challenge_id == ch.id).order_by(Solve.created))
    cutoff = freeze_cutoff(ev, is_org)
    if cutoff:
        q = q.filter(Solve.created <= cutoff)
    return [{"team": n, "at": aware(t).isoformat()} for n, t in q]


# --- notices ----------------------------------------------------------------

@router.get("/{slug}/notices")
def notices(slug: str, after: int | None = Query(None, ge=0),
            user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Pop-ups for this viewer: their team's notices plus event-wide
    announcements. Without `after` it only returns where to start from, so a
    fresh page doesn't replay old pop-ups."""
    ev = get_visible_event(db, slug, user)
    m = db.query(TeamMember).filter_by(event_id=ev.id, user_id=user.id).first()
    mine = Notice.team_id.is_(None) if not m else (Notice.team_id.is_(None) | (Notice.team_id == m.team_id))
    q = db.query(Notice).filter(Notice.event_id == ev.id, mine)
    if after is None:
        last = db.query(func.max(Notice.id)).filter(Notice.event_id == ev.id, mine).scalar() or 0
        return {"last": last, "notices": []}
    rows = q.filter(Notice.id > after).order_by(Notice.id).limit(50).all()
    return {"last": rows[-1].id if rows else after, "notices": [notice_view(n) for n in rows]}


@router.get("/{slug}/announcements")
def announcements(slug: str, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    ev = get_visible_event(db, slug, user)
    rows = (db.query(Notice).filter(Notice.event_id == ev.id, Notice.team_id.is_(None))
              .order_by(Notice.id.desc()).limit(20))
    return [notice_view(n) for n in rows]
