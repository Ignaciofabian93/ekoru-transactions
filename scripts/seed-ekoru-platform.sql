-- ─────────────────────────────────────────────────────────────────────────────
-- Seed EKORU's own platform account + its Webpay config.
--
-- This is the RECEIVER for subscription (and later ad) payments — money that
-- flows to EKORU, not to a seller. It's a normal Seller row used only as a
-- payment receiver: it never logs in (password is a non-bcrypt placeholder).
--
-- The id below is what goes in EKORU_PLATFORM_SELLER_ID (transactions env).
-- SANDBOX uses Transbank's shared integration creds, same as sellers; for real
-- money, set environment='PRODUCTION' and fill merchantId/apiKey/secretKey with
-- EKORU's own Transbank commerce code.
--
-- Run (must be -f / piped stdin, not -c, because of \set):
--   docker exec -i database-staging psql -U ekoru_postgres_admin_staging -d ekoru-dev \
--     < scripts/seed-ekoru-platform.sql
-- ─────────────────────────────────────────────────────────────────────────────

\set platform_id 'ekoru-platform-account'

-- 1. The platform receiver account. COMPANY type; no country needed.
INSERT INTO "Seller"
  ("id", "email", "password", "sellerType", "isActive", "isVerified", "createdAt", "updatedAt")
VALUES
  (:'platform_id', 'platform@ekoru.cl', 'DISABLED-NO-LOGIN', 'COMPANY', true, true, now(), now())
ON CONFLICT ("id") DO NOTHING;

-- 2. EKORU's Webpay config (sandbox). merchant/api/secret stay NULL in SANDBOX.
INSERT INTO "ChileanPaymentConfig"
  ("sellerId", "provider", "environment", "isActive", "createdAt", "updatedAt")
VALUES
  (:'platform_id', 'WEBPAY', 'SANDBOX', true, now(), now())
ON CONFLICT ("sellerId", "provider")
DO UPDATE SET "environment" = 'SANDBOX', "isActive" = true, "updatedAt" = now();

-- Verify:
SELECT s.id AS seller, c.provider, c.environment, c."isActive"
FROM "Seller" s
JOIN "ChileanPaymentConfig" c ON c."sellerId" = s.id
WHERE s.id = :'platform_id';
