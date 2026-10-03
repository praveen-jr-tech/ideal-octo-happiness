# Student + canteen Flutter client (Version 1 test mode)

1. Install Flutter, then from this folder:

```bash
flutter create .
flutter pub get
flutter run
```

2. Point `lib/config.dart` (or `--dart-define=API_BASE=...`) at the API:

- Windows / Chrome: `http://127.0.0.1:3000`
- Android emulator: `http://10.0.2.2:3000`

3. Demo logins after `npm run seed` in `backend`: student `STU1001` / `1234`, canteen `CANTEEN1` / `1234`.

## Android NFC test transfers

- NFC is available only on Android. Both phones need NFC; the recipient phone must support Host Card Emulation (HCE).
- On the recipient phone, choose **Receive by tap**. On the sender phone, choose **Send by tap**, enter the amount, then tap the phones together while both apps are open.
- Transfers are PIN-free test-wallet ledger entries only: at most ₹500 per tap and ₹2,000 per sender per UTC day. The server enforces both limits, and each receiver session is single-use and expires after two minutes.
- Keep the recipient app unlocked while receiving. The sender app must have a logged-in student session. NFC is not a payment network and does not connect to UPI or real funds.
- `android/` contains the Flutter Android manifest and NFC HCE/reader code. Run `flutter create .` first to generate the remaining Gradle wrapper/project files, then `flutter pub get` and `flutter run` on two NFC-capable Android phones.

The app never talks to a card network or UPI. Top-up is the test-money button only.
