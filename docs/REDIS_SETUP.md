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

Exactly one thing: a password, `REDIS_PASSWORD`. It lives in Infisical, folder
`/ekoru-transactions`, in `staging` and `prod`. Every app deploy exports it from
there, and the Redis container gets the same value when you create it (below) —
so they agree. You don't have to touch it unless you want to rotate it.

To generate a fresh one (optional):

```bash
openssl rand -hex 32
```

Put the value in `REDIS_PASSWORD` in Infisical **before** starting Redis. To
rotate it later: change it in Infisical, redeploy the app in Jenkins, then
straight away repeat the export and `up -d` below. Compose sees the new password
and recreates Redis; queued jobs survive in its volume. Until Redis is
recreated, the app gets `WRONGPASS`.

---

## Staging: one-time setup

Redis is deliberately **not** in the Jenkinsfile — it's a long-lived container
that must survive app redeploys, so you bring it up by hand once. Redis reads
`.env.staging` only while `up` creates it, so the file is exported from
Infisical just for that and deleted afterwards; a copy left lying around would
go stale the first time a value changes in Infisical. On the server, as root:

```bash
# 0. The shared network must exist (created once for the whole staging stack):
docker network inspect ekoru-staging-network >/dev/null 2>&1 \
  || docker network create ekoru-staging-network

# 1. Log in to Infisical: the lines of infisical/README.md section 5.2 up to
#    `export INFISICAL_TOKEN` (they set IMAGE, RUN and the token).

# 2. Export the env (carries REDIS_PASSWORD), start Redis, delete the file:
cd /path/to/ekoru-transactions        # the folder with redis.staging.yml
( umask 077; $RUN -e INFISICAL_TOKEN -e INFISICAL_PROJECT_ID $IMAGE \
    sm export --env=staging --path=/ekoru-transactions --format=dotenv --expand=false --silent \
    > .env.staging )
if grep -q '^REDIS_PASSWORD=.' .env.staging; then docker compose -f redis.staging.yml up -d
else echo "The export has no REDIS_PASSWORD. Redis not started."; fi
shred -u .env.staging
unset INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET

# 3. Verify it's healthy and auth works (the password comes from the container):
docker ps --filter name=ekoru-transactions-redis-staging
docker exec ekoru-transactions-redis-staging \
  sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'
#   → PONG
```

That's it. The app finds Redis at `REDIS_HOST=ekoru-transactions-redis-staging`
on the network (already set in Infisical). Redeploying the app later never
touches this container, so queued jobs survive.

## Production

Identical, with `--env=prod`, `.env.prod`, `redis.prod.yml` and the prod
network. Log in first, as in step 1 above:

```bash
docker network inspect ekoru-network >/dev/null 2>&1 || docker network create ekoru-network
cd /path/to/ekoru-transactions
( umask 077; $RUN -e INFISICAL_TOKEN -e INFISICAL_PROJECT_ID $IMAGE \
    sm export --env=prod --path=/ekoru-transactions --format=dotenv --expand=false --silent \
    > .env.prod )
if grep -q '^REDIS_PASSWORD=.' .env.prod; then docker compose -f redis.prod.yml up -d   # container: ekoru-transactions-redis
else echo "The export has no REDIS_PASSWORD. Redis not started."; fi
shred -u .env.prod
unset INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
docker exec ekoru-transactions-redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'   # → PONG
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
- `WRONGPASS` / `NOAUTH` → `REDIS_PASSWORD` differs between the app and the
  Redis container. Redis still has the value from when it was created: recreate
  it with a fresh export (above).

---

## If you'd rather use managed Redis later

Not required, but supported: point `REDIS_HOST`/`REDIS_PORT` at the provider,
set `REDIS_PASSWORD`, add `REDIS_TLS=true` (managed Redis needs TLS — the app
already honors that flag in `app.module.ts`), and skip `redis.<env>.yml`
entirely.
