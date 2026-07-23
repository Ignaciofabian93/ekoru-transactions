-- ─────────────────────────────────────────────────────────────────────────────
-- Seed a Webpay SANDBOX payment config for one seller.
--
-- createPayment refuses to run unless the SELLER of the product being bought
-- has an active ChileanPaymentConfig for the chosen provider. For a sandbox
-- test you only need this one row.
--
-- SANDBOX uses Transbank's shared integration commerce code + api key, so
-- merchantId / apiKey / secretKey are left NULL — the WebpayAdapter fills them
-- in from the SDK's IntegrationCommerceCodes.WEBPAY_PLUS. Set real per-seller
-- values only for environment = 'PRODUCTION'.
--
-- 1. Find the seller id (the OWNER of the product you'll buy, not the buyer):
--      SELECT id, email FROM "Seller" ORDER BY "createdAt" DESC LIMIT 20;
-- 2. Paste it into :seller_id below (keep the quotes).
-- 3. Run against the staging DB:
--      psql "$DATABASE_URL" -f scripts/seed-webpay-sandbox.sql
--    or from inside the container's network:
--      docker exec -i <postgres-container> psql -U <user> -d ekoru-dev < scripts/seed-webpay-sandbox.sql
-- ─────────────────────────────────────────────────────────────────────────────

\set seller_id 'dd73337a-f4d5-4bb8-9798-f81ced8d8c6e'

INSERT INTO "ChileanPaymentConfig"
  ("sellerId", "provider", "environment", "isActive", "createdAt", "updatedAt")
VALUES
  (:seller_id, 'WEBPAY', 'SANDBOX', true, now(), now())
ON CONFLICT ("sellerId", "provider")
DO UPDATE SET
  "environment" = EXCLUDED."environment",
  "isActive"    = true,
  "updatedAt"   = now();

-- Verify:
SELECT id, "sellerId", provider, environment, "isActive"
FROM "ChileanPaymentConfig"
WHERE "sellerId" = :seller_id;
