# Campus Wallet — Cursor agent brief

This file was **missing** from the workspace. It is reconstructed from:

- Root `README.md` (Version 1 test-mode runbook)
- `Campus_Wallet.pptx` inside `campus-wallet.zip` (product, fees, plans, build order)
- User constraints: local test-mode first; preserve existing files; no real payments; no real student data

Do not treat later versions as in-scope until Version 1 works locally.

## Goal

Campus Wallet is a **college-only closed-loop account**: students add test balance, then pay at campus merchants (canteens first) by QR. The server owns balances. The ledger is append-only; balances are **calculated**, never edited in place.

**This phase (Version 1 — local test-mode MVP):** login, wallet, test add-money, QR pay, freeze, history, admin tools.

**Out of scope until later phases:** Razorpay/UPI/cards, bank withdrawal, Fenwick/Emberfall, friend transfers, events/teams, NFC ID cards, FCM/email, production RBI launch.

## Hard rules

- `TEST_MODE=true` only. No payment gateway SDKs, keys, or live UPI.
- Demo accounts only (`STU1001`, `CANTEEN1`, …). No real student names, emails, phones, or college ID dumps.
- Never store raw PINs; never log PINs or JWT secrets.
- Amounts in **integer paise** (₹1 = 100).
- Spending is free of platform fee. Withdrawal/plans are documented, not implemented.
- Legal: RBI prepaid-wallet / PPI rules need expert review before any real money. The app must show it is test mode.

## Recommended stack (from the deck + README)

| Part | Technology |
| --- | --- |
| Student + canteen app | Flutter (`student_app`) |
| API | Node.js (`backend`) |
| Database | PostgreSQL (`schema.sql`) |
| Admin | Lightweight dashboard served by the API (React later) |
| Recharge (later) | Razorpay — **not wired** |

College shortcut (Flutter + Firebase) is **not** used for V1; PostgreSQL ledger is the source of truth.

## Version 1 behaviour

**Students**

- Sign up / log in with a synthetic college ID + PIN.
- See balance and ledger/statement.
- Tap **Add ₹100** — server credits a `test_topup` ledger line only when `TEST_MODE=true`.
- Show a **temporary QR** (token TTL ~45s). Staff can also paste the QR text.
- **Freeze account** from the phone (blocks pay). Unfreeze requires PIN.

**Canteen / merchant**

- Log in as `CANTEEN1` (created by admin or seed).
- Charge by pasting/scanning student QR + amount.
- See own sales ledger.

**Admin**

- `POST /admin/create-merchant` with `x-admin-key` (keep this path; README depends on it).
- Dashboard: account counts, test volume, freeze, inspect ledger.
- Fee tables are **not** charged in V1; they may be displayed as read-only policy notes.

## Later phases (do not build now)

**Version 2:** Starrow / Fenwick / Emberfall, withdrawal fees, friend send (Starrow blocked except possible event-payback exception).

**Version 3:** Events, team of 4 / ₹1000 example flow, Emberfall free entries and ₹1299 top-ups, offers/cashback.

**Later:** NFC ID cards, auto-renew, sponsor rewards, real gateway, notifications.

## API contract (V1)

Base: `http://localhost:3000`

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | liveness + `testMode` |
| POST | `/students/signup` | public | create student + empty ledger |
| POST | `/students/login` | public | JWT |
| GET | `/students/me` | student | profile, frozen, **computed** balance |
| GET | `/students/directory?q=...` | student | search active students by name or campus ID |
| POST | `/students/transfer` | student | test-only atomic peer transfer `{ collegeId, amountPaise, pin, note? }` |
| POST | `/students/test-topup` | student | credit ₹100 test (or body `amountPaise`) |
| GET | `/students/qr` | student | rotating pay token |
| POST | `/students/freeze` | student | `{ frozen, pin }` |
| GET | `/students/ledger` | student | statement |
| POST | `/merchants/login` | public | JWT |
| GET | `/merchants/me` | merchant | profile + balance |
| POST | `/merchants/charge` | merchant | `{ token, amountPaise }` atomic pay |
| GET | `/merchants/ledger` | merchant | sales |
| POST | `/admin/create-merchant` | admin key | `{ collegeId, name, pin }` |
| GET | `/admin/summary` | admin key | counts |
| GET | `/admin/accounts` | admin key | list |
| GET | `/admin/ledger` | admin key | recent lines |
| POST | `/admin/freeze` | admin key | `{ collegeId, frozen }` |

Auth: `Authorization: Bearer <jwt>`. Admin: `x-admin-key`.

## Acceptance (local MVP)

1. `psql` applies `backend/schema.sql`; seed creates **only fictional** users.
2. Student signs up (or uses `STU1001` / `1234`), adds ₹100, sees QR.
3. Merchant `CANTEEN1` / `1234` charges using QR text; student balance drops; both ledgers show the same payment.
4. Freeze blocks a subsequent charge.
5. A student can search the active student directory and send a PIN-confirmed, balance-checked test transfer; both student ledgers update atomically.
6. Admin dashboard loads with the admin key.
7. No Razorpay, no production DB, no real PII.

## Preserve

- Keep root `README.md` runbook text.
- Keep `campus-wallet.zip` and the deck as source material.
- New docs live under `docs/`.
