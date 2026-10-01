# Campus Wallet: Version 1 (test mode)

## Backend
1. Install Node.js and PostgreSQL. Create a database: `createdb campus_wallet`
2. `cd backend && psql campus_wallet -f schema.sql`
3. Copy `.env.example` to `.env` and edit the values
4. `npm install && npm start`   (API runs on http://localhost:3000)
5. Create a canteen login:
   curl -X POST localhost:3000/admin/create-merchant -H "Content-Type: application/json" -H "x-admin-key: YOUR_ADMIN_KEY" -d '{"collegeId":"CANTEEN1","name":"Main Canteen","pin":"1234"}'

## App
1. Install Flutter. In `student_app` run `flutter create .` once (adds android/ios folders), then `flutter pub get`
2. Run `flutter run`. Edit `base` in lib/main.dart if you use a real phone.
3. Sign up a student, tap "Add ₹100 (test money)", copy the QR text into a second login as CANTEEN1 to charge.

Test mode only: no real money until RBI wallet rules are reviewed.

## Project docs
Full agent brief, decisions, and install notes (Windows-friendly) are in `docs/`. Keep this runbook; do not load real student data or payment keys.
