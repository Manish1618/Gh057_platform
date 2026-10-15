import os


class Settings:
    site_name: str = os.environ.get("SITE_NAME", "Gh057 CTF")
    database_url: str = os.environ.get("DATABASE_URL", "sqlite:///./dev.db")
    # Cookies are Secure by default; set COOKIE_SECURE=0 only for local http dev.
    cookie_secure: bool = os.environ.get("COOKIE_SECURE", "1") != "0"
    session_ttl_s: int = int(os.environ.get("SESSION_TTL_S", str(7 * 24 * 3600)))
    max_team_size_cap: int = 10
    # HMAC key for stored flags. Changing it invalidates every stored flag.
    flag_pepper: str = os.environ.get("FLAG_PEPPER", "")
    # Wrong-flag throttles per user and per team (per minute).
    flag_fail_user: int = 10
    flag_fail_team: int = 30
    upload_dir: str = os.environ.get("UPLOAD_DIR", "./uploads")
    max_upload_bytes: int = int(os.environ.get("MAX_UPLOAD_MB", "50")) * 1024 * 1024
    # Per-IP and per-account login throttles (window seconds, max failures).
    # The per-IP limit is generous because a whole college lab often shares one
    # public IP; the per-account limit is what stops password guessing.
    login_window_s: int = 300
    login_fail_account: int = 8
    login_fail_ip: int = int(os.environ.get("LOGIN_FAIL_IP", "100"))
    # A session ends after this long without any request (the app polls while open).
    session_idle_s: int = int(os.environ.get("SESSION_IDLE_S", str(12 * 3600)))
    # Encrypts 2FA secrets at rest and keys recovery-code hashes. Required in production.
    secret_key: str = os.environ.get("SECRET_KEY", "")
    # "required": organisers must turn on 2FA before creating or managing events.
    organiser_mfa: str = os.environ.get("ORGANISER_MFA", "required" if cookie_secure else "optional")
    # Host names the app answers to (comma separated); empty = any (dev).
    allowed_hosts: list[str] = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
    # Largest request body outside file uploads.
    max_body_bytes: int = 1024 * 1024


settings = Settings()
