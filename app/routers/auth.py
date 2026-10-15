from datetime import datetime, timedelta, timezone

import pyotp
import segno
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit, client_ip
from ..config import settings
from ..db import get_db
from ..deps import COOKIE, current_session, current_user
from ..models import AuditLog, AuthSession, RecoveryCode, User, aware, utcnow
from ..schemas import LoginIn, PasswordIn, RegisterIn, TotpIn, TotpOffIn
from ..security import (decrypt_secret, encrypt_secret, hash_password, limiter, needs_rehash,
                        new_recovery_codes, new_token, new_totp_secret, password_problem,
                        recovery_digest, sha256, totp_step, verify_password)

router = APIRouter(prefix="/api/auth", tags=["auth"])

BAD_LOGIN = "Wrong email, password or 2FA code"


def _start_session(db: Session, request: Request, response: Response, user: User) -> dict:
    tok, csrf = new_token(), new_token()
    db.add(AuthSession(token_hash=sha256(tok), csrf=csrf, user_id=user.id, ip=client_ip(request),
                       user_agent=request.headers.get("user-agent", "")[:200],
                       expires=datetime.now(timezone.utc) + timedelta(seconds=settings.session_ttl_s)))
    db.commit()
    response.set_cookie(COOKIE, tok, max_age=settings.session_ttl_s, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path="/")
    return {"csrf": csrf, "user": _me(user)}


def _me(u: User) -> dict:
    return {"id": u.id, "email": u.email, "username": u.username, "totp_enabled": u.totp_enabled}


def _check_second_factor(db: Session, u: User, code: str) -> str | None:
    """'totp' or 'recovery' when the code is good, else None. A TOTP code works
    once; a recovery code is used up."""
    code = (code or "").strip()
    step = totp_step(decrypt_secret(u.totp_secret), code, after=u.totp_last_step or 0)
    if step is not None:
        u.totp_last_step = step
        return "totp"
    if len(code.replace("-", "")) == 10:
        rc = db.query(RecoveryCode).filter_by(user_id=u.id, digest=recovery_digest(code), used=None).first()
        if rc:
            rc.used = utcnow()
            return "recovery"
    return None


def _issue_recovery_codes(db: Session, u: User) -> list[str]:
    db.query(RecoveryCode).filter_by(user_id=u.id).delete()
    codes = new_recovery_codes()
    db.add_all(RecoveryCode(user_id=u.id, digest=recovery_digest(c)) for c in codes)
    return codes


@router.post("/register", status_code=201)
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    problem = password_problem(body.password, body.username, body.email)
    if problem:
        raise HTTPException(422, problem)
    u = User(email=body.email.lower(), username=body.username, pw_hash=hash_password(body.password))
    db.add(u)
    try:
        db.flush()
        audit(db, "register", u.id, request=request)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Email or username already registered")
    return _start_session(db, request, response, u)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email, ip = body.email.lower(), client_ip(request)
    w = settings.login_window_s
    if (limiter.blocked(f"acct:{email}", settings.login_fail_account, w)
            or limiter.blocked(f"ip:{ip}", settings.login_fail_ip, w)):
        raise HTTPException(429, "Too many failed logins. Try again in a few minutes.")
    u = db.query(User).filter_by(email=email).first()
    ok = verify_password(body.password, u.pw_hash if u else None) and u is not None and u.is_active
    how = "password"
    if ok and u.totp_enabled:
        how = _check_second_factor(db, u, body.totp or "")
        ok = how is not None
    if not ok:
        limiter.fail(f"acct:{email}", w)
        limiter.fail(f"ip:{ip}", w)
        if u:
            audit(db, "login_failed", u.id, request=request)
            db.commit()
        raise HTTPException(401, BAD_LOGIN)
    limiter.clear(f"acct:{email}")
    if needs_rehash(u.pw_hash):
        u.pw_hash = hash_password(body.password)
    audit(db, "login", u.id, detail="with a recovery code" if how == "recovery" else "", request=request)
    out = _start_session(db, request, response, u)
    if how == "recovery":
        out["recovery_codes_left"] = db.query(RecoveryCode).filter_by(user_id=u.id, used=None).count()
    return out


@router.post("/logout")
def logout(response: Response, s: AuthSession = Depends(current_session), db: Session = Depends(get_db)):
    db.delete(s)
    db.commit()
    response.delete_cookie(COOKIE, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax")
    return {"ok": True}


@router.get("/me")
def me(s: AuthSession = Depends(current_session), u: User = Depends(current_user), db: Session = Depends(get_db)):
    out = {"user": _me(u), "csrf": s.csrf}
    if u.totp_enabled:
        out["recovery_codes_left"] = db.query(RecoveryCode).filter_by(user_id=u.id, used=None).count()
    return out


# --- two-factor login --------------------------------------------------------

@router.post("/2fa/setup")
def totp_setup(u: User = Depends(current_user), db: Session = Depends(get_db)):
    if u.totp_enabled:
        raise HTTPException(400, "2FA is already on")
    secret = new_totp_secret()
    u.totp_secret = encrypt_secret(secret)
    db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=u.email, issuer_name=settings.site_name)
    # drawn here so the page needs no QR script and the secret never leaves this response
    qr = segno.make(uri, error="m").svg_data_uri(scale=5, border=2, dark="#000", light="#fff")
    return {"secret": secret, "otpauth_uri": uri, "qr": qr}


@router.post("/2fa/enable")
def totp_enable(body: TotpIn, request: Request, response: Response,
                u: User = Depends(current_user), db: Session = Depends(get_db)):
    step = totp_step(decrypt_secret(u.totp_secret), body.code) if u.totp_secret else None
    if step is None:
        raise HTTPException(400, "Code didn't match. Check your authenticator's clock.")
    u.totp_enabled, u.totp_last_step = True, step
    codes = _issue_recovery_codes(db, u)
    # Sessions opened without 2FA end; this browser gets a fresh one.
    db.query(AuthSession).filter(AuthSession.user_id == u.id).delete()
    audit(db, "2fa_on", u.id, request=request)
    out = _start_session(db, request, response, u)
    return {**out, "recovery_codes": codes}


@router.post("/2fa/disable")
def totp_disable(body: TotpOffIn, request: Request, s: AuthSession = Depends(current_session),
                 u: User = Depends(current_user), db: Session = Depends(get_db)):
    if not u.totp_enabled:
        raise HTTPException(400, "2FA is already off")
    if not verify_password(body.password, u.pw_hash) or not _check_second_factor(db, u, body.code):
        db.commit()  # keep a spent code spent
        raise HTTPException(400, "Wrong password or code")
    u.totp_enabled, u.totp_secret, u.totp_last_step = False, None, 0
    db.query(RecoveryCode).filter_by(user_id=u.id).delete()
    db.query(AuthSession).filter(AuthSession.user_id == u.id, AuthSession.id != s.id).delete()
    audit(db, "2fa_off", u.id, request=request)
    db.commit()
    return {"ok": True, "user": _me(u)}


@router.post("/2fa/recovery-codes")
def new_codes(body: TotpIn, request: Request, u: User = Depends(current_user), db: Session = Depends(get_db)):
    """Replace the recovery codes; needs a current code from the app."""
    if not u.totp_enabled or _check_second_factor(db, u, body.code) != "totp":
        db.commit()
        raise HTTPException(400, "Enter a current code from your authenticator app")
    codes = _issue_recovery_codes(db, u)
    audit(db, "recovery_codes_new", u.id, request=request)
    db.commit()
    return {"recovery_codes": codes}


# --- password and sessions ---------------------------------------------------

@router.post("/password")
def change_password(body: PasswordIn, request: Request, s: AuthSession = Depends(current_session),
                    u: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current, u.pw_hash):
        audit(db, "password_change_failed", u.id, request=request)
        db.commit()
        raise HTTPException(400, "Your current password is wrong")
    problem = password_problem(body.new, u.username, u.email)
    if problem:
        raise HTTPException(422, problem)
    u.pw_hash = hash_password(body.new)
    # anyone holding an old session is signed out; this browser stays in
    db.query(AuthSession).filter(AuthSession.user_id == u.id, AuthSession.id != s.id).delete()
    audit(db, "password_changed", u.id, request=request)
    db.commit()
    return {"ok": True}


@router.get("/sessions")
def sessions(s: AuthSession = Depends(current_session), db: Session = Depends(get_db)):
    rows = db.query(AuthSession).filter_by(user_id=s.user_id).order_by(AuthSession.last_seen.desc())
    return [{"id": r.id, "current": r.id == s.id, "ip": r.ip, "user_agent": r.user_agent,
             "created": aware(r.created).isoformat(), "last_seen": aware(r.last_seen).isoformat()} for r in rows]


@router.post("/sessions/revoke-others")
def revoke_others(request: Request, s: AuthSession = Depends(current_session), db: Session = Depends(get_db)):
    n = db.query(AuthSession).filter(AuthSession.user_id == s.user_id, AuthSession.id != s.id).delete()
    audit(db, "sessions_revoked", s.user_id, detail=f"{n} other sessions", request=request)
    db.commit()
    return {"ok": True, "ended": n}


@router.delete("/sessions/{sid}")
def revoke(sid: int, request: Request, s: AuthSession = Depends(current_session), db: Session = Depends(get_db)):
    r = db.get(AuthSession, sid)
    if not r or r.user_id != s.user_id:
        raise HTTPException(404, "Session not found")
    db.delete(r)
    audit(db, "session_revoked", s.user_id, request=request)
    db.commit()
    return {"ok": True}


@router.get("/activity")
def activity(u: User = Depends(current_user), db: Session = Depends(get_db)):
    """Your own recent security events, so you can spot a stranger."""
    rows = (db.query(AuditLog).filter(AuditLog.user_id == u.id, AuditLog.event_id.is_(None))
              .order_by(AuditLog.id.desc()).limit(30))
    return [{"action": a.action, "detail": a.detail, "ip": a.ip, "at": aware(a.created).isoformat()} for a in rows]
