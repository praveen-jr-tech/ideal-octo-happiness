# Campus Wallet backend (Version 1 test mode)

See `/docs/SETUP.md`. Copy `.env.example` to `.env`. Do not add Razorpay or live student data.

```bash
psql campus_wallet -f schema.sql
npm install
npm run seed
npm start
```
