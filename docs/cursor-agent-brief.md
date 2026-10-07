# Campus Wallet — Cursor agent brief

This file was **missing** from the workspace. It is reconstructed from:

- Root `README.md` (Version 1 test-mode runbook)
- `Campus_Wallet.pptx` inside `campus-wallet.zip` (product, fees, plans, build order)
- User constraints: local test-mode first; preserve existing files; no real payments; no real student data

Do not treat later versions as in-scope until Version 1 works locally.

## Goal

Campus Wallet is a **college-only closed-loop account**: students add test balance, then pay at campus merchants (canteens first) by QR. The server owns balances. The ledger is append-only; balances are **calculated**, never edited in place.

**This phase (Version 1 — local test-mode MVP):** login, wallet, test add-money, QR pay, freeze, history, admin tools.

**Out of scope:** Razorpay/live UPI, actual bank payouts, physical ID-card payments, production RBI launch. Card-level membership/fees have since been added in local test mode; see `CARD_LEVELS.md` for the implemented portion and remaining work.

## Hard rules

- `TEST_MODE=true` only. No payment gateway SDKs, keys, or live UPI.
- Demo accounts only (`STU1001`, `CANTEEN1`, …). No real student names, emails, phones, or college ID dumps.
- Never store raw PINs; never log PINs or JWT secrets.
- Amounts in **integer paise** (₹1 = 100).
- QR spending and top-ups are free of platform fee. Card membership and simulated withdrawal/transfer fees are server-calculated in test mode.
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

## Later phases / not yet implemented

**Version 2 (partially implemented):** STARROW / FENWICK / EMBERFALL membership, expiry, admin pricing, transfer fees, simulated withdrawal fees, event entry registration/refunds, college-email verification, and verified team registration/payback are implemented in the Node/PostgreSQL API and Flutter app. Offers/cashback, referral/milestone rewards, scratch cards, priority passes, and push notifications remain unimplemented.

**Event-entry decisions:** The yearly included Emberfall entry expires at membership-year end and resets on renewal. ₹299 top-up entries carry across years while Emberfall remains active, including grace, and expire after lapse beyond grace. Team-event fee is the total team price; split paise deterministically across members, assigning remainder paise to the leader first. An Emberfall entry covers only that member's share. The leader pays total minus the leader's covered share; an Emberfall non-leader's payback share is waived. Event entry counts use the yearly entry first. See `CARD_LEVELS.md`.

**Version 3:** Offers, cashback, referral/milestone rewards, scratch cards, priority passes, and notifications remain outstanding.

The Emberfall renewal price after a skipped membership year is undecided; ask the user before changing or relying on that case.

**Later:** NFC ID cards, auto-renew, sponsor rewards, real gateway, notifications.

## API contract (V1)

Base: `http://localhost:3000`

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | liveness + `testMode` |
| POST | `/students/signup` | public | create student + empty ledger; requires an allowed college email and sends a verification code |
| POST | `/students/login` | public | JWT |
| GET | `/students/me` | student | profile, frozen, **computed** balance |
| POST | `/students/email-verification/request` | student | request/re-send an OTP for the pending allowed college email |
| POST | `/students/email-verification/confirm` | student | confirm the latest unexpired six-digit OTP |
| GET | `/students/directory?q=...` | student | search active students by name or campus ID |
| GET | `/students/chat/{collegeId}` | student | messages and peer transfers with one student |
| POST | `/students/messages` | student | save a peer message `{ collegeId, message }` |
| POST | `/students/transfer` | student | test-only atomic peer transfer `{ collegeId, amountPaise, pin, note? }` |
| POST | `/students/nfc/session` | student | create a two-minute, one-use recipient token for Android HCE |
| POST | `/students/nfc/transfer` | student | PIN-free test transfer `{ recipientToken, amountPaise, note? }`, capped at ₹500 per tap and ₹2,000 per UTC day |
| POST | `/students/test-topup` | student | credit ₹100 test (or body `amountPaise`) |
| GET | `/students/qr` | student | rotating pay token |
| POST | `/students/freeze` | student | `{ frozen, pin }` |
| GET | `/students/ledger` | student | statement |
| GET | `/events` | student | upcoming events with organizer, total fee, team size, and registration state |
| GET | `/students/event-entries` | student | active yearly and paid Emberfall entry counts |
| POST | `/students/event-entries/top-up` | Emberfall student | buy one ₹299 test entry with `{ requestId }` |
| POST | `/events/{eventId}/register` | student/team leader | `{ requestId, teamName, memberEmails }`; solo/team fee, share, entry accounting, and expiring verified-email invitations |
| POST | `/events/{eventId}/cancel` | organizer | cancel event, refund paid entries, and restore eligible entry entitlements |
| GET | `/team-invites/accept?token=...` | public | validate invitation and show sign-in instructions |
| POST | `/students/team-invites/accept` | verified student | accept a single-use invitation matching the account's verified email |
| GET | `/students/teams` | student | team payback tracker, accepted members, dues, invitation state |
| POST | `/students/teams/{teamId}/payback` | accepted member | `{ amountPaise, pin, requestId }`; pay only own outstanding share to leader |
| POST | `/students/teams/{teamId}/remind` | team leader | `{ memberCollegeId }`; remind a member with an outstanding share |
| POST | `/merchants/login` | public | JWT |
| GET | `/merchants/me` | merchant | profile + balance |
| POST | `/merchants/charge` | merchant | `{ token, amountPaise, paymentId }` atomic, idempotent QR pay |
| GET | `/merchants/ledger` | merchant | sales |
| POST | `/admin/create-merchant` | admin key | `{ collegeId, name, pin }` |
| GET | `/admin/summary` | admin key | counts |
| GET | `/admin/accounts` | admin key | list |
| GET | `/admin/ledger` | admin key | recent lines |
| POST | `/admin/freeze` | admin key | `{ collegeId, frozen }` |
| POST | `/admin/events` | admin key | create a test event with fee, team size, dates, and merchant organizer |
| POST | `/admin/events/{eventId}/cancel` | admin key | cancel event and refund eligible registrations |
| GET/PUT | `/admin/team-invite-settings` | admin key | read/update database-backed rolling-window invitation limits |

Auth: `Authorization: Bearer <jwt>`. Admin: `x-admin-key`.

## Acceptance (local MVP)

1. `psql` applies `backend/schema.sql`; seed creates **only fictional** users.
2. Student signs up (or uses `STU1001` / `1234`), adds ₹100, sees QR.
3. Merchant `CANTEEN1` / `1234` charges using QR text; student balance drops; both ledgers show the same payment.
4. Freeze blocks a subsequent charge.
5. A student can search the active student directory and send a PIN-confirmed, balance-checked test transfer; both student ledgers update atomically.
6. Android students can exchange a one-use HCE session token and transfer test funds without a PIN; server-side per-tap and daily caps apply.
7. Admin dashboard loads with the admin key.
8. No Razorpay, no production DB, no real PII.

## Preserve

- Keep root `README.md` runbook text.
- Keep `campus-wallet.zip` and the deck as source material.
- New docs live under `docs/`.
