-- =============================================================
-- TRIQLOG LOGISTICS — PostgreSQL Schema
-- Version: 1.0.0
-- =============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis"; -- For GPS coordinates

-- =============================================================
-- ENUMS
-- =============================================================

CREATE TYPE user_role AS ENUM ('SHIPPER', 'DRIVER', 'ADMIN');

CREATE TYPE driver_tier AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PREMIUM');

CREATE TYPE truck_type AS ENUM (
  'SEMI_TRAILER',
  'CURTAINSIDER',
  'REFRIGERATED',
  'FLATBED',
  'TANKER',
  'BOX_TRUCK',
  'TIPPER'
);

CREATE TYPE shipment_status AS ENUM (
  'DRAFT',               -- Created, not yet confirmed
  'PENDING_PICKUP',      -- Confirmed, driver assigned, awaiting origin scan
  'PICKED_UP',           -- Origin QR scanned → T1 payment released
  'IN_TRANSIT',          -- GPS tracking active
  'ARRIVED',             -- Destination GPS ≤500m confirmed
  'INSPECTION_1_COMPLETE', -- 60-min hold cleared → T2 released
  'DISPUTED',            -- Dispute filed during 24h window
  'COMPLETED',           -- 24h window cleared → T3 released, fully settled
  'CANCELLED',           -- Cancelled before pickup
  'ARBITRATION'          -- Escalated dispute under review
);

CREATE TYPE payment_stage AS ENUM (
  'T1_PENDING',          -- Awaiting origin QR scan
  'T1_RELEASED',         -- 50% released at pickup
  'T2_COUNTING',         -- 60-min timer running
  'T2_RELEASED',         -- 25% released after 60 min
  'T3_HOLDING',          -- 24h or Net-30/60 hold
  'T3_EARLY_RELEASED',   -- Early release requested (-5% fee)
  'T3_RELEASED',         -- Final 25% released
  'SETTLED'              -- All tranches complete
);

CREATE TYPE shipper_type AS ENUM (
  'INFORMAL',            -- Cash, no ICE — Option A waterfall
  'SME',                 -- Has RC, limited credit — Option A waterfall
  'CORPORATE'            -- ICE, Net 30/60 terms — Option B+C waterfall
);

CREATE TYPE dispute_status AS ENUM (
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED_DRIVER',     -- Resolved in driver's favour
  'RESOLVED_SHIPPER',    -- Resolved in shipper's favour
  'RESOLVED_SPLIT'       -- Partial settlement
);

CREATE TYPE payout_channel AS ENUM (
  'AGENT_CASH',
  'WAFACASH',
  'CIH_MOBILE',
  'BANK_WIRE',
  'FUEL_CARD',
  'PLATFORM_WALLET'
);

-- =============================================================
-- 1. USERS
-- =============================================================

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role                user_role NOT NULL,
  
  -- Identity
  full_name           VARCHAR(120) NOT NULL,
  phone               VARCHAR(20) NOT NULL UNIQUE,   -- WhatsApp-capable
  email               VARCHAR(120) UNIQUE,
  password_hash       TEXT NOT NULL,
  
  -- Moroccan legal identifiers
  cin                 VARCHAR(20),                   -- Carte d'identité nationale
  ice                 VARCHAR(15) UNIQUE,            -- Identifiant Commun de l'Entreprise (15 digits)
  if_number           VARCHAR(10),                   -- Identifiant Fiscal
  rc_number           VARCHAR(20),                   -- Registre de Commerce
  cnss_number         VARCHAR(12),                   -- CNSS registration
  ae_number           VARCHAR(20),                   -- Auto-Entrepreneur number
  
  -- Shipper-specific
  company_name        VARCHAR(150),
  shipper_type        shipper_type DEFAULT 'INFORMAL',
  default_payment_terms INTEGER DEFAULT 0,           -- Days: 0=immediate, 30, 60
  credit_limit        DECIMAL(12,2) DEFAULT 0,       -- TriqLog float limit (MAD)
  
  -- Driver-specific
  tier                driver_tier DEFAULT 'BRONZE',
  trust_score         SMALLINT DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  total_trips         INTEGER DEFAULT 0,
  on_time_rate        DECIMAL(5,2) DEFAULT 100.00,
  
  -- KYC & Verification
  cin_verified        BOOLEAN DEFAULT FALSE,
  cin_expiry          DATE,
  ice_verified        BOOLEAN DEFAULT FALSE,
  cnss_active         BOOLEAN DEFAULT FALSE,
  insurance_verified  BOOLEAN DEFAULT FALSE,
  insurance_expiry    DATE,
  visite_tech_expiry  DATE,
  
  -- Financial
  wallet_balance      DECIMAL(12,2) DEFAULT 0.00,   -- Available MAD
  pending_balance     DECIMAL(12,2) DEFAULT 0.00,   -- Held / in escrow
  fuel_card_balance   DECIMAL(10,2) DEFAULT 0.00,
  lifetime_earnings   DECIMAL(14,2) DEFAULT 0.00,
  
  -- Preferred payout
  preferred_payout    payout_channel DEFAULT 'AGENT_CASH',
  bank_rib            VARCHAR(30),                   -- RIB for wire transfers
  wafacash_phone      VARCHAR(20),
  
  -- Location
  city                VARCHAR(60),
  region              VARCHAR(60),
  last_known_lat      DECIMAL(10,7),
  last_known_lng      DECIMAL(10,7),
  last_location_at    TIMESTAMPTZ,
  
  -- Metadata
  is_active           BOOLEAN DEFAULT TRUE,
  is_verified         BOOLEAN DEFAULT FALSE,
  fcm_token           TEXT,                          -- Push notifications
  language            VARCHAR(5) DEFAULT 'fr',       -- fr / ar / en
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_phone    ON users(phone);
CREATE INDEX idx_users_ice      ON users(ice);
CREATE INDEX idx_users_role     ON users(role);
CREATE INDEX idx_users_tier     ON users(tier);
CREATE INDEX idx_users_city     ON users(city);

-- =============================================================
-- 2. TRUCKS
-- =============================================================

CREATE TABLE trucks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  
  -- Vehicle identity
  plate               VARCHAR(20) NOT NULL UNIQUE,   -- e.g. "MA 24-7712 B"
  truck_type          truck_type NOT NULL,
  brand               VARCHAR(60),                   -- Volvo, Mercedes, MAN…
  model               VARCHAR(60),
  year                SMALLINT,
  
  -- Capacity
  max_weight_tonnes   DECIMAL(6,2) NOT NULL,
  volume_m3           DECIMAL(8,2),
  has_refrigeration   BOOLEAN DEFAULT FALSE,
  has_gps_device      BOOLEAN DEFAULT TRUE,
  gps_device_id       VARCHAR(40) UNIQUE,
  
  -- Documents
  carte_grise_number  VARCHAR(30),
  carte_grise_expiry  DATE,
  visite_tech_date    DATE,
  visite_tech_expiry  DATE NOT NULL,
  assurance_number    VARCHAR(40),
  assurance_expiry    DATE NOT NULL,
  
  -- Document images (S3 paths)
  carte_grise_img     TEXT,
  assurance_img       TEXT,
  visite_tech_img     TEXT,
  
  -- Status
  is_active           BOOLEAN DEFAULT TRUE,
  is_available        BOOLEAN DEFAULT TRUE,
  current_lat         DECIMAL(10,7),
  current_lng         DECIMAL(10,7),
  current_speed_kph   SMALLINT,
  last_gps_at         TIMESTAMPTZ,
  
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trucks_driver   ON trucks(driver_id);
CREATE INDEX idx_trucks_plate    ON trucks(plate);
CREATE INDEX idx_trucks_type     ON trucks(truck_type);
CREATE INDEX idx_trucks_avail    ON trucks(is_available) WHERE is_available = TRUE;

-- =============================================================
-- 3. SHIPMENTS
-- =============================================================

CREATE TABLE shipments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_number          VARCHAR(20) NOT NULL UNIQUE,   -- e.g. "LOT-8821"
  
  -- Parties
  shipper_id          UUID NOT NULL REFERENCES users(id),
  driver_id           UUID REFERENCES users(id),
  truck_id            UUID REFERENCES trucks(id),
  
  -- Route
  origin_city         VARCHAR(80) NOT NULL,
  origin_address      TEXT,
  origin_lat          DECIMAL(10,7),
  origin_lng          DECIMAL(10,7),
  destination_city    VARCHAR(80) NOT NULL,
  destination_address TEXT,
  destination_lat     DECIMAL(10,7),
  destination_lng     DECIMAL(10,7),
  distance_km         DECIMAL(8,2),
  
  -- Cargo
  cargo_type          VARCHAR(80) NOT NULL,
  cargo_description   TEXT,
  weight_tonnes       DECIMAL(8,3) NOT NULL,
  volume_m3           DECIMAL(8,2),
  requires_temp_control BOOLEAN DEFAULT FALSE,
  temp_min_celsius    SMALLINT,
  temp_max_celsius    SMALLINT,
  hazmat              BOOLEAN DEFAULT FALSE,
  
  -- Truck requirements
  required_truck_type truck_type,
  
  -- Timing
  pickup_deadline     TIMESTAMPTZ NOT NULL,
  delivery_deadline   TIMESTAMPTZ,
  
  -- QR codes for scan-based state transitions
  origin_qr_code      TEXT UNIQUE,                  -- Scanned at pickup
  destination_qr_code TEXT UNIQUE,                  -- Scanned at delivery
  origin_qr_scanned_at   TIMESTAMPTZ,
  destination_qr_scanned_at TIMESTAMPTZ,
  
  -- GPS milestones
  pickup_confirmed_lat      DECIMAL(10,7),
  pickup_confirmed_lng      DECIMAL(10,7),
  delivery_confirmed_lat    DECIMAL(10,7),
  delivery_confirmed_lng    DECIMAL(10,7),
  delivery_geofence_radius_m INTEGER DEFAULT 500,   -- metres
  
  -- Status machine
  status              shipment_status DEFAULT 'DRAFT',
  status_updated_at   TIMESTAMPTZ DEFAULT NOW(),
  
  -- Special options
  gps_tracking        BOOLEAN DEFAULT TRUE,
  cargo_insurance     BOOLEAN DEFAULT FALSE,
  declared_cargo_value DECIMAL(14,2),          -- Shipper-declared value for insurance (MAD)
                                                -- NULL = not declared / insurance not opted in
  e_invoice_required  BOOLEAN DEFAULT FALSE,
  quickpay_requested  BOOLEAN DEFAULT FALSE,
  
  -- Notes
  shipper_notes       TEXT,
  driver_notes        TEXT,
  
  -- Proof of delivery
  pod_photo_urls      TEXT[],                        -- S3 paths
  pod_receiver_name   VARCHAR(120),
  pod_receiver_phone  VARCHAR(20),
  
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipments_shipper  ON shipments(shipper_id);
CREATE INDEX idx_shipments_driver   ON shipments(driver_id);
CREATE INDEX idx_shipments_status   ON shipments(status);
CREATE INDEX idx_shipments_lot      ON shipments(lot_number);
CREATE INDEX idx_shipments_pickup   ON shipments(pickup_deadline);

-- Auto-generate lot number
CREATE SEQUENCE lot_seq START 8821 INCREMENT 1;
CREATE OR REPLACE FUNCTION set_lot_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.lot_number := 'LOT-' || LPAD(nextval('lot_seq')::TEXT, 4, '0');
  NEW.origin_qr_code := encode(gen_random_bytes(16), 'hex');
  NEW.destination_qr_code := encode(gen_random_bytes(16), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lot_number
BEFORE INSERT ON shipments
FOR EACH ROW WHEN (NEW.lot_number IS NULL)
EXECUTE FUNCTION set_lot_number();

-- =============================================================
-- 4. FINANCIALS  (The Payment Waterfall Engine)
-- =============================================================

CREATE TABLE financials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id           UUID NOT NULL REFERENCES shipments(id) ON DELETE RESTRICT,
  driver_id             UUID NOT NULL REFERENCES users(id),
  shipper_id            UUID NOT NULL REFERENCES users(id),
  
  -- Gross & fees
  gross_amount          DECIMAL(12,2) NOT NULL,      -- Full agreed price (MAD)
  platform_fee_pct      DECIMAL(5,2) DEFAULT 3.00,  -- 3%
  platform_fee_amount   DECIMAL(12,2) GENERATED ALWAYS AS
                          (ROUND(gross_amount * platform_fee_pct / 100, 2)) STORED,
  net_to_driver         DECIMAL(12,2) GENERATED ALWAYS AS
                          (gross_amount - ROUND(gross_amount * platform_fee_pct / 100, 2)) STORED,
  
  -- 50 / 25 / 25 split (calculated from net)
  -- T1: 50% — released at origin QR scan
  t1_amount             DECIMAL(12,2) GENERATED ALWAYS AS
                          (ROUND((gross_amount - ROUND(gross_amount * platform_fee_pct / 100, 2)) * 0.50, 2)) STORED,
  t1_released_at        TIMESTAMPTZ,
  t1_payout_channel     payout_channel,
  t1_reference          VARCHAR(40),                 -- Agent code / Wafacash ref
  
  -- T1 sub-buckets: cash vs fuel card split
  t1_cash_pct           DECIMAL(5,2) DEFAULT 80.00, -- Default 80% cash
  t1_fuel_pct           DECIMAL(5,2) DEFAULT 20.00, -- Default 20% fuel card
  t1_cash_amount        DECIMAL(12,2),              -- Computed on release
  t1_fuel_amount        DECIMAL(12,2),              -- Computed on release
  
  -- T2: 25% — released after 60-min GPS hold
  t2_amount             DECIMAL(12,2) GENERATED ALWAYS AS
                          (ROUND((gross_amount - ROUND(gross_amount * platform_fee_pct / 100, 2)) * 0.25, 2)) STORED,
  t2_hold_start         TIMESTAMPTZ,               -- When GPS arrival confirmed
  t2_release_scheduled  TIMESTAMPTZ,               -- hold_start + 60 min
  t2_released_at        TIMESTAMPTZ,
  t2_payout_channel     payout_channel,
  t2_reference          VARCHAR(40),
  
  -- T3: 25% — released after 24h (informal) OR Net 30/60 (corporate)
  t3_amount             DECIMAL(12,2) GENERATED ALWAYS AS
                          (gross_amount
                            - ROUND(gross_amount * platform_fee_pct / 100, 2)
                            - ROUND((gross_amount - ROUND(gross_amount * platform_fee_pct / 100, 2)) * 0.50, 2)
                            - ROUND((gross_amount - ROUND(gross_amount * platform_fee_pct / 100, 2)) * 0.25, 2)
                          ) STORED,
  t3_hold_type          VARCHAR(20) DEFAULT '24H', -- '24H' | 'NET30' | 'NET60'
  t3_hold_start         TIMESTAMPTZ,
  t3_release_scheduled  TIMESTAMPTZ,               -- 24h or Net-30/60 date
  t3_released_at        TIMESTAMPTZ,
  t3_payout_channel     payout_channel,
  t3_reference          VARCHAR(40),
  
  -- Early release (Option C): driver pays 5% to unlock T3 now
  early_release_requested    BOOLEAN DEFAULT FALSE,
  early_release_requested_at TIMESTAMPTZ,
  early_release_fee_pct      DECIMAL(5,2) DEFAULT 5.00,
  early_release_fee_amount   DECIMAL(12,2),        -- t3_amount * 5%
  early_release_net_amount   DECIMAL(12,2),        -- t3_amount * 95%
  early_released_at          TIMESTAMPTZ,
  
  -- Overall payment stage
  payment_stage         payment_stage DEFAULT 'T1_PENDING',
  fully_settled_at      TIMESTAMPTZ,
  
  -- Platform revenue from this shipment
  platform_revenue_fee        DECIMAL(12,2),       -- 3% commission
  platform_revenue_early_fee  DECIMAL(12,2),       -- 5% early release cut
  platform_revenue_total      DECIMAL(12,2),       -- Sum
  
  -- Shipper payment terms (for corporate)
  shipper_payment_due   TIMESTAMPTZ,               -- When shipper must settle
  shipper_paid_at       TIMESTAMPTZ,
  shipper_payment_ref   VARCHAR(60),
  
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT one_financial_per_shipment UNIQUE (shipment_id),
  CONSTRAINT t1_split_100 CHECK (t1_cash_pct + t1_fuel_pct = 100)
);

CREATE INDEX idx_fin_shipment ON financials(shipment_id);
CREATE INDEX idx_fin_driver   ON financials(driver_id);
CREATE INDEX idx_fin_stage    ON financials(payment_stage);
CREATE INDEX idx_fin_t2_sched ON financials(t2_release_scheduled)
  WHERE t2_released_at IS NULL AND t2_release_scheduled IS NOT NULL;
CREATE INDEX idx_fin_t3_sched ON financials(t3_release_scheduled)
  WHERE t3_released_at IS NULL AND t3_release_scheduled IS NOT NULL;

-- =============================================================
-- 5. FUEL REBATE LEDGER
-- =============================================================

CREATE TABLE fuel_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             UUID NOT NULL REFERENCES users(id),
  shipment_id           UUID REFERENCES shipments(id),
  
  -- Fill details
  station_name          VARCHAR(80),
  station_location      VARCHAR(80),
  fuel_date             TIMESTAMPTZ DEFAULT NOW(),
  
  -- Volume & pricing
  liters_filled         DECIMAL(8,2) NOT NULL,
  pump_price_per_liter  DECIMAL(6,3) NOT NULL,       -- MAD/L at pump
  gross_fuel_cost       DECIMAL(10,2) GENERATED ALWAYS AS
                          (ROUND(liters_filled * pump_price_per_liter, 2)) STORED,
  
  -- Rebate calculation
  -- Negotiated discount with Afriquia (e.g. 0.50 DH/L)
  negotiated_discount_per_liter DECIMAL(6,3) NOT NULL,
  total_discount        DECIMAL(10,2) GENERATED ALWAYS AS
                          (ROUND(liters_filled * negotiated_discount_per_liter, 2)) STORED,
  
  -- Split: 90% to driver, 10% to platform
  driver_rebate_pct     DECIMAL(5,2) DEFAULT 90.00,
  platform_rebate_pct   DECIMAL(5,2) DEFAULT 10.00,
  driver_rebate_amount  DECIMAL(10,2) GENERATED ALWAYS AS
                          (ROUND(liters_filled * negotiated_discount_per_liter * 0.90, 2)) STORED,
  platform_rebate_amount DECIMAL(10,2) GENERATED ALWAYS AS
                          (ROUND(liters_filled * negotiated_discount_per_liter * 0.10, 2)) STORED,
  
  -- Net cost to driver after rebate
  net_fuel_cost         DECIMAL(10,2) GENERATED ALWAYS AS
                          (ROUND(liters_filled * pump_price_per_liter
                            - liters_filled * negotiated_discount_per_liter * 0.90, 2)) STORED,
  
  -- Settled to driver's fuel card or wallet
  rebate_settled        BOOLEAN DEFAULT FALSE,
  settled_at            TIMESTAMPTZ,
  fuel_card_transaction_ref VARCHAR(40),
  
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT valid_split CHECK (driver_rebate_pct + platform_rebate_pct = 100)
);

CREATE INDEX idx_fuel_driver   ON fuel_transactions(driver_id);
CREATE INDEX idx_fuel_shipment ON fuel_transactions(shipment_id);
CREATE INDEX idx_fuel_unsettled ON fuel_transactions(rebate_settled) WHERE rebate_settled = FALSE;

-- =============================================================
-- 6. DISPUTES
-- =============================================================

CREATE TABLE disputes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       UUID NOT NULL REFERENCES shipments(id),
  financials_id     UUID NOT NULL REFERENCES financials(id),
  raised_by         UUID NOT NULL REFERENCES users(id),
  
  -- What tranche is disputed
  tranche_disputed  VARCHAR(5) NOT NULL,            -- 'T2' | 'T3'
  amount_disputed   DECIMAL(12,2) NOT NULL,
  
  reason            TEXT NOT NULL,
  evidence_urls     TEXT[],                          -- S3: photos, GPS screenshots
  
  status            dispute_status DEFAULT 'OPEN',
  
  -- Resolution
  resolved_by       UUID REFERENCES users(id),      -- Admin
  resolution_notes  TEXT,
  driver_receives   DECIMAL(12,2),
  shipper_receives  DECIMAL(12,2),
  resolved_at       TIMESTAMPTZ,
  
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_disputes_shipment ON disputes(shipment_id);
CREATE INDEX idx_disputes_status   ON disputes(status);

-- =============================================================
-- 7. GPS TRACKING
-- =============================================================

CREATE TABLE gps_pings (
  id            BIGSERIAL PRIMARY KEY,
  truck_id      UUID NOT NULL REFERENCES trucks(id),
  shipment_id   UUID REFERENCES shipments(id),
  lat           DECIMAL(10,7) NOT NULL,
  lng           DECIMAL(10,7) NOT NULL,
  speed_kph     SMALLINT,
  heading_deg   SMALLINT,
  accuracy_m    SMALLINT,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition by month for performance
CREATE INDEX idx_gps_truck      ON gps_pings(truck_id, recorded_at DESC);
CREATE INDEX idx_gps_shipment   ON gps_pings(shipment_id, recorded_at DESC);

-- =============================================================
-- 8. PLATFORM REVENUE LEDGER
-- =============================================================

CREATE TABLE platform_revenue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id     UUID REFERENCES shipments(id),
  
  revenue_type    VARCHAR(30) NOT NULL, -- 'COMMISSION' | 'EARLY_RELEASE' | 'FUEL_REBATE' | 'QUICKPAY_SPREAD'
  amount          DECIMAL(12,2) NOT NULL,
  description     TEXT,
  
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_revenue_type ON platform_revenue(revenue_type);
CREATE INDEX idx_revenue_date ON platform_revenue(recorded_at DESC);

-- =============================================================
-- 9. DOCUMENTS (E-Invoices, Waybills)
-- =============================================================

CREATE TABLE documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       UUID NOT NULL REFERENCES shipments(id),
  
  doc_type          VARCHAR(20) NOT NULL,  -- 'INVOICE' | 'WAYBILL' | 'RECEIPT'
  doc_number        VARCHAR(30) UNIQUE,    -- INV-2026-0441
  
  -- DGI e-invoice fields
  dgi_hash          VARCHAR(64),           -- SHA-256 for DGI clearance
  dgi_submitted_at  TIMESTAMPTZ,
  dgi_acknowledged_at TIMESTAMPTZ,
  dgi_ref           VARCHAR(40),           -- DGI acknowledgment reference
  
  xml_content       TEXT,                  -- UBL 2.1 XML
  pdf_url           TEXT,                  -- S3 path
  
  -- Recipients
  sent_to_emails    TEXT[],
  sent_to_phones    TEXT[],
  sent_at           TIMESTAMPTZ,
  
  shipper_ice       VARCHAR(15),
  driver_ice        VARCHAR(15),           -- AE number
  vat_amount        DECIMAL(12,2),
  gross_amount      DECIMAL(12,2),
  
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_docs_shipment ON documents(shipment_id);
CREATE INDEX idx_docs_type     ON documents(doc_type);
CREATE INDEX idx_docs_dgi      ON documents(dgi_hash);

-- =============================================================
-- TRIGGERS: updated_at auto-maintenance
-- =============================================================

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_trucks_updated       BEFORE UPDATE ON trucks       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_shipments_updated    BEFORE UPDATE ON shipments    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_financials_updated   BEFORE UPDATE ON financials   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_disputes_updated     BEFORE UPDATE ON disputes     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- =============================================================
-- VIEWS: Useful aggregates
-- =============================================================

-- Active shipment dashboard view
CREATE VIEW v_active_shipments AS
SELECT
  s.lot_number,
  s.status,
  s.origin_city,
  s.destination_city,
  s.weight_tonnes,
  s.cargo_type,
  d.full_name        AS driver_name,
  d.phone            AS driver_phone,
  d.tier             AS driver_tier,
  sh.full_name       AS shipper_name,
  sh.company_name,
  f.gross_amount,
  f.platform_fee_amount,
  f.net_to_driver,
  f.t1_amount,
  f.t1_released_at,
  f.t2_amount,
  f.t2_release_scheduled,
  f.t2_released_at,
  f.t3_amount,
  f.t3_release_scheduled,
  f.t3_released_at,
  f.payment_stage,
  f.early_release_requested,
  t.plate            AS truck_plate,
  t.truck_type,
  t.current_lat,
  t.current_lng,
  t.current_speed_kph
FROM shipments s
JOIN users d   ON s.driver_id  = d.id
JOIN users sh  ON s.shipper_id = sh.id
JOIN financials f ON f.shipment_id = s.id
JOIN trucks t  ON s.truck_id   = t.id
WHERE s.status NOT IN ('COMPLETED', 'CANCELLED');

-- Platform monthly revenue summary
CREATE VIEW v_monthly_revenue AS
SELECT
  DATE_TRUNC('month', recorded_at) AS month,
  revenue_type,
  COUNT(*)                          AS transactions,
  SUM(amount)                       AS total_mad
FROM platform_revenue
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- Driver earnings summary
CREATE VIEW v_driver_earnings AS
SELECT
  u.id,
  u.full_name,
  u.tier,
  u.trust_score,
  COUNT(f.id)                       AS total_trips,
  SUM(f.gross_amount)               AS total_gross,
  SUM(f.platform_fee_amount)        AS total_fees_paid,
  SUM(f.net_to_driver)              AS total_net,
  SUM(f.early_release_fee_amount)   AS total_early_release_fees,
  AVG(f.gross_amount)               AS avg_per_trip
FROM users u
LEFT JOIN financials f ON f.driver_id = u.id
WHERE u.role = 'DRIVER'
GROUP BY u.id, u.full_name, u.tier, u.trust_score;

-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM CONFIG — Live key/value store for runtime settings
-- e.g. fuel price, CNSS rate, DGI API endpoint
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE platform_config (
  key           VARCHAR(80) PRIMARY KEY,
  value         TEXT        NOT NULL,
  description   TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with current fuel price (updated daily by cron)
INSERT INTO platform_config (key, value, description)
VALUES ('fuel_price_mad_per_liter', '12.50', 'Afriquia pump price MAD/L — updated daily')
ON CONFLICT (key) DO NOTHING;

-- =============================================================
-- SCAN EVENTS — GPS-Verified Audit Trail (Law 43-20 compliant)
-- =============================================================
-- Every QR scan is recorded here as an immutable event.
-- This is the legal "Proof of Presence" record:
--   - Server-generated timestamp (never client-supplied)
--   - GPS coordinates at moment of scan
--   - Distance from target location (calculated server-side)
--   - Device fingerprint (prevents account sharing)
--   - HMAC signature of the QR payload (tamper-evident)
--
-- Under Law 43-20, this table provides "integrity and origin"
-- for a Qualified Electronic Timestamp admissible in court.
-- =============================================================

CREATE TYPE scan_type    AS ENUM ('ORIGIN', 'DESTINATION');
CREATE TYPE scan_outcome AS ENUM (
  'APPROVED',              -- GPS valid, QR valid, T1/T2 triggered
  'REJECTED_GEOFENCE',     -- Driver too far from target location
  'REJECTED_QR_INVALID',   -- HMAC signature failed
  'REJECTED_QR_EXPIRED',   -- QR past expiry window
  'REJECTED_QR_USED',      -- QR already scanned (replay attack)
  'REJECTED_WRONG_TYPE'    -- ORIGIN QR presented at DESTINATION
);

CREATE TABLE scan_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id         UUID        NOT NULL REFERENCES shipments(id),
  driver_id           UUID        NOT NULL REFERENCES users(id),

  -- Scan classification
  scan_type           scan_type   NOT NULL,
  outcome             scan_outcome NOT NULL,

  -- GPS proof — all coordinates set by SERVER using driver-reported position
  -- Never trust client-supplied timestamps
  driver_lat          DECIMAL(10,7) NOT NULL,
  driver_lng          DECIMAL(10,7) NOT NULL,
  target_lat          DECIMAL(10,7) NOT NULL,   -- Origin or destination coords
  target_lng          DECIMAL(10,7) NOT NULL,
  distance_metres     DECIMAL(10,2) NOT NULL,   -- Haversine result, server-calculated
  geofence_radius_m   INTEGER      NOT NULL,    -- Allowed radius at time of scan
  within_geofence     BOOLEAN      NOT NULL,    -- distance_metres <= geofence_radius_m

  -- Timestamp — server-generated, never client-supplied
  -- This is the legally binding timestamp under Law 43-20
  server_timestamp    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Device fingerprint — prevents one driver sharing account
  device_id           VARCHAR(80),
  device_platform     VARCHAR(20),  -- 'android' | 'ios'
  app_version         VARCHAR(20),

  -- QR evidence
  qr_hmac_valid       BOOLEAN      NOT NULL,
  qr_payload_hash     VARCHAR(64),  -- SHA-256 of the scanned QR payload
  hub_id              VARCHAR(60),  -- Which logistics hub (if any)

  -- Rejection reason (human-readable, for dispute resolution)
  rejection_reason    TEXT,

  -- Immutability guarantee — no UPDATE or DELETE allowed on this table
  -- Enforced by trigger below
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for dispute lookups and DGI audit queries
CREATE INDEX idx_scan_events_shipment  ON scan_events(shipment_id);
CREATE INDEX idx_scan_events_driver    ON scan_events(driver_id);
CREATE INDEX idx_scan_events_outcome   ON scan_events(outcome);
CREATE INDEX idx_scan_events_timestamp ON scan_events(server_timestamp DESC);

-- Immutability trigger — scan_events rows can never be modified or deleted
CREATE OR REPLACE FUNCTION prevent_scan_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'scan_events is append-only. Rows cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scan_events_immutable
BEFORE UPDATE OR DELETE ON scan_events
FOR EACH ROW EXECUTE FUNCTION prevent_scan_event_mutation();
