# Public deployment guide

This project is set up for a public backend deployment using Render.

## 1) Push to GitHub

Commit the project and push to a GitHub repository.

## 2) Deploy backend on Render

1. Open https://render.com
2. Create a new Web Service
3. Connect the GitHub repository
4. Set root directory to `backend`
5. Build command: `npm install`
6. Start command: `npm start`
7. Add environment variables:
   - `PORT=10000`
   - `DATABASE_URL` from the Postgres database
   - `JWT_SECRET` = a secure random string
   - `ADMIN_KEY` = a secure admin key
   - `TEST_MODE=true`
   - `QR_TTL_SECONDS=45`

Render can also create the Postgres database automatically from `render.yaml` if you use the Blueprint import option.

## 3) Seed the database

After deployment completes, run:

```bash
npm run seed
```

## 4) Use the public API in Flutter

In the app, set the API base to the deployed URL:

```bash
cd student_app
flutter pub get
flutter run --dart-define=API_BASE=https://your-render-service.onrender.com
```

Or build a release APK:

```bash
flutter build apk --dart-define=API_BASE=https://your-render-service.onrender.com
```

## 5) Admin access

Use the same `ADMIN_KEY` that you set in Render.

## 6) Important note

This project is still a test-mode wallet prototype and should not be treated as a real-money app yet.
