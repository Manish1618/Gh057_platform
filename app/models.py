from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, ForeignKey, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


def aware(dt):
    """SQLite hands back naive datetimes; everything here is stored as UTC."""
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    pw_hash: Mapped[str] = mapped_column(String(255))
    totp_secret: Mapped[str | None] = mapped_column(String(128), nullable=True)  # AES-GCM encrypted
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)  # stops a code being used twice
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuthSession(Base):
    """Server-side session. Only the SHA-256 of the cookie token is stored."""
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    csrf: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(200), default="")


class RecoveryCode(Base):
    """One-time 2FA backup codes. Only a keyed hash is stored."""
    __tablename__ = "recovery_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    digest: Mapped[str] = mapped_column(String(64))
    used: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditLog(Base):
    """Security-relevant actions: sign-ins, 2FA and password changes, and
    everything organisers do to an event."""
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(40))
    detail: Mapped[str] = mapped_column(String(300), default="")
    ip: Mapped[str] = mapped_column(String(64), default="")


class Organization(Base):
    __tablename__ = "orgs"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    slug: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OrgMember(Base):
    __tablename__ = "org_members"
    __table_args__ = (UniqueConstraint("org_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10))  # owner | admin


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("orgs.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="draft")  # draft | published | archived
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    registration_open: Mapped[bool] = mapped_column(Boolean, default=True)
    max_team_size: Mapped[int] = mapped_column(Integer, default=4)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    # After freeze_at the public scoreboard stops moving; organisers still see live.
    freeze_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    first_blood_bonus: Mapped[int] = mapped_column(Integer, default=0)
    # Wrong-flag rules: after `lockout_threshold` wrong flags on one challenge
    # the team is locked out of it for `lockout_minutes` (0 = off), and every
    # wrong flag can cost `wrong_penalty` points.
    lockout_threshold: Mapped[int] = mapped_column(Integer, default=0)
    lockout_minutes: Mapped[int] = mapped_column(Integer, default=5)
    wrong_penalty: Mapped[int] = mapped_column(Integer, default=0)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Team(Base):
    __tablename__ = "teams"
    __table_args__ = (UniqueConstraint("event_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    join_code: Mapped[str] = mapped_column(String(32), unique=True)
    captain_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    members: Mapped[list["TeamMember"]] = relationship(cascade="all, delete-orphan")


class TeamMember(Base):
    __tablename__ = "team_members"
    # one team per user per event, enforced by the database
    __table_args__ = (UniqueConstraint("event_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))


class Challenge(Base):
    __tablename__ = "challenges"
    __table_args__ = (UniqueConstraint("event_id", "slug"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(80))
    category: Mapped[str] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(Text, default="")
    value: Mapped[int] = mapped_column(Integer)          # static value, or dynamic starting value
    scoring: Mapped[str] = mapped_column(String(10), default="static")  # static | dynamic
    minimum: Mapped[int | None] = mapped_column(Integer, nullable=True)
    decay: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[str] = mapped_column(String(10), default="hidden")    # hidden | visible
    max_attempts: Mapped[int] = mapped_column(Integer, default=0)       # 0 = unlimited
    requires: Mapped[list] = mapped_column(JSON, default=list)          # challenge slugs
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    flags: Mapped[list["Flag"]] = relationship(cascade="all, delete-orphan")
    hints: Mapped[list["Hint"]] = relationship(cascade="all, delete-orphan", order_by="Hint.id")
    files: Mapped[list["Attachment"]] = relationship(cascade="all, delete-orphan", order_by="Attachment.id")


class Flag(Base):
    """Only an HMAC of the flag is stored (keyed with FLAG_PEPPER), so a
    database leak alone doesn't hand out the answers."""
    __tablename__ = "flags"
    id: Mapped[int] = mapped_column(primary_key=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    digest: Mapped[str] = mapped_column(String(64))
    case_insensitive: Mapped[bool] = mapped_column(Boolean, default=False)


class Hint(Base):
    __tablename__ = "hints"
    id: Mapped[int] = mapped_column(primary_key=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    content: Mapped[str] = mapped_column(Text)
    cost: Mapped[int] = mapped_column(Integer, default=0)


class HintUnlock(Base):
    __tablename__ = "hint_unlocks"
    __table_args__ = (UniqueConstraint("hint_id", "team_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    hint_id: Mapped[int] = mapped_column(ForeignKey("hints.id", ondelete="CASCADE"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Submission(Base):
    """Every attempt, for the organisers' feed. The text is kept only for
    wrong attempts, so correct flags never sit in the database in plain."""
    __tablename__ = "submissions"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    correct: Mapped[bool] = mapped_column(Boolean)
    provided: Mapped[str] = mapped_column(String(256), default="")
    penalty: Mapped[int] = mapped_column(Integer, default=0)  # points lost, fixed when it happened
    ip: Mapped[str] = mapped_column(String(64), default="")
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Solve(Base):
    __tablename__ = "solves"
    # a team solves a challenge once, enforced by the database (no double-scoring races)
    __table_args__ = (UniqueConstraint("challenge_id", "team_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Attachment(Base):
    """A file organisers attach to a challenge. Stored on disk under a random
    name; the original name is only used for the download header."""
    __tablename__ = "attachments"
    id: Mapped[int] = mapped_column(primary_key=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(120))
    stored_as: Mapped[str] = mapped_column(String(64), unique=True)
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Lockout(Base):
    """A team is barred from one challenge until `until` after too many wrong flags."""
    __tablename__ = "lockouts"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    challenge_id: Mapped[int] = mapped_column(ForeignKey("challenges.id", ondelete="CASCADE"), index=True)
    until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Award(Base):
    """Points an organiser adds or deducts by hand, with the reason shown to the team."""
    __tablename__ = "awards"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    points: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Notice(Base):
    """A pop-up for a team (team_id set) or for everyone in the event (team_id
    NULL, organiser announcements). Names are copied in so a notice still
    reads right after a challenge is renamed or deleted."""
    __tablename__ = "notices"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(20))
    actor: Mapped[str] = mapped_column(String(32), default="")     # who did it (username)
    subject: Mapped[str] = mapped_column(String(80), default="")   # challenge name
    points: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(String(500), default="")
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
