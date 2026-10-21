# Vercel API + BullMQ workers

## Split architecture

| Component | Where | Command |
|-----------|--------|---------|
| HTTP API | **Vercel** | `api/index.js` (serverless) |
| BullMQ workers | **Render** (or Railway/Fly) | `npm run worker` |
| Repeatable job registration | **Render cron** | `npm run scheduler` (see `render.yaml`) |
| Redis | **Upstash** (recommended) | `REDIS_URL=rediss://…` |

Vercel cannot run long-lived BullMQ worker processes. The API enqueues jobs when Redis is reachable; workers consume them on Render.

## Vercel env (minimum)

- `MONGODB_URI` — MongoDB Atlas (Network Access must allow `0.0.0.0/0` or Vercel IPs)
- `PUBLIC_BASE_URL` / `EXPORT_BASE_URL` — `https://swarnagrow-backend.vercel.app`
- `REDIS_URL` — Upstash **TLS** URL (not `127.0.0.1`)
- `REDIS_REQUIRED` — `true` if you rely on queues
- `CRON_SECRET` — optional; protects manual `GET /api/cron/queue-tick`

## Upstash Redis

```bash
npx @upstash/cli login
npx @upstash/cli redis create --name swarnagrow --region ap-south-1
# Copy REST or Redis URL → Vercel + Render env as REDIS_URL
```

## Render workers

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** → connect repo.
2. Apply `render.yaml` (worker + daily scheduler cron).
3. Paste the same env vars as Vercel (especially `MONGODB_URI`, `REDIS_URL`, JWT secrets).

## Manual queue tick (no Render yet)

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://swarnagrow-backend.vercel.app/api/cron/queue-tick"
```

Runs dispatch + digital-metals outbox + lease reclaim inline (does not replace FCM/message workers).
