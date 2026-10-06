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
- Physical Android phone: `http://<computer-LAN-IP>:3000` (the phone and computer must use the same Wi-Fi)

The default `127.0.0.1` address is only for a server running on the same device; it will not reach your computer from a physical phone. Build/run for a phone with the computer's current LAN IP, for example:

```powershell
flutter run --dart-define="API_BASE=http://10.0.58.192:3000"
```

Replace that example IP if the computer's address changes. To update an installed APK, build a new APK with the same define and install that APK on the phone; changing source code does not update an already-installed app.

The student app includes PIN-gated balance checks, a reordered wallet-action panel, friend search and chat, and test-wallet transfers from within a chat. Chat requires the matching Flask API endpoints in `local_server/app.py`.

To build and install an updated Android APK from this directory:

```powershell
flutter pub get
flutter build apk --release --dart-define="API_BASE=http://<computer-LAN-IP>:3000"
adb install -r build\app\outputs\flutter-apk\app-release.apk
```

Use the same computer LAN address that the phone can reach on Wi-Fi. The Android version is incremented in `pubspec.yaml` so the updated APK can replace an older installation.

3. Demo logins after `npm run seed` in `backend`: student `STU1001` / `1234`, canteen `CANTEEN1` / `1234`. The canteen login is also available from the app's login screen. For local admin login, enter ID `ADMIN` and the admin key printed by the local server at startup.

## Android NFC test transfers

- NFC is available only on Android. Both phones need NFC; the recipient phone must support Host Card Emulation (HCE).
- On the recipient phone, choose **Receive by tap**. On the sender phone, choose **Send by tap**, enter the amount, then tap the phones together while both apps are open.
- Transfers are PIN-free test-wallet ledger entries only: at most ₹500 per tap and ₹2,000 per sender per UTC day. The server enforces both limits, and each receiver session is single-use and expires after two minutes.
- Keep the recipient app unlocked while receiving. The sender app must have a logged-in student session. NFC is not a payment network and does not connect to UPI or real funds.
- `android/` contains the Flutter Android manifest and NFC HCE/reader code. Run `flutter create .` first to generate the remaining Gradle wrapper/project files, then `flutter pub get` and `flutter run` on two NFC-capable Android phones.

The app never talks to a card network or UPI. Top-up is the test-money button only.
