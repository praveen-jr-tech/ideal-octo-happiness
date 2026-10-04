# Public test deployment guide

This project is set up for a public backend deployment using Render.

## 1) Create the Render services

1. In Render, choose **New > Blueprint** and connect this GitHub repository.
2. Review `render.yaml`; it creates the API and a PostgreSQL database in test mode.
3. Apply the Blueprint. Render generates private `JWT_SECRET` and `ADMIN_KEY` values.

The API applies `backend/schema.sql` when it starts. Do not put Render secrets in
the app, source code, or chat. The app authenticates with student ID/PIN and a
short-lived login token; it does not need a shared API key.

## 2) Seed fictional test accounts

From the Render service shell, run `npm run seed` once. This creates fictional
test accounts (`STU1001` / `1234`, `STU1002` / `1234`, and `CANTEEN1` / `1234`).
Never use real student data or real payment credentials with this prototype.

## 3) Build an Android test APK

The repository's **Android test APK** GitHub Actions workflow generates the
Flutter Android scaffold and builds an installable debug APK. Run it from the
Actions tab and enter the deployed Render API URL (for example,
`https://campus-wallet-api.onrender.com`). Download the
`campus-wallet-test-apk` artifact from the completed workflow run.

For local network testing, the API URL may instead be your computer's LAN IP
and port; the phone must be on the same Wi-Fi and the API server must be running.

## 4) Scope and limitations

This is a test-mode wallet prototype: balances are demo ledger entries only,
NFC/QR transfers are not real payments, and the APK is a debug-signed build
intended for direct testing—not a Play Store release.
