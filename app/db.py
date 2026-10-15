from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

_kw = {"connect_args": {"check_same_thread": False}} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, **_kw)

if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _fk(dbapi_conn, _):  # enforce foreign keys on SQLite like Postgres does
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
