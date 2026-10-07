# Setup — local test-mode MVP

No real money. No real student records. Use only the seeded demo IDs.

## Prerequisites

1. **Node.js 20+** (includes npm): https://nodejs.org
2. **PostgreSQL 16+**: https://www.postgresql.org/download/windows/
3. **Flutter stable** (for the app): https://docs.flutter.dev/get-started/install/windows
4. Optional: Docker, if you prefer Postgres in a container instead of a Windows service.

Create a database named `campus_wallet` (peer/password auth as you configured).

## Database

```bash
createdb campus_wallet
cd backend
psql campus_wallet -f schema.sql
```

Windows (SQL Shell / `psql.exe`), adjust user as needed:

```text
psql -U postgres -d campus_wallet -f schema.sql
```

Docker alternative (from repo root):

```bash
docker compose up -d
psql postgres://campus:campus_test_only@localhost:5432/campus_wallet -f backend/schema.sql
```

## Backend

```bash
cd backend
copy .env.example .env
```

Edit `.env`: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_KEY`. Keep `TEST_MODE=true`.
Set `ALLOWED_EMAIL_DOMAINS` to a comma-separated exact college domain allowlist
(for example, `example.edu`). Test mode falls back to `example.edu` when the
setting is empty; non-test startup requires an explicit allowlist. Test-mode
email verification codes and team invitation links are written to the backend
logger. A non-test deployment must inject an `emailSender`; this repository
does not configure an SMTP service.

```bash
npm install
npm run seed
npm start
```

The API applies `backend/schema.sql` during startup, including card-level tables
and safe additive columns. Existing ledger rows are retained; the database
rejects future ledger-row updates and deletes.

### Backend database integration tests

The integration tests use a local test database named `campus_wallet` and
refuse to run against a database with a different name. Start PostgreSQL on
loopback, apply `backend/schema.sql`, then from `backend` set the test URL and
run the integration suite:

```powershell
$env:CAMPUS_WALLET_TEST_DATABASE_URL = "postgresql://campus_wallet_test@127.0.0.1:5432/campus_wallet"
npm run test:integration
```

The suite registers fictional test students and merchants, exercises test
top-ups, card membership, email verification, team invitations/paybacks, and QR
payments, and leaves those test rows in the local database. Keep PostgreSQL
bound to loopback and do not point this suite at a database containing real
accounts.

API: http://localhost:3000  
Health: http://localhost:3000/health  
Admin UI: http://localhost:3000/admin/  
Paste the same `ADMIN_KEY` as in `.env`.

## Standalone local demo with phone QR scanning

The Flask/SQLite demo is in `local_server` and does not need PostgreSQL or the Node backend. Install its dependencies:

```powershell
python -m pip install -r local_server\requirements.txt
```

First start an HTTP bootstrap server on port 3001:

```powershell
$env:HTTPS = "false"
$env:PORT = "3001"
python local_server\app.py
```

On Android, while connected to the same Wi-Fi, download `http://<computer IPv4 address>:3001/local-ca.crt`. Install it as a CA certificate in Android's Security settings. Then leave the bootstrap server running and start a second PowerShell terminal for the HTTPS app:

```powershell
$env:HTTPS = "true"
$env:PORT = "3000"
python local_server\app.py
```

Open `https://<computer IPv4 address>:3000/` on the phone. Log in as the canteen and tap **Scan QR** to grant camera access; the scanner is only available on the canteen checkout. The merchant confirms the amount and taps Charge. The QR decoder loads from jsDelivr, so the phone needs internet access; manual QR text entry remains available if it cannot load.

Create a merchant (README command; replace the key):

```bash
curl -X POST http://localhost:3000/admin/create-merchant -H "Content-Type: application/json" -H "x-admin-key: YOUR_ADMIN_KEY" -d "{\"collegeId\":\"CANTEEN1\",\"name\":\"Main Canteen\",\"pin\":\"1234\"}"
```

Seed already creates `CANTEEN1` if you ran `npm run seed`. Duplicate create returns a clear error.

### Demo accounts (fictional)

| Role | College ID | PIN |
| --- | --- | --- |
| Student | STU1001 | 1234 |
| Student | STU1002 | 1234 |
| Canteen | CANTEEN1 | 1234 |

## Flutter app

```bash
cd student_app
flutter create .
flutter pub get
flutter run
```

`android/` already contains the NFC manifest and native reader/HCE services.
Run `flutter create .` to generate the remaining Flutter platform scaffolding,
then build and run the app as usual.

**API base** is `lib/config.dart`:

- Chrome / Windows desktop: `http://127.0.0.1:3000`
- Android emulator: `http://10.0.2.2:3000`
- Physical phone: your PC’s LAN IP, and allow that origin through any firewall.

Flow: sign up or log in as `STU1001` → Add ₹100 → copy QR text → log in as canteen `CANTEEN1` → charge.

The Flutter student app also includes card-level membership, college-email
verification, event registration, team invitations, and the payback tracker.
See [`CARD_LEVELS.md`](CARD_LEVELS.md) for current rules and remaining
unimplemented benefits. Keep `TEST_MODE=true`; no bank/UPI payout or Razorpay
integration is connected.

For NFC testing, run the app on two NFC-capable Android phones; the receiving
phone must support Host Card Emulation (HCE). Transfers are test-ledger only,
PIN-free, limited to ₹500 per tap and ₹2,000 per sender per UTC day.

## What not to do

- Do not set `TEST_MODE=false` and expect a real gateway — there isn’t one.
- Do not load a CSV of real students.
- Do not reuse these PINs outside this machine.
