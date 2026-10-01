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

```bash
npm install
npm run seed
npm start
```

API: http://localhost:3000  
Health: http://localhost:3000/health  
Admin UI: http://localhost:3000/admin/  
Paste the same `ADMIN_KEY` as in `.env`.

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

`flutter create .` adds `android/`, `ios/`, `web/` without replacing `lib/`.

**API base** is `lib/config.dart`:

- Chrome / Windows desktop: `http://127.0.0.1:3000`
- Android emulator: `http://10.0.2.2:3000`
- Physical phone: your PC’s LAN IP, and allow that origin through any firewall.

Flow: sign up or log in as `STU1001` → Add ₹100 (test money) → copy QR text → log in as canteen `CANTEEN1` → charge.

## What not to do

- Do not set `TEST_MODE=false` and expect a real gateway — there isn’t one.
- Do not load a CSV of real students.
- Do not reuse these PINs outside this machine.
