"""Campus Wallet local test server: Flask + SQLite. No real payments."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import ssl
import socket
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from flask import Flask, g, jsonify, request, send_file, send_from_directory

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DATA_DIR = REPO / "data"
DB_PATH = DATA_DIR / "campus_wallet.sqlite"
STATIC = ROOT / "static"
ADMIN_KEY = os.environ.get("ADMIN_KEY", "change-me-admin-key")
JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-local-only").encode()
TEST_MODE = os.environ.get("TEST_MODE", "true").lower() == "true"
QR_TTL = int(os.environ.get("QR_TTL_SECONDS", "45"))
PORT = int(os.environ.get("PORT", "3000"))
HTTPS = os.environ.get("HTTPS", "false").lower() == "true"
TLS_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Campus Wallet" / "tls"
CA_CERT_PATH = TLS_DIR / "campus-wallet-local-ca.crt"
CA_KEY_PATH = TLS_DIR / "campus-wallet-local-ca.key"
SERVER_CERT_PATH = TLS_DIR / "campus-wallet-server.crt"
SERVER_KEY_PATH = TLS_DIR / "campus-wallet-server.key"

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_tls_certificates() -> None:
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    regenerate_ca = not (CA_CERT_PATH.exists() and CA_KEY_PATH.exists())
    if not regenerate_ca:
        ca_key = serialization.load_pem_private_key(CA_KEY_PATH.read_bytes(), password=None)
        ca_cert = x509.load_pem_x509_certificate(CA_CERT_PATH.read_bytes())
        try:
            ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier)
            ca_cert.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier)
            ca_cert.extensions.get_extension_for_class(x509.KeyUsage)
        except x509.ExtensionNotFound:
            regenerate_ca = True

    if regenerate_ca:
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Campus Wallet Local CA")])
        now = datetime.now(timezone.utc)
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_name)
            .issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now)
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
            )
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=None,
                    decipher_only=None,
                ),
                critical=True,
            )
            .sign(ca_key, hashes.SHA256())
        )
        CA_KEY_PATH.write_bytes(
            ca_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        CA_CERT_PATH.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))

    addresses = {ipaddress.ip_address("127.0.0.1")}
    configured_ip = os.environ.get("LAN_IP", "").strip()
    if configured_ip:
        addresses.add(ipaddress.ip_address(configured_ip))
    else:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = ipaddress.ip_address(result[4][0])
            if not address.is_loopback:
                addresses.add(address)

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Campus Wallet Local Server")])
    now = datetime.now(timezone.utc)
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(address) for address in addresses]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    SERVER_KEY_PATH.write_bytes(
        server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    SERVER_CERT_PATH.write_bytes(server_cert.public_bytes(serialization.Encoding.PEM))


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK (role IN ('student', 'merchant')),
          college_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          pin_hash TEXT NOT NULL,
                    photo_data TEXT,
          frozen INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ledger_entries (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts (id),
          amount_paise INTEGER NOT NULL,
          entry_type TEXT NOT NULL,
          related_account_id TEXT,
          note TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          sender_account_id TEXT NOT NULL REFERENCES accounts (id),
          recipient_account_id TEXT NOT NULL REFERENCES accounts (id),
          body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chat_messages_participants_created
          ON chat_messages (sender_account_id, recipient_account_id, created_at);
        CREATE TABLE IF NOT EXISTS qr_tokens (
          id TEXT PRIMARY KEY,
          student_id TEXT NOT NULL REFERENCES accounts (id),
          token TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nfc_sessions (
          token_hash TEXT PRIMARY KEY,
          student_id TEXT NOT NULL REFERENCES accounts (id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    seed_demo(conn)


def ensure_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'ledger_entries', 'qr_tokens')"
        ).fetchall()
        if len(tables) < 3:
            init_db(conn)
        else:
            seed_demo(conn)
        account_columns = {row['name'] for row in conn.execute('PRAGMA table_info(accounts)')}
        if 'photo_data' not in account_columns:
            conn.execute('ALTER TABLE accounts ADD COLUMN photo_data TEXT')
            conn.commit()
        conn.execute(
            """CREATE TABLE IF NOT EXISTS nfc_sessions (
                 token_hash TEXT PRIMARY KEY,
                 student_id TEXT NOT NULL REFERENCES accounts (id),
                 expires_at TEXT NOT NULL,
                 created_at TEXT NOT NULL
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS chat_messages (
                 id TEXT PRIMARY KEY,
                 sender_account_id TEXT NOT NULL REFERENCES accounts (id),
                 recipient_account_id TEXT NOT NULL REFERENCES accounts (id),
                 body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
                 created_at TEXT NOT NULL
               )"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS chat_messages_participants_created
               ON chat_messages (sender_account_id, recipient_account_id, created_at)"""
        )
        conn.commit()
    finally:
        conn.close()


def hash_pin(pin: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), 120_000).hex()
    return f"pbkdf2${salt}${digest}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), 120_000).hex()
    return hmac.compare_digest(check, digest)


def seed_demo(conn: sqlite3.Connection) -> None:
    demo = [
        ("student", "STU1001", "Alex Test", "1234"),
        ("student", "STU1002", "Jordan Demo", "1234"),
        ("merchant", "CANTEEN1", "Main Canteen", "1234"),
    ]
    for role, college_id, name, pin in demo:
        row = conn.execute("SELECT id FROM accounts WHERE college_id = ?", (college_id,)).fetchone()
        if row:
            continue
        conn.execute(
            """INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen, created_at)
               VALUES (?, ?, ?, ?, ?, 0, ?)""",
            (str(uuid.uuid4()), role, college_id, name, hash_pin(pin), utcnow()),
        )
    conn.commit()


ensure_database()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_err: object) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def base64_urlsafe(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(text: str) -> bytes:
    import base64

    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def sign_token(account: sqlite3.Row) -> str:
    payload = {
        "sub": account["id"],
        "role": account["role"],
        "collegeId": account["college_id"],
        "exp": int(time.time()) + 12 * 3600,
    }
    body = base64_urlsafe(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(JWT_SECRET, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_token(header: str | None) -> dict:
    if not header or not header.startswith("Bearer "):
        raise ApiError(401, "Missing bearer token")
    raw = header[7:]
    try:
        body, sig = raw.split(".", 1)
    except ValueError as exc:
        raise ApiError(401, "Invalid or expired token") from exc
    expect = hmac.new(JWT_SECRET, body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        raise ApiError(401, "Invalid or expired token")
    payload = json.loads(b64url_decode(body))
    if payload.get("exp", 0) < time.time():
        raise ApiError(401, "Invalid or expired token")
    return payload


def assert_college_id(college_id: str) -> str:
    cleaned = str(college_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{3,32}", cleaned):
        raise ApiError(400, "collegeId must be 3-32 letters or digits")
    return cleaned.upper()


def assert_pin(pin: str) -> str:
    cleaned = str(pin or "").strip()
    if not re.fullmatch(r"\d{4,8}", cleaned):
        raise ApiError(400, "PIN must be 4 to 8 digits")
    return cleaned


def parse_amount_paise(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ApiError(400, f"{label} must be a positive integer")
    if isinstance(value, int):
        amount = value
    elif isinstance(value, str):
        cleaned = value.strip()
        if not re.fullmatch(r"\d+", cleaned):
            raise ApiError(400, f"{label} must be a positive integer")
        amount = int(cleaned)
    else:
        try:
            amount = int(value)
        except (TypeError, ValueError) as exc:
            raise ApiError(400, f"{label} must be a positive integer") from exc
    if amount <= 0:
        raise ApiError(400, f"{label} must be a positive integer")
    return amount


def assert_photo_data(photo_data: str | None) -> str | None:
    if not photo_data:
        return None
    if len(photo_data) > 350_000 or not re.fullmatch(
        r"data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}", photo_data
    ):
        raise ApiError(400, "Profile photo must be a small JPEG, PNG, or WebP image")
    return photo_data


def balance_paise(db: sqlite3.Connection, account_id: str) -> int:
    row = db.execute(
        "SELECT COALESCE(SUM(amount_paise), 0) AS balance FROM ledger_entries WHERE account_id = ?",
        (account_id,),
    ).fetchone()
    return int(row["balance"])


def public_account(row: sqlite3.Row, bal: int) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "collegeId": row["college_id"],
        "name": row["name"],
        "photoData": row["photo_data"],
        "frozen": bool(row["frozen"]),
        "balancePaise": bal,
        "testMode": True,
    }


def json_body() -> dict:
    return request.get_json(silent=True) or {}


def student_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        payload = read_token(request.headers.get("Authorization"))
        if payload.get("role") != "student":
            raise ApiError(403, "Wrong account role")
        g.auth = payload
        return fn(*args, **kwargs)

    return wrapper


def merchant_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        payload = read_token(request.headers.get("Authorization"))
        if payload.get("role") != "merchant":
            raise ApiError(403, "Wrong account role")
        g.auth = payload
        return fn(*args, **kwargs)

    return wrapper


def admin_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        authorization = request.headers.get("Authorization")
        if authorization:
            payload = read_token(authorization)
            if payload.get("role") != "admin":
                raise ApiError(403, "Wrong account role")
            g.auth = payload
        elif not hmac.compare_digest(request.headers.get("x-admin-key", ""), ADMIN_KEY):
            raise ApiError(401, "Invalid credentials")
        return fn(*args, **kwargs)

    return wrapper


@app.errorhandler(ApiError)
def on_api_error(err: ApiError):
    return jsonify({"error": err.message, "testMode": TEST_MODE}), err.status


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/admin/")
def admin_page():
    return send_from_directory(STATIC, "index.html")


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "testMode": TEST_MODE,
            "realPayments": False,
            "service": "campus-wallet",
            "version": "1-test",
            "store": "sqlite",
        }
    )


@app.get("/local-ca.crt")
def local_ca_certificate():
    return send_file(
        CA_CERT_PATH,
        mimetype="application/x-x509-ca-cert",
        as_attachment=True,
        download_name="campus-wallet-local-ca.crt",
    )


@app.post("/students/signup")
def student_signup():
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    pin = assert_pin(body.get("pin", ""))
    name = str(body.get("name") or "").strip()
    if len(name) < 2 or len(name) > 80:
        raise ApiError(400, "name must be 2-80 characters")
    db = get_db()
    if db.execute("SELECT id FROM accounts WHERE college_id = ?", (college_id,)).fetchone():
        raise ApiError(409, "collegeId already registered")
    account_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen, created_at)
           VALUES (?, 'student', ?, ?, ?, 0, ?)""",
        (account_id, college_id, name, hash_pin(pin), utcnow()),
    )
    db.commit()
    row = db.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    return jsonify({"token": sign_token(row), "account": public_account(row, 0)}), 201


def login_role(role: str):
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    pin = assert_pin(body.get("pin", ""))
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE college_id = ? AND role = ?",
        (college_id, role),
    ).fetchone()
    if not row or not verify_pin(pin, row["pin_hash"]):
        raise ApiError(401, f"Unknown {role} or wrong PIN")
    return jsonify(
        {"token": sign_token(row), "account": public_account(row, balance_paise(db, row["id"]))}
    )


@app.post("/students/login")
def student_login():
    return login_role("student")


@app.post("/merchants/login")
def merchant_login():
    return login_role("merchant")


@app.post("/login")
def unified_login():
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    pin = str(body.get("pin") or "")
    if college_id == "ADMIN":
        if not hmac.compare_digest(pin, ADMIN_KEY):
            raise ApiError(401, "Invalid ID or password")
        admin_account = {"id": "admin", "role": "admin", "college_id": "ADMIN"}
        return jsonify({"token": sign_token(admin_account), "role": "admin"})

    assert_pin(pin)
    db = get_db()
    row = db.execute("SELECT * FROM accounts WHERE college_id = ?", (college_id,)).fetchone()
    if not row or not verify_pin(pin, row["pin_hash"]):
        raise ApiError(401, "Invalid ID or password")
    return jsonify({
        "token": sign_token(row),
        "role": row["role"],
        "account": public_account(row, balance_paise(db, row["id"])),
    })


@app.get("/students/me")
@student_auth
def student_me():
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE id = ? AND role = 'student'", (g.auth["sub"],)
    ).fetchone()
    if not row:
        raise ApiError(404, "Student not found")
    return jsonify(public_account(row, balance_paise(db, row["id"])))


@app.post("/students/balance")
@student_auth
def student_balance():
    body = json_body()
    pin = assert_pin(body.get("pin", ""))
    db = get_db()
    row = db.execute(
        "SELECT pin_hash FROM accounts WHERE id = ? AND role = 'student'",
        (g.auth["sub"],),
    ).fetchone()
    if not row or not verify_pin(pin, row["pin_hash"]):
        raise ApiError(401, "Wrong PIN")
    return jsonify({"balancePaise": balance_paise(db, g.auth["sub"])})


@app.get("/students/directory")
@student_auth
def student_directory():
    query = request.args.get("q", "").strip()[:80]
    db = get_db()
    rows = db.execute(
        """SELECT id, college_id, name, photo_data
           FROM accounts
           WHERE role = 'student' AND frozen = 0 AND id != ?
             AND (? = '' OR instr(lower(name), lower(?)) > 0
                  OR instr(lower(college_id), lower(?)) > 0)
           ORDER BY name COLLATE NOCASE, college_id
           LIMIT 30""",
        (g.auth["sub"], query, query, query),
    ).fetchall()
    return jsonify({
        "students": [
            {
                "collegeId": row["college_id"],
                "name": row["name"],
                "photoData": row["photo_data"],
            }
            for row in rows
        ]
    })


@app.get("/students/chat/<college_id>")
@student_auth
def student_chat(college_id: str):
    friend_id = assert_college_id(college_id)
    db = get_db()
    friend = db.execute(
        """SELECT id, college_id, name, photo_data
           FROM accounts WHERE college_id = ? AND role = 'student'""",
        (friend_id,),
    ).fetchone()
    if not friend or friend["id"] == g.auth["sub"]:
        raise ApiError(404, "Student not found")

    messages = db.execute(
        """SELECT id, sender_account_id, body, created_at
           FROM chat_messages
           WHERE (sender_account_id = ? AND recipient_account_id = ?)
              OR (sender_account_id = ? AND recipient_account_id = ?)
           ORDER BY created_at, id""",
        (g.auth["sub"], friend["id"], friend["id"], g.auth["sub"]),
    ).fetchall()
    payments = db.execute(
        """SELECT id, amount_paise, entry_type, note, created_at
           FROM ledger_entries
           WHERE account_id = ? AND related_account_id = ?
             AND entry_type IN (
               'student_transfer_out', 'student_transfer_in',
               'nfc_transfer_out', 'nfc_transfer_in'
             )
           ORDER BY created_at, id""",
        (g.auth["sub"], friend["id"]),
    ).fetchall()

    timeline = [
        {
            "id": row["id"],
            "type": "message",
            "senderId": row["sender_account_id"],
            "body": row["body"],
            "createdAt": row["created_at"],
        }
        for row in messages
    ]
    timeline.extend(
        {
            "id": row["id"],
            "type": "payment",
            "direction": "out" if row["entry_type"].endswith("_out") else "in",
            "amountPaise": abs(row["amount_paise"]),
            "note": row["note"] or "",
            "createdAt": row["created_at"],
        }
        for row in payments
    )
    return jsonify(
        {
            "friend": {
                "collegeId": friend["college_id"],
                "name": friend["name"],
                "photoData": friend["photo_data"],
            },
            "messages": timeline,
        }
    )


@app.post("/students/messages")
@student_auth
def student_send_message():
    body = json_body()
    recipient_id = assert_college_id(body.get("collegeId", ""))
    message = body.get("message")
    if not isinstance(message, str):
        raise ApiError(400, "message is required")
    message = message.strip()
    if not message or len(message) > 1000:
        raise ApiError(400, "message must be 1-1000 characters")

    db = get_db()
    sender = db.execute(
        "SELECT id FROM accounts WHERE id = ? AND role = 'student'",
        (g.auth["sub"],),
    ).fetchone()
    recipient = db.execute(
        "SELECT id FROM accounts WHERE college_id = ? AND role = 'student'",
        (recipient_id,),
    ).fetchone()
    if not sender or not recipient:
        raise ApiError(404, "Student not found")
    if sender["id"] == recipient["id"]:
        raise ApiError(400, "You cannot message yourself")

    created_at = utcnow()
    message_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO chat_messages
           (id, sender_account_id, recipient_account_id, body, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (message_id, sender["id"], recipient["id"], message, created_at),
    )
    db.commit()
    return jsonify(
        {
            "id": message_id,
            "senderId": sender["id"],
            "body": message,
            "createdAt": created_at,
        }
    ), 201


@app.post("/students/nfc/session")
@student_auth
def student_nfc_session():
    if not TEST_MODE:
        raise ApiError(403, "NFC transfers are available only in local test mode")
    db = get_db()
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    created = datetime.now(timezone.utc)
    expires = created + timedelta(minutes=2)
    db.execute("BEGIN IMMEDIATE")
    try:
        student = db.execute(
            "SELECT id, frozen FROM accounts WHERE id = ? AND role = 'student'",
            (g.auth["sub"],),
        ).fetchone()
        if not student:
            raise ApiError(404, "Student not found")
        if student["frozen"]:
            raise ApiError(403, "Your wallet is frozen")
        db.execute("DELETE FROM nfc_sessions WHERE expires_at <= ?", (created.isoformat(),))
        db.execute("DELETE FROM nfc_sessions WHERE student_id = ?", (student["id"],))
        db.execute(
            """INSERT INTO nfc_sessions (token_hash, student_id, expires_at, created_at)
               VALUES (?, ?, ?, ?)""",
            (token_hash, student["id"], expires.isoformat(), created.isoformat()),
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({"token": token, "expiresAt": expires.isoformat()})


@app.post("/students/nfc/transfer")
@student_auth
def student_nfc_transfer():
    if not TEST_MODE:
        raise ApiError(403, "NFC transfers are available only in local test mode")
    body = json_body()
    recipient_token = body.get("recipientToken")
    if not isinstance(recipient_token, str) or not 20 <= len(recipient_token) <= 100:
        raise ApiError(400, "recipientToken is invalid")
    amount = parse_amount_paise(body.get("amountPaise"), "amountPaise")
    if amount > 50_000:
        raise ApiError(400, "NFC transfers are limited to ₹500 per tap")
    note = str(body.get("note") or "").strip()
    if len(note) > 100:
        raise ApiError(400, "note must be 100 characters or fewer")

    token_hash = hashlib.sha256(recipient_token.encode()).hexdigest()
    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        session = db.execute(
            "SELECT * FROM nfc_sessions WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
        now = datetime.now(timezone.utc)
        if not session or datetime.fromisoformat(session["expires_at"]) <= now:
            raise ApiError(410, "NFC receive session expired; ask the recipient to tap again")

        sender = db.execute(
            "SELECT * FROM accounts WHERE id = ? AND role = 'student'",
            (g.auth["sub"],),
        ).fetchone()
        recipient = db.execute(
            "SELECT * FROM accounts WHERE id = ? AND role = 'student'",
            (session["student_id"],),
        ).fetchone()
        if not sender or not recipient:
            raise ApiError(404, "Student not found")
        if sender["frozen"]:
            raise ApiError(403, "Your wallet is frozen")
        if recipient["frozen"]:
            raise ApiError(403, "That student's wallet is frozen")
        if sender["id"] == recipient["id"]:
            raise ApiError(400, "You cannot send money to yourself")

        spent_today = db.execute(
            """SELECT COALESCE(SUM(-amount_paise), 0) AS total
               FROM ledger_entries
               WHERE account_id = ? AND entry_type = 'nfc_transfer_out'
                 AND date(created_at) = date('now')""",
            (sender["id"],),
        ).fetchone()["total"]
        if spent_today + amount > 200_000:
            raise ApiError(400, "NFC transfers are limited to ₹2,000 per day")

        sender_balance = balance_paise(db, sender["id"])
        if sender_balance < amount:
            raise ApiError(400, "Insufficient test balance")

        created_at = utcnow()
        db.executemany(
            """INSERT INTO ledger_entries
               (id, account_id, amount_paise, entry_type, related_account_id, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    str(uuid.uuid4()), sender["id"], -amount, "nfc_transfer_out",
                    recipient["id"], f"To {recipient['name']} · NFC",
                    created_at,
                ),
                (
                    str(uuid.uuid4()), recipient["id"], amount, "nfc_transfer_in",
                    sender["id"], f"From {sender['name']} · NFC",
                    created_at,
                ),
            ],
        )
        db.execute("DELETE FROM nfc_sessions WHERE token_hash = ?", (token_hash,))
        db.commit()
    except Exception:
        db.rollback()
        raise

    return jsonify({
        "ok": True,
        "amountPaise": amount,
        "recipient": {
            "collegeId": recipient["college_id"],
            "name": recipient["name"],
        },
        "balancePaise": balance_paise(db, sender["id"]),
    })


@app.post("/students/transfer")
@student_auth
def student_transfer():
    if not TEST_MODE:
        raise ApiError(403, "Student transfers are available only in local test mode")
    body = json_body()
    recipient_id = assert_college_id(body.get("collegeId", ""))
    pin = assert_pin(body.get("pin", ""))
    amount = parse_amount_paise(body.get("amountPaise"), "amountPaise")
    note = str(body.get("note") or "").strip()
    if len(note) > 100:
        raise ApiError(400, "note must be 100 characters or fewer")

    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        sender = db.execute(
            "SELECT * FROM accounts WHERE id = ? AND role = 'student'",
            (g.auth["sub"],),
        ).fetchone()
        if not sender or not verify_pin(pin, sender["pin_hash"]):
            raise ApiError(401, "Wrong PIN")
        if sender["frozen"]:
            raise ApiError(403, "Your wallet is frozen")

        recipient = db.execute(
            "SELECT * FROM accounts WHERE college_id = ? AND role = 'student'",
            (recipient_id,),
        ).fetchone()
        if not recipient:
            raise ApiError(404, "Student not found")
        if recipient["id"] == sender["id"]:
            raise ApiError(400, "You cannot send money to yourself")
        if recipient["frozen"]:
            raise ApiError(403, "That student's wallet is frozen")

        sender_balance = balance_paise(db, sender["id"])
        if sender_balance < amount:
            raise ApiError(400, "Insufficient test balance")

        created_at = utcnow()
        transfer_note = note or f"To {recipient['name']}"
        db.executemany(
            """INSERT INTO ledger_entries
               (id, account_id, amount_paise, entry_type, related_account_id, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    str(uuid.uuid4()), sender["id"], -amount, "student_transfer_out",
                    recipient["id"], f"To {recipient['name']}" + (f" · {note}" if note else ""),
                    created_at,
                ),
                (
                    str(uuid.uuid4()), recipient["id"], amount, "student_transfer_in",
                    sender["id"], f"From {sender['name']}" + (f" · {note}" if note else ""),
                    created_at,
                ),
            ],
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return jsonify({
        "ok": True,
        "amountPaise": amount,
        "recipient": {
            "collegeId": recipient["college_id"],
            "name": recipient["name"],
        },
        "balancePaise": balance_paise(db, sender["id"]),
        "note": transfer_note,
    })


@app.post("/students/test-topup")
@student_auth
def student_topup():
    if not TEST_MODE:
        raise ApiError(403, "Test top-up disabled; real payments are not connected")
    body = json_body()
    amount = int(body.get("amountPaise") or 10000)
    if amount <= 0 or amount > 100000:
        raise ApiError(400, "amountPaise must be 1-100000")
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE id = ? AND role = 'student'", (g.auth["sub"],)
    ).fetchone()
    if not row:
        raise ApiError(404, "Student not found")
    if row["frozen"]:
        raise ApiError(403, "Account is frozen")
    db.execute(
        """INSERT INTO ledger_entries (id, account_id, amount_paise, entry_type, related_account_id, note, created_at)
           VALUES (?, ?, ?, 'test_topup', NULL, ?, ?)""",
        (
            str(uuid.uuid4()),
            row["id"],
            amount,
            "Wallet top-up",
            utcnow(),
        ),
    )
    db.commit()
    fresh = db.execute("SELECT * FROM accounts WHERE id = ?", (row["id"],)).fetchone()
    return jsonify(
        {"ok": True, "creditedPaise": amount, "account": public_account(fresh, balance_paise(db, row["id"]))}
    )


@app.get("/students/qr")
@student_auth
def student_qr():
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE id = ? AND role = 'student'", (g.auth["sub"],)
    ).fetchone()
    if not row:
        raise ApiError(404, "Student not found")
    if row["frozen"]:
        raise ApiError(403, "Account is frozen")
    token = "CW1." + secrets.token_urlsafe(18)
    exp = datetime.now(timezone.utc).timestamp() + QR_TTL
    expires_at = datetime.fromtimestamp(exp, timezone.utc).isoformat()
    db.execute(
        """INSERT INTO qr_tokens (id, student_id, token, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (str(uuid.uuid4()), row["id"], token, expires_at, utcnow()),
    )
    db.commit()
    return jsonify({"token": token, "expiresAt": expires_at, "ttlSeconds": QR_TTL})


@app.post("/students/freeze")
@student_auth
def student_freeze():
    body = json_body()
    pin = assert_pin(body.get("pin", ""))
    frozen = bool(body.get("frozen"))
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE id = ? AND role = 'student'", (g.auth["sub"],)
    ).fetchone()
    if not row or not verify_pin(pin, row["pin_hash"]):
        raise ApiError(401, "Wrong PIN")
    db.execute("UPDATE accounts SET frozen = ? WHERE id = ?", (1 if frozen else 0, row["id"]))
    db.commit()
    fresh = db.execute("SELECT * FROM accounts WHERE id = ?", (row["id"],)).fetchone()
    return jsonify(public_account(fresh, balance_paise(db, fresh["id"])))


@app.get("/students/ledger")
@student_auth
def student_ledger():
    db = get_db()
    rows = db.execute(
        """SELECT id, amount_paise, entry_type, note, created_at
           FROM ledger_entries WHERE account_id = ?
           ORDER BY created_at DESC LIMIT 100""",
        (g.auth["sub"],),
    ).fetchall()
    return jsonify({"entries": [dict(r) for r in rows]})


@app.get("/merchants/me")
@merchant_auth
def merchant_me():
    db = get_db()
    row = db.execute(
        "SELECT * FROM accounts WHERE id = ? AND role = 'merchant'", (g.auth["sub"],)
    ).fetchone()
    if not row:
        raise ApiError(404, "Merchant not found")
    return jsonify(public_account(row, balance_paise(db, row["id"])))


@app.post("/merchants/charge")
@merchant_auth
def merchant_charge():
    body = json_body()
    token = str(body.get("token") or "").strip()
    try:
        amount = int(body.get("amountPaise"))
    except (TypeError, ValueError) as exc:
        raise ApiError(400, "amountPaise must be a positive integer") from exc
    if not token:
        raise ApiError(400, "token is required")
    if amount <= 0:
        raise ApiError(400, "amountPaise must be a positive integer")
    db = get_db()
    try:
        db.execute("BEGIN IMMEDIATE")
        merchant = db.execute(
            "SELECT * FROM accounts WHERE id = ? AND role = 'merchant'", (g.auth["sub"],)
        ).fetchone()
        if not merchant:
            raise ApiError(404, "Merchant not found")
        qr = db.execute("SELECT * FROM qr_tokens WHERE token = ?", (token,)).fetchone()
        if not qr:
            raise ApiError(400, "Unknown QR token")
        if qr["expires_at"] < utcnow():
            raise ApiError(400, "QR expired — ask the student to refresh")
        student = db.execute(
            "SELECT * FROM accounts WHERE id = ? AND role = 'student'", (qr["student_id"],)
        ).fetchone()
        if not student:
            raise ApiError(400, "Student account missing")
        if student["frozen"]:
            raise ApiError(403, "Student account is frozen")
        bal = balance_paise(db, student["id"])
        if bal < amount:
            raise ApiError(400, "Insufficient test balance")
        db.execute(
            """INSERT INTO ledger_entries (id, account_id, amount_paise, entry_type, related_account_id, note, created_at)
               VALUES (?, ?, ?, 'qr_payment', ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                student["id"],
                -amount,
                merchant["id"],
                f"Pay {merchant['college_id']}",
                utcnow(),
            ),
        )
        db.execute(
            """INSERT INTO ledger_entries (id, account_id, amount_paise, entry_type, related_account_id, note, created_at)
               VALUES (?, ?, ?, 'qr_sale', ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                merchant["id"],
                amount,
                student["id"],
                f"From {student['college_id']}",
                utcnow(),
            ),
        )
        db.commit()
    except ApiError:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    return jsonify(
        {
            "ok": True,
            "chargedPaise": amount,
            "fromCollegeId": student["college_id"],
            "studentBalancePaise": bal - amount,
            "testMode": True,
        }
    )


@app.get("/merchants/ledger")
@merchant_auth
def merchant_ledger():
    db = get_db()
    rows = db.execute(
        """SELECT id, amount_paise, entry_type, note, created_at
           FROM ledger_entries WHERE account_id = ?
           ORDER BY created_at DESC LIMIT 100""",
        (g.auth["sub"],),
    ).fetchall()
    return jsonify({"entries": [dict(r) for r in rows]})


@app.post("/admin/create-merchant")
@admin_auth
def admin_create_merchant():
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    pin = assert_pin(body.get("pin", ""))
    name = str(body.get("name") or "").strip()
    if len(name) < 2:
        raise ApiError(400, "name is required")
    db = get_db()
    if db.execute("SELECT id FROM accounts WHERE college_id = ?", (college_id,)).fetchone():
        raise ApiError(409, "Merchant collegeId already exists")
    account_id = str(uuid.uuid4())
    db.execute(
        """INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen, created_at)
           VALUES (?, 'merchant', ?, ?, ?, 0, ?)""",
        (account_id, college_id, name, hash_pin(pin), utcnow()),
    )
    db.commit()
    return jsonify(
        {"ok": True, "merchant": {"id": account_id, "collegeId": college_id, "name": name, "testMode": True}}
    ), 201


@app.get("/admin/summary")
@admin_auth
def admin_summary():
    db = get_db()
    students = db.execute("SELECT COUNT(*) AS n FROM accounts WHERE role = 'student'").fetchone()["n"]
    merchants = db.execute("SELECT COUNT(*) AS n FROM accounts WHERE role = 'merchant'").fetchone()["n"]
    frozen = db.execute("SELECT COUNT(*) AS n FROM accounts WHERE frozen = 1").fetchone()["n"]
    sales = db.execute(
        "SELECT COALESCE(SUM(amount_paise), 0) AS n FROM ledger_entries WHERE entry_type = 'qr_sale'"
    ).fetchone()["n"]
    topups = db.execute(
        "SELECT COALESCE(SUM(amount_paise), 0) AS n FROM ledger_entries WHERE entry_type = 'test_topup'"
    ).fetchone()["n"]
    return jsonify(
        {
            "testMode": True,
            "students": students,
            "merchants": merchants,
            "frozen": frozen,
            "qrSalesPaise": int(sales),
            "testTopupsPaise": int(topups),
        }
    )


@app.get("/admin/accounts")
@admin_auth
def admin_accounts():
    db = get_db()
    rows = db.execute(
        """SELECT a.id, a.role, a.college_id, a.name, a.photo_data, a.frozen, a.created_at,
                  COALESCE(SUM(l.amount_paise), 0) AS balance_paise
           FROM accounts a
           LEFT JOIN ledger_entries l ON l.account_id = a.id
           GROUP BY a.id
           ORDER BY a.role, a.college_id"""
    ).fetchall()
    return jsonify(
        {
            "accounts": [
                {
                    "id": r["id"],
                    "role": r["role"],
                    "collegeId": r["college_id"],
                    "name": r["name"],
                    "photoData": r["photo_data"],
                    "frozen": bool(r["frozen"]),
                    "balancePaise": int(r["balance_paise"]),
                    "createdAt": r["created_at"],
                }
                for r in rows
            ]
        }
    )


@app.route("/admin/accounts", methods=["POST", "PATCH"])
@admin_auth
def admin_save_account():
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    role = str(body.get("role") or "").lower()
    if role not in {"student", "merchant"}:
        raise ApiError(400, "Choose Student or Canteen")
    name = str(body.get("name") or "").strip()
    if not 2 <= len(name) <= 80:
        raise ApiError(400, "Name must be 2-80 characters")

    db = get_db()
    existing = db.execute("SELECT * FROM accounts WHERE college_id = ?", (college_id,)).fetchone()
    pin = str(body.get("pin") or "")
    if not existing and not pin:
        raise ApiError(400, "Password is required for a new account")
    if pin:
        assert_pin(pin)
    photo_data = assert_photo_data(body.get("photoData", existing["photo_data"] if existing else None))

    try:
        if existing:
            if existing["role"] != role:
                has_history = db.execute(
                    "SELECT 1 FROM ledger_entries WHERE account_id = ? LIMIT 1", (existing["id"],)
                ).fetchone()
                has_qr = db.execute(
                    "SELECT 1 FROM qr_tokens WHERE student_id = ? LIMIT 1", (existing["id"],)
                ).fetchone()
                if has_history or has_qr:
                    raise ApiError(409, "Account type cannot change after wallet activity")
            db.execute(
                "UPDATE accounts SET role = ?, name = ?, pin_hash = ?, photo_data = ? WHERE id = ?",
                (role, name, hash_pin(pin) if pin else existing["pin_hash"], photo_data, existing["id"]),
            )
            account_id = existing["id"]
        else:
            account_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO accounts (id, role, college_id, name, pin_hash, photo_data, frozen, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, ?)""",
                (account_id, role, college_id, name, hash_pin(pin), photo_data, utcnow()),
            )
    except sqlite3.IntegrityError as exc:
        raise ApiError(409, "ID already exists") from exc
    db.commit()
    return jsonify({"ok": True, "account": {
        "id": account_id, "role": role, "collegeId": college_id, "name": name,
        "photoData": photo_data,
    }})


@app.get("/admin/ledger")
@admin_auth
def admin_ledger():
    db = get_db()
    rows = db.execute(
        """SELECT l.id, l.amount_paise, l.entry_type, l.note, l.created_at,
                  a.college_id, a.role
           FROM ledger_entries l
           JOIN accounts a ON a.id = l.account_id
           ORDER BY l.created_at DESC
           LIMIT 200"""
    ).fetchall()
    return jsonify({"entries": [dict(r) for r in rows]})


@app.post("/admin/freeze")
@admin_auth
def admin_freeze():
    body = json_body()
    college_id = assert_college_id(body.get("collegeId", ""))
    frozen = bool(body.get("frozen"))
    db = get_db()
    db.execute("UPDATE accounts SET frozen = ? WHERE college_id = ?", (1 if frozen else 0, college_id))
    db.commit()
    row = db.execute(
        "SELECT college_id, frozen, role, name FROM accounts WHERE college_id = ?", (college_id,)
    ).fetchone()
    if not row:
        raise ApiError(404, "Account not found")
    return jsonify({"ok": True, "account": dict(row)})


def main() -> None:
    ensure_database()
    ensure_tls_certificates()
    scheme = "https" if HTTPS else "http"
    print("Campus Wallet TEST app: %s://127.0.0.1:%s" % (scheme, PORT))
    print("For other devices, open %s://<computer IPv4 address>:%s on the same Wi-Fi" % (scheme, PORT))
    print("Android trust certificate: http://<computer IPv4 address>:%s/local-ca.crt" % PORT)
    print("Demo student STU1001 / 1234 · canteen CANTEEN1 / 1234 · admin key %s" % ADMIN_KEY)
    print("SQLite file: %s" % DB_PATH)
    tls_context = None
    if HTTPS:
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(SERVER_CERT_PATH, SERVER_KEY_PATH)
    app.run(host="0.0.0.0", port=PORT, debug=False, ssl_context=tls_context)


if __name__ == "__main__":
    main()
