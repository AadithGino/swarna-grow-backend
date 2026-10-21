# SwarnaGrow backend — dev handoff (ecommerce branch snapshot)

**Confidential:** This package includes `.env` with database, JWT, and FCM credentials. Share only with trusted teammates (not public links).

## Prerequisites

- **Node.js 22+**
- **MongoDB** — replica set required for transactions (Atlas URI is preconfigured in `.env`, or use local `mongodb://127.0.0.1:27017/swarnagrow?replicaSet=rs0` after starting a local rs)
- **Redis** (recommended) — `redis://127.0.0.1:6379` for BullMQ (messages, promotions, exports). API runs without Redis but queued work stays pending.

## Quick start

```bash
cd swarnagrow-backend   # or whatever folder name after unzip
npm install
# .env is included — review MONGODB_URI, PORT, REDIS_URL
npm run seed            # optional demo tenant/data
npm run dev             # API + worker (watch mode)
```

API base: `http://localhost:<PORT>/api/v1` (see `PORT` in `.env`, currently **4050** in this handoff).

Health: `GET http://localhost:<PORT>/health`

## Split processes (optional)

```bash
npm run dev:api
npm run worker
npm run scheduler   # registers repeatable jobs, then exits
```

## Ecommerce / FCM work in this snapshot

- Product & gold-rate promotion campaigns, delivery worker, maintenance jobs
- Docs: `docs/ECOMMERCE_PROMOTION_FCM.md`
- Index migration (staging/prod only, not required for first local run):  
  `node --env-file=.env scripts/migrate-push-broadcast-campaign-key-index.js --dry-run`

## Verify

```bash
npm run check
NODE_ENV=test node --import ./tests/global-test-db-serial.js --test tests/gold-rate-notification.test.js tests/ecommerce-promotion-regression.test.js
```

## Git (preferred for ongoing work)

```bash
git clone git@github.com:AadithGino/swarna-grow-backend.git
git checkout ecommerce
git pull
cp .env.example .env   # then merge secrets from this zip if needed
```
