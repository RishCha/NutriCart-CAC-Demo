"""Small SQLite persistence layer for optional NutriCart accounts."""

from __future__ import annotations

import json
import hashlib
import re
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from werkzeug.security import check_password_hash, generate_password_hash


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
KINDS = {"grocery_plan", "meal_plan", "shopping_list"}
FORBIDDEN_KEYS = {
    "latitude", "longitude", "coordinates", "address", "searched_address",
    "snap_results", "retailers", "price_results", "comparison_results",
    "access_token", "token", "credentials", "password", "password_hash",
}


class StoreError(ValueError):
    pass


class AccountStore:
    def __init__(self, database_path: str | Path):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self):
        class ClosingConnection(sqlite3.Connection):
            def __exit__(self, exc_type, exc_value, traceback):
                try:
                    return super().__exit__(exc_type, exc_value, traceback)
                finally:
                    self.close()
        connection = sqlite3.connect(self.path, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self):
        with self.connect() as database:
            database.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    first_name TEXT NOT NULL DEFAULT '',
                    last_name TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS saved_items (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('grocery_plan','meal_plan','shopping_list')),
                    name TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS saved_items_owner_kind ON saved_items(user_id, kind);
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS password_reset_requests (
                    request_key TEXT NOT NULL,
                    requested_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS password_reset_request_key ON password_reset_requests(request_key, requested_at);
            """)
            columns = {row["name"] for row in database.execute("PRAGMA table_info(users)")}
            if "last_name" not in columns:
                database.execute("ALTER TABLE users ADD COLUMN last_name TEXT")
            if "session_version" not in columns:
                database.execute("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0")

    @staticmethod
    def normalize_email(value) -> str:
        email = str(value or "").strip().casefold()
        if len(email) > 254 or not EMAIL_RE.fullmatch(email):
            raise StoreError("Enter a valid email address.")
        return email

    @staticmethod
    def validate_password(value, label="Password") -> str:
        if not isinstance(value, str) or len(value) < 10:
            raise StoreError(f"{label} must be at least 10 characters.")
        if len(value) > 512:
            raise StoreError(f"{label} is too long.")
        return value

    @staticmethod
    def validate_name(value, default="Saved item") -> str:
        name = str(value or default).strip()
        if not name or len(name) > 80:
            raise StoreError("Name must be between 1 and 80 characters.")
        return name

    @staticmethod
    def _contains_forbidden(value) -> bool:
        if isinstance(value, dict):
            return any(str(key).casefold() in FORBIDDEN_KEYS or AccountStore._contains_forbidden(item) for key, item in value.items())
        if isinstance(value, list):
            return any(AccountStore._contains_forbidden(item) for item in value)
        return False

    @classmethod
    def validate_data(cls, value) -> dict:
        if not isinstance(value, dict):
            raise StoreError("Saved content must be a JSON object.")
        if cls._contains_forbidden(value):
            raise StoreError("Location, authentication, and temporary comparison data cannot be saved.")
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 500_000:
            raise StoreError("Saved content is too large.")
        return value

    @staticmethod
    def validate_profile_names(first_name, last_name="") -> tuple[str, str]:
        first = str(first_name or "").strip()
        last = str(last_name or "").strip()
        if not first:
            raise StoreError("First name is required.")
        if len(first) > 60:
            raise StoreError("First name must be 60 characters or fewer.")
        if len(last) > 60:
            raise StoreError("Last name must be 60 characters or fewer.")
        return first, last

    def create_user(self, email, password, first_name, last_name="") -> dict:
        normalized = self.normalize_email(email)
        password = self.validate_password(password)
        first_name, last_name = self.validate_profile_names(first_name, last_name)
        now = datetime.now(timezone.utc).isoformat()
        try:
            with self.connect() as database:
                cursor = database.execute(
                    "INSERT INTO users(email,password_hash,first_name,last_name,created_at) VALUES(?,?,?,?,?)",
                    (normalized, generate_password_hash(password), first_name, last_name, now),
                )
                user_id = cursor.lastrowid
        except sqlite3.IntegrityError as error:
            raise StoreError("An account with that email already exists.") from error
        return {"id": user_id, "email": normalized, "first_name": first_name, "last_name": last_name, "created_at": now}

    def authenticate(self, email, password) -> dict | None:
        try:
            normalized = self.normalize_email(email)
        except StoreError:
            return None
        with self.connect() as database:
            row = database.execute("SELECT * FROM users WHERE email=?", (normalized,)).fetchone()
        if not row or not isinstance(password, str) or not check_password_hash(row["password_hash"], password):
            return None
        return {**self.public_user(row), "session_version": row["session_version"]}

    @staticmethod
    def public_user(row) -> dict:
        return {key: row[key] for key in ("id", "email", "first_name", "last_name", "created_at")}

    def get_user(self, user_id) -> dict | None:
        with self.connect() as database:
            row = database.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return self.public_user(row) if row else None

    def get_session_user(self, user_id, version) -> dict | None:
        with self.connect() as database:
            row = database.execute("SELECT * FROM users WHERE id=? AND session_version=?", (user_id, version)).fetchone()
        return self.public_user(row) if row else None

    def allow_password_reset_request(self, email, remote_address, now=None) -> bool:
        now = time.time() if now is None else now
        limits = [("email:" + email, 3), ("ip:" + remote_address, 20)]
        keys = [(hashlib.sha256(key.encode()).hexdigest(), limit) for key, limit in limits]
        with self.connect() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute("DELETE FROM password_reset_requests WHERE requested_at<=?", (now - 3600,))
            for key, limit in keys:
                count = database.execute("SELECT COUNT(*) FROM password_reset_requests WHERE request_key=?", (key,)).fetchone()[0]
                if count >= limit:
                    return False
            database.executemany("INSERT INTO password_reset_requests VALUES(?,?)", [(key, now) for key, _ in keys])
        return True

    def create_password_reset(self, email, now=None) -> tuple[str, str] | None:
        normalized = self.normalize_email(email)
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT id,email FROM users WHERE email=?", (normalized,)).fetchone()
            database.execute("DELETE FROM password_reset_tokens WHERE expires_at<=?", (now,))
            if not row:
                return None
            database.execute("DELETE FROM password_reset_tokens WHERE user_id=?", (row["id"],))
            database.execute("INSERT INTO password_reset_tokens VALUES(?,?,?)", (digest, row["id"], now + 1800))
        return row["email"], token

    def reset_password(self, token, password, now=None):
        password = self.validate_password(password, "New password")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise StoreError("This reset link is invalid or expired. Request a new link.")
        now = time.time() if now is None else now
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT user_id FROM password_reset_tokens WHERE token_hash=? AND expires_at>?", (digest, now)).fetchone()
            if not row:
                raise StoreError("This reset link is invalid or expired. Request a new link.")
            database.execute("UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?", (generate_password_hash(password), row["user_id"]))
            database.execute("DELETE FROM password_reset_tokens WHERE user_id=?", (row["user_id"],))

    def update_profile(self, user_id, first_name, last_name="") -> dict:
        first_name, last_name = self.validate_profile_names(first_name, last_name)
        with self.connect() as database:
            database.execute("UPDATE users SET first_name=?,last_name=? WHERE id=?", (first_name, last_name, user_id))
        return self.get_user(user_id)

    def change_password(self, user_id, current, new):
        new = self.validate_password(new, "New password")
        with self.connect() as database:
            row = database.execute("SELECT password_hash FROM users WHERE id=?", (user_id,)).fetchone()
            if not row or not isinstance(current, str) or not check_password_hash(row["password_hash"], current):
                raise StoreError("Current password is incorrect.")
            database.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new), user_id))
            database.execute("DELETE FROM password_reset_tokens WHERE user_id=?", (user_id,))

    def delete_user(self, user_id):
        with self.connect() as database:
            database.execute("DELETE FROM users WHERE id=?", (user_id,))

    def save_item(self, user_id, kind, name, data) -> dict:
        if kind not in KINDS:
            raise StoreError("Saved item type is unsupported.")
        name, data = self.validate_name(name), self.validate_data(data)
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as database:
            cursor = database.execute(
                "INSERT INTO saved_items(user_id,kind,name,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (user_id, kind, name, json.dumps(data, ensure_ascii=False), now, now),
            )
            item_id = cursor.lastrowid
        return self.get_item(user_id, item_id)

    def list_items(self, user_id, kind=None) -> list[dict]:
        parameters, where = [user_id], "user_id=?"
        if kind:
            if kind not in KINDS:
                raise StoreError("Saved item type is unsupported.")
            where += " AND kind=?"; parameters.append(kind)
        with self.connect() as database:
            rows = database.execute(f"SELECT * FROM saved_items WHERE {where} ORDER BY updated_at DESC", parameters).fetchall()
        return [self.public_item(row, include_data=False) for row in rows]

    def get_item(self, user_id, item_id) -> dict | None:
        with self.connect() as database:
            row = database.execute("SELECT * FROM saved_items WHERE id=? AND user_id=?", (item_id, user_id)).fetchone()
        return self.public_item(row) if row else None

    @staticmethod
    def public_item(row, include_data=True) -> dict:
        item = {key: row[key] for key in ("id", "kind", "name", "created_at", "updated_at")}
        if include_data:
            item["data"] = json.loads(row["data_json"])
        else:
            data = json.loads(row["data_json"])
            item["summary"] = data.get("summary", {}) if isinstance(data, dict) else {}
        return item

    def rename_item(self, user_id, item_id, name) -> dict | None:
        name = self.validate_name(name)
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as database:
            cursor = database.execute("UPDATE saved_items SET name=?,updated_at=? WHERE id=? AND user_id=?", (name, now, item_id, user_id))
        return self.get_item(user_id, item_id) if cursor.rowcount else None

    def delete_item(self, user_id, item_id) -> bool:
        with self.connect() as database:
            cursor = database.execute("DELETE FROM saved_items WHERE id=? AND user_id=?", (item_id, user_id))
        return bool(cursor.rowcount)
