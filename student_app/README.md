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

This app never talks to a card network or UPI. Top-up is the test-money button only.
