-- ═══════════════════════════════════════════════════════════════
-- TRIQLOG — Wallet Transactions Table
-- Add to triqlog/db/schema.sql
-- ═══════════════════════════════════════════════════════════════

CREATE TYPE wallet_provider AS ENUM (
  'CASHPLUS', 'WAFACASH', 'JIBI', 'FUEL_CARD', 'INTERNAL', 'BANK_WIRE'
);

CREATE TYPE wallet_bucket AS ENUM (
  'FUEL_CARD', 'CASH_OUT', 'ESCROW', 'PLATFORM', 'CNSS'
);

CREATE TABLE wallet_transactions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   VARCHAR(120) NOT NULL UNIQUE,

  -- Parties
  shipment_id       UUID        REFERENCES shipments(id),
  driver_id         UUID        REFERENCES users(id),

  -- Transfer details
  provider          wallet_provider NOT NULL,
  bucket            wallet_bucket   NOT NULL,
  to_phone          VARCHAR(20) NOT NULL,

  -- Amounts (MAD)
  amount_mad        DECIMAL(12,2) NOT NULL,
  fee_mad           DECIMAL(10,2) DEFAULT 0,
  net_mad           DECIMAL(12,2) NOT NULL,

  -- Status
  status            transfer_status NOT NULL DEFAULT 'PENDING',

  -- Provider references
  transaction_id    VARCHAR(80),    -- Provider's transaction ID
  provider_ref      VARCHAR(80),    -- Provider's internal ref

  -- Context
  reference         VARCHAR(60),    -- e.g. "LOT-8821-T1-FUEL"
  description       TEXT,
  metadata          JSONB,

  -- Reversal
  reversed          BOOLEAN DEFAULT FALSE,
  reversed_at       TIMESTAMPTZ,
  reversal_reason   TEXT,

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Create transfer_status enum if not exists
DO $$ BEGIN
  CREATE TYPE transfer_status AS ENUM (
    'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes
CREATE INDEX idx_wallet_tx_shipment   ON wallet_transactions(shipment_id);
CREATE INDEX idx_wallet_tx_driver     ON wallet_transactions(driver_id);
CREATE INDEX idx_wallet_tx_status     ON wallet_transactions(status);
CREATE INDEX idx_wallet_tx_provider   ON wallet_transactions(provider);
CREATE INDEX idx_wallet_tx_created    ON wallet_transactions(created_at DESC);
CREATE INDEX idx_wallet_tx_idempotent ON wallet_transactions(idempotency_key);

-- Add preferred provider + fuel card fields to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_wallet_provider wallet_provider DEFAULT 'CASHPLUS',
  ADD COLUMN IF NOT EXISTS cashplus_account     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS wafacash_phone       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS jibi_phone           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS afriquia_card_number VARCHAR(20);

-- Wallet summary view
CREATE VIEW v_driver_wallet_summary AS
SELECT
  u.id,
  u.full_name,
  u.phone,
  u.preferred_wallet_provider,
  u.wallet_balance,
  u.fuel_card_balance,
  COUNT(wt.id)                            AS total_transfers,
  SUM(CASE WHEN wt.bucket = 'CASH_OUT'  AND wt.status = 'SUCCESS' THEN wt.net_mad ELSE 0 END) AS total_cash_received,
  SUM(CASE WHEN wt.bucket = 'FUEL_CARD' AND wt.status = 'SUCCESS' THEN wt.net_mad ELSE 0 END) AS total_fuel_received,
  SUM(CASE WHEN wt.status = 'FAILED'    THEN 1 ELSE 0 END)          AS failed_transfers,
  MAX(wt.created_at)                      AS last_transfer_at
FROM users u
LEFT JOIN wallet_transactions wt ON wt.driver_id = u.id
WHERE u.role = 'DRIVER'
GROUP BY u.id, u.full_name, u.phone, u.preferred_wallet_provider,
         u.wallet_balance, u.fuel_card_balance;
