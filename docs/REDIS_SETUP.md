# Redis setup — self-hosted, no account needed

`ekoru-transactions` uses Redis only as the backing store for its BullMQ queues
(refunds today; async reconciliation later). **You do not need Redis Cloud,
Upstash, Azure Cache, or any managed/paid Redis account.** Redis runs as an
ordinary `redis:7-alpine` container on your own server, on the same private
Docker network as the subgraph. Nothing is exposed to the internet.

The compose files already exist — [`redis.staging.yml`](../redis.staging.yml)
and [`redis.prod.yml`](../redis.prod.yml). You just start one, once.

---

## What Redis needs from you

Exactly one thing: a password, `REDIS_PASSWORD`. It's already set in
`.env.staging` / `.env.prod` and is read by **both** the app and the Redis
container from that same file — so they always agree. You don't have to touch it
unless you want to rotate it.

To generate a fresh one (optional):

```bash
openssl rand -hex 32
```

Paste the value into `REDIS_PASSWORD` in the env file **before** starting Redis.
If you rotate it later, you must recreate both the Redis container and the app.

---

## Staging: one-time setup

Redis is deliberately **not** in the Jenkinsfile — it's a long-lived container
that must survive app redeploys, so you bring it up by hand once. On the server:

```bash
# 0. The shared network must exist (created once for the whole staging stack):
docker network inspect ekoru-staging-network >/dev/null 2>&1 \
  || docker network create ekoru-staging-network

# 1. Put the secret env file in place (carries REDIS_PASSWORD):
#    /opt/ekoru/secrets/ekoru-transactions/.env.staging   (chmod 600)
cd /path/to/ekoru-transactions
cp /opt/ekoru/secrets/ekoru-transactions/.env.staging .env.staging

# 2. Start Redis (long-lived; you only ever run this once per server):
docker compose -f redis.staging.yml up -d

# 3. Verify it's healthy and auth works:
docker ps --filter name=ekoru-transactions-redis-staging
docker exec ekoru-transactions-redis-staging \
  redis-cli -a "$(grep '^REDIS_PASSWORD' .env.staging | cut -d'"' -f2)" ping
#   → PONG
```

That's it. The app finds Redis at `REDIS_HOST=ekoru-transactions-redis-staging`
on the network (already set in `.env.staging`). Redeploying the app later never
touches this container, so queued jobs survive.

## Production

Identical, using the prod files and network:

```bash
docker network inspect ekoru-network >/dev/null 2>&1 || docker network create ekoru-network
cp /opt/ekoru/secrets/ekoru-transactions/.env.prod .env.prod
docker compose -f redis.prod.yml up -d      # container: ekoru-transactions-redis
```

---

## How to know it's working

After the **app** starts, its logs should show BullMQ connecting with no
`ECONNREFUSED` / `WRONGPASS` errors:

```bash
docker logs ekoru-transactions-staging --tail 50
```

- `ECONNREFUSED` → Redis isn't up, or `REDIS_HOST` doesn't match the Redis
  container name, or they're on different networks.
- `WRONGPASS` / `NOAUTH` → `REDIS_PASSWORD` differs between the app env and the
  Redis container (they must come from the same `.env` value).

---

## If you'd rather use managed Redis later

Not required, but supported: point `REDIS_HOST`/`REDIS_PORT` at the provider,
set `REDIS_PASSWORD`, add `REDIS_TLS=true` (managed Redis needs TLS — the app
already honors that flag in `app.module.ts`), and skip `redis.<env>.yml`
entirely.
