# Decisions (Version 1 local test-mode)

## Product

- **Ship Version 1 only.** Plans, withdrawals, events, NFC, and real recharge stay documented, not coded.
- **Test top-up is a ledger credit**, not a payment. `TEST_MODE` must be true or the route returns 403.
- **QR first, NFC later.** Tokens expire (~45s) and are bound to one student. Charging does not “use up” the token immediately so a refresh race does not brick checkout; expiry still limits replay.
- **Freeze is a full pay block** for the student (V1 has no transfers/withdrawals to block yet).
- **Admin dashboard is static HTML** served by Express (`/admin/`). The deck suggests React; a second SPA toolchain is deferred so local setup stays Node + Postgres + Flutter.

## Data and money

- **PostgreSQL** as specified. Ledger table is append-only. `accounts.balance_paise` is **not** stored; `SUM(ledger.amount_paise)` is the balance.
- **Paise integers** only. Display rupees in the UI.
- **Demo IDs only:** `STU1001`, `STU1002`, `CANTEEN1`. Pins default to `1234` in seed — local test, rotate before any shared environment.
- **No real student data** in seed, screenshots, or comments.

## Security (V1, not production)

- PINs hashed with bcryptjs.
- JWT for student/merchant sessions.
- Admin uses a shared `ADMIN_KEY` header (good enough for local; not SSO).
- CORS open for local Flutter (web / emulator).
- `.env` is gitignored; `.env.example` has placeholders only.

## Tooling on this machine (30 Sep 2026)

- Workspace had `README.md` + `campus-wallet.zip` only. Zip paths used unexpanded `{backend,student_app` braces — **not used**.
- `docs/cursor-agent-brief.md` did not exist; reconstructed from the deck + README.
- Node.js, npm, Flutter, Docker, and PostgreSQL were **not** installed. Python 3.14 was. Backend remains Node as specified; install steps are in `SETUP.md`.
- Code was not executed end-to-end here because Node/Postgres/Flutter are missing.

## Explicit non-goals

- Razorpay, UPI, cards, bank account linking, name-match payouts.
- Sending email/SMS/push.
- Storing Aadhaar, real roll lists, or production secrets.
