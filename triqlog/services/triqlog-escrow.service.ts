/**
 * TRIQLOG — Triple-Lock Escrow Service
 * 
 * Manages the 3-stage payout waterfall using BullMQ queues backed by Redis.
 * All timers survive server restarts. All state transitions are idempotent.
 * 
 * Stage 1 (T1): Origin QR Scan → release 50% net immediately
 * Stage 2 (T2): Destination QR Scan → 60-min timer → release 25%
 * Stage 3 (T3): Informal: 24h timer → release 25%
 *               Corporate: Net-30/60 → release 25% (or Early Release -5%)
 */

import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { Pool } from 'pg';
import IORedis from 'ioredis';

// ─── Redis connection ────────────────────────────────────────────────────────
const redis = new IORedis({
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,   // Required by BullMQ
});

// ─── PostgreSQL pool ─────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

// ─── Queue definitions ───────────────────────────────────────────────────────
const QUEUES = {
  T1_RELEASE:     'triqlog:t1-release',
  T2_HOLD_START:  'triqlog:t2-hold-start',
  T2_RELEASE:     'triqlog:t2-release',
  T3_HOLD_START:  'triqlog:t3-hold-start',
  T3_RELEASE:     'triqlog:t3-release',
  EARLY_RELEASE:  'triqlog:early-release',
  NOTIFICATIONS:  'triqlog:notifications',
  DOCUMENTS:      'triqlog:documents',
};

const queueOpts = { connection: redis };

export const t1Queue         = new Queue(QUEUES.T1_RELEASE,    queueOpts);
export const t2HoldQueue     = new Queue(QUEUES.T2_HOLD_START, queueOpts);
export const t2ReleaseQueue  = new Queue(QUEUES.T2_RELEASE,    queueOpts);
export const t3HoldQueue     = new Queue(QUEUES.T3_HOLD_START, queueOpts);
export const t3ReleaseQueue  = new Queue(QUEUES.T3_RELEASE,    queueOpts);
export const earlyReleaseQueue = new Queue(QUEUES.EARLY_RELEASE, queueOpts);
export const notifQueue      = new Queue(QUEUES.NOTIFICATIONS, queueOpts);
export const docQueue        = new Queue(QUEUES.DOCUMENTS,     queueOpts);

// ─── Types ───────────────────────────────────────────────────────────────────
interface EscrowPayload {
  shipmentId:   string;
  financialId:  string;
  driverId:     string;
  shipperId:    string;
  grossAmount:  number;
  shipperType:  'INFORMAL' | 'SME' | 'CORPORATE';
  paymentTerms: number;   // days: 0 | 30 | 60
}

interface T1Payload extends EscrowPayload {
  t1Amount:     number;
  t1CashPct:    number;
  t1FuelPct:    number;
  isExpress:    boolean;   // true = EXPRESS_PREMIUM applied in computeSplit
  scannedAt:    string;
  originLat:    number;
  originLng:    number;
}

interface T2Payload extends EscrowPayload {
  t2Amount:         number;
  holdStartAt:      string;
  releaseScheduled: string;
  arrivalLat:       number;
  arrivalLng:       number;
}

interface T3Payload extends EscrowPayload {
  t3Amount:         number;
  holdStartAt:      string;
  releaseScheduled: string;
}

interface EarlyReleasePayload {
  shipmentId:    string;
  financialId:   string;
  driverId:      string;
  t3Amount:      number;
  earlyFeePct:   number;  // 6% — EXPRESS_HELD_RATE applied retroactively
  earlyFeeAmt:   number;
  earlyNetAmt:   number;
  requestedAt:   string;
}

// ─── Helper: compute financial split ────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// FEE CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Revenue model (on a MAD 5,000 load, MAD 50,000 cargo value):
//
//  Stream 1 — SHIPPER_CONVENIENCE_FEE  = load × 3%            → +MAD 150
//  Stream 2 — DRIVER_BASE_FEE          = load × 3%            → −MAD 150
//  Stream 3 — EXPRESS_PREMIUM          = (load × 50%) × 6%   → −MAD 150  (express only)
//  Stream 4 — CARGO_INSURANCE          = cargo × 0.1% profit  → +MAD 50   (opt-in only)
//
//  Standard no insurance:  TriqLog MAD 300  · Driver MAD 4,850
//  Standard + insurance:   TriqLog MAD 350  · Driver MAD 4,850
//  Express  + insurance:   TriqLog MAD 500  · Driver MAD 4,700
//
const SHIPPER_FEE_RATE  = 0.03;   // 3% added on top of load value — paid by shipper
const DRIVER_FEE_RATE   = 0.03;   // 3% of load value — deducted from driver
const EXPRESS_HELD_RATE = 0.06;   // 6% of the held 50% only — express upgrade fee

export interface SplitResult {
  // Inputs
  loadValue:          number;   // Agreed load price (what shipper sees before fees)
  isExpress:          boolean;

  // Shipper side
  shipperConvenienceFee: number;  // load × 3% — shipper pays this on top
  shipperTotal:          number;  // loadValue + shipperConvenienceFee

  // Driver side
  driverBaseFee:         number;  // load × 3% — always deducted
  expressPremium:        number;  // (load × 50%) × 6% — only if express
  driverNet:             number;  // loadValue − driverBaseFee − expressPremium

  // 50/25/25 tranches (of driverNet)
  t1:  number;   // 50% — released at Origin QR scan
  t2:  number;   // 25% — released after 60-min GPS hold
  t3:  number;   // 25% — held until Net30/60 or 24h; express = already accounted for

  // Platform revenue — three distinct streams
  revenue: {
    shipperFee:    number;   // SHIPPER_CONVENIENCE_FEE stream
    driverFee:     number;   // DRIVER_BASE_FEE stream
    expressFee:    number;   // EXPRESS_PREMIUM stream (0 if standard)
    total:         number;   // sum of all three
  };
}

/**
 * computeSplit — refactored to separate the three revenue streams.
 *
 * @param loadValue   The agreed load price (what shipper budgets before fees)
 * @param isExpress   Whether the driver selected Express payout (T3 now at +6%)
 */
export function computeSplit(loadValue: number, isExpress = false): SplitResult {
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // ── Shipper convenience fee (added on top) ──────────────────────────────
  const shipperConvenienceFee = r2(loadValue * SHIPPER_FEE_RATE);
  const shipperTotal          = r2(loadValue + shipperConvenienceFee);

  // ── Driver base fee (always deducted from load value) ───────────────────
  const driverBaseFee = r2(loadValue * DRIVER_FEE_RATE);

  // ── Express premium (6% on the held 50% only) ───────────────────────────
  const heldHalf      = r2(loadValue * 0.50);
  const expressPremium = isExpress ? r2(heldHalf * EXPRESS_HELD_RATE) : 0;

  // ── Driver net ───────────────────────────────────────────────────────────
  const driverNet = r2(loadValue - driverBaseFee - expressPremium);

  // ── 50/25/25 tranches ────────────────────────────────────────────────────
  const t1 = r2(driverNet * 0.50);
  const t2 = r2(driverNet * 0.25);
  const t3 = r2(driverNet - t1 - t2);   // remainder avoids rounding drift

  // ── Platform revenue streams ─────────────────────────────────────────────
  const revenue = {
    shipperFee:  shipperConvenienceFee,
    driverFee:   driverBaseFee,
    expressFee:  expressPremium,
    total:       r2(shipperConvenienceFee + driverBaseFee + expressPremium),
  };

  return {
    loadValue, isExpress,
    shipperConvenienceFee, shipperTotal,
    driverBaseFee, expressPremium, driverNet,
    t1, t2, t3,
    revenue,
  };
}

/**
 * computeEarlyRelease — driver requests T3 now after standard payout was chosen.
 * This is separate from Express (chosen upfront). Early release applies the
 * express premium retroactively on T3 only.
 */
export function computeEarlyRelease(t3: number): {
  t3Gross:    number;
  earlyFee:   number;   // 6% of t3 (same rate as EXPRESS_HELD_RATE)
  driverNet:  number;
} {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const earlyFee  = r2(t3 * EXPRESS_HELD_RATE);
  const driverNet = r2(t3 - earlyFee);
  return { t3Gross: t3, earlyFee, driverNet };
}

// ─────────────────────────────────────────────────────────────────────────────
// CARGO INSURANCE ENGINE (Opt-in)
// ─────────────────────────────────────────────────────────────────────────────
//
// Partnership model with Saham / AXA Maroc.
// Rate is automatically calculated from the declared cargo value —
// shipper does not pick a rate, they only declare the cargo value.
//
// Tiered wholesale rates (what TriqLog pays Saham/AXA):
//   ≤ MAD 10,000              → 0.15%
//   MAD 10,001 – 50,000       → 0.12%
//   MAD 50,001 – 150,000      → 0.10%
//   MAD 150,001 – 500,000     → 0.08%
//   > MAD 500,000             → 0.06%
//
// Retail rate charged to shipper is always 2× wholesale (100% margin).
//
// If declared_cargo_value is NULL, defaults to the load value (freight price).
// Shipper can override upward if cargo is worth more than the freight rate.
//
// Shippers with own corporate insurance (OCP, Stellantis) simply don't opt in.
//
interface InsuranceTier {
  maxValue:      number;    // Upper bound of this tier (Infinity for last tier)
  wholesaleRate: number;    // TriqLog's cost rate
  retailRate:    number;    // 2× wholesale — always 100% margin
  label:         string;    // Human-readable tier name
}

const INSURANCE_TIERS: InsuranceTier[] = [
  { maxValue:     10_000, wholesaleRate: 0.0015, retailRate: 0.0030, label: 'Micro'      },
  { maxValue:     50_000, wholesaleRate: 0.0012, retailRate: 0.0024, label: 'Standard'   },
  { maxValue:    150_000, wholesaleRate: 0.0010, retailRate: 0.0020, label: 'Commercial' },
  { maxValue:    500_000, wholesaleRate: 0.0008, retailRate: 0.0016, label: 'Premium'    },
  { maxValue: Infinity,   wholesaleRate: 0.0006, retailRate: 0.0012, label: 'Enterprise' },
];

/**
 * Returns the correct insurance tier for a given cargo value.
 * Rate is derived automatically — shipper only inputs the cargo value.
 */
function getInsuranceTier(cargoValue: number): InsuranceTier {
  return INSURANCE_TIERS.find(t => cargoValue <= t.maxValue) ?? INSURANCE_TIERS[INSURANCE_TIERS.length - 1];
}

export interface InsuranceResult {
  declaredCargoValue: number;
  tier:               string;    // 'Micro' | 'Standard' | 'Commercial' | 'Premium' | 'Enterprise'
  retailRate:         number;    // Rate shown to shipper — this is all they see
  chargedToShipper:   number;    // MAD — the only number the shipper ever sees
  coverageType:       string;    // 'ALL_RISKS_TRANSPORT'

  // ── Internal accounting only — never expose via API or UI ─────────────────
  // These fields are for TriqLog's ledger, Saham/AXA reconciliation,
  // and the platform_revenue table. Never send to shipper or driver.
  _internal: {
    wholesaleRate:  number;   // What TriqLog pays Saham/AXA
    wholesaleCost:  number;   // MAD — TriqLog's actual cost
    netProfit:      number;   // MAD — spread (always 100% margin)
  };
}

/**
 * Pure function — no side effects.
 * Rate is derived automatically from cargoValue using the tier table.
 * If shipper did not declare a separate cargo value, pass the load value (freight price).
 *
 * @param cargoValue   Declared cargo value in MAD
 *                     Defaults to load value if shipper did not declare separately
 */
export function calculateInsuranceFees(cargoValue: number): InsuranceResult {
  if (cargoValue <= 0) {
    throw new Error('Declared cargo value must be greater than zero');
  }

  const r2   = (n: number) => Math.round(n * 100) / 100;
  const tier = getInsuranceTier(cargoValue);

  const wholesaleCost    = r2(cargoValue * tier.wholesaleRate);
  const chargedToShipper = r2(cargoValue * tier.retailRate);
  const netProfit        = r2(chargedToShipper - wholesaleCost);

  return {
    declaredCargoValue: cargoValue,
    tier:               tier.label,
    retailRate:         tier.retailRate,    // Only the shipper-facing rate
    chargedToShipper,                       // Only number shipper ever sees
    coverageType:       'ALL_RISKS_TRANSPORT',

    // Internal — kept off all API responses and driver/shipper UIs
    _internal: {
      wholesaleRate: tier.wholesaleRate,
      wholesaleCost,
      netProfit,
    },
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// VERIFIED PICKUP — The "Proof of Presence" Gate
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the single entry point that enforces the full validation chain
// before any money moves. All three conditions must pass atomically:
//
//   1. QR payload is valid (HMAC-SHA256, not expired, not already used)
//   2. Driver GPS is within geofence of the pickup location
//   3. Timestamp is server-generated — never accepted from client
//
// Under Law 43-20 (Morocco), the resulting scan_event record constitutes
// a Qualified Electronic Timestamp with "integrity and origin" proof.
// In a commercial court dispute, this is treated as physical evidence.
//
export interface VerifiedScanInput {
  shipmentId:    string;
  driverId:      string;
  qrPayload:     string;    // Raw string from camera scan
  scanType:      'ORIGIN' | 'DESTINATION';
  driverLat:     number;    // Reported by device GPS
  driverLng:     number;    // Reported by device GPS
  deviceId:      string;    // Unique device fingerprint (prevents account sharing)
  devicePlatform: 'android' | 'ios';
  appVersion:    string;
}

export interface VerifiedScanResult {
  approved:       boolean;
  outcome:        string;
  scanEventId:    string;   // UUID of the scan_events record — include in all receipts
  distanceMetres: number;   // How far driver was from target
  serverTimestamp: Date;    // The legally binding timestamp
  rejectionReason?: string;
}

export async function verifyAndTriggerPickup(
  input: VerifiedScanInput
): Promise<VerifiedScanResult> {

  const { shipmentId, driverId, qrPayload, scanType, driverLat, driverLng, deviceId } = input;

  // Server-generated timestamp — this is what goes on the legal record
  // Client-supplied timestamps are ignored entirely
  const serverTimestamp = new Date();

  // ── 1. Fetch shipment target coordinates ─────────────────────────────────
  const { rows } = await db.query(`
    SELECT
      origin_lat, origin_lng, destination_lat, destination_lng,
      delivery_geofence_radius_m, status, origin_qr_code, destination_qr_code
    FROM shipments WHERE id = $1
  `, [shipmentId]);

  if (!rows[0]) {
    return _recordAndReject(input, serverTimestamp, 0, 0, 0, 500,
      'REJECTED_QR_INVALID', 'Shipment not found');
  }

  const s          = rows[0];
  const targetLat  = scanType === 'ORIGIN' ? s.origin_lat      : s.destination_lat;
  const targetLng  = scanType === 'ORIGIN' ? s.origin_lng      : s.destination_lng;
  const radiusM    = s.delivery_geofence_radius_m ?? 500;

  // ── 2. Verify QR payload (HMAC-SHA256) ───────────────────────────────────
  const { verifyQR } = require('./triqlog-qr.service');
  const qrCheck = verifyQR(qrPayload, scanType);

  if (!qrCheck.valid) {
    const outcomeMap: Record<string, string> = {
      'INVALID_SIGNATURE':   'REJECTED_QR_INVALID',
      'EXPIRED':             'REJECTED_QR_EXPIRED',
      'WRONG_QR_TYPE':       'REJECTED_WRONG_TYPE',
      'PARSE_ERROR':         'REJECTED_QR_INVALID',
    };
    const outcome = outcomeMap[qrCheck.reason] ?? 'REJECTED_QR_INVALID';
    return _recordAndReject(input, serverTimestamp,
      targetLat, targetLng,
      haversineMetres(driverLat, driverLng, targetLat, targetLng),
      radiusM, outcome, qrCheck.reason);
  }

  // ── 3. Check QR not already used (replay attack prevention) ──────────────
  const { rows: usedCheck } = await db.query(`
    SELECT id FROM scan_events
    WHERE shipment_id = $1 AND scan_type = $2 AND outcome = 'APPROVED'
    LIMIT 1
  `, [shipmentId, scanType]);

  if (usedCheck.length > 0) {
    return _recordAndReject(input, serverTimestamp,
      targetLat, targetLng,
      haversineMetres(driverLat, driverLng, targetLat, targetLng),
      radiusM, 'REJECTED_QR_USED', 'QR already scanned for this shipment');
  }

  // ── 4. Geofence check — server calculates distance, never trusts client ──
  const distanceM = haversineMetres(driverLat, driverLng, targetLat, targetLng);
  const withinFence = distanceM <= radiusM;

  if (!withinFence) {
    return _recordAndReject(input, serverTimestamp,
      targetLat, targetLng, distanceM, radiusM,
      'REJECTED_GEOFENCE',
      `Driver is ${Math.round(distanceM)}m from target — maximum allowed is ${radiusM}m`);
  }

  // ── 5. All checks passed — write immutable scan_event ────────────────────
  const crypto    = require('crypto');
  const payloadHash = crypto.createHash('sha256').update(qrPayload).digest('hex');

  const { rows: eventRows } = await db.query(`
    INSERT INTO scan_events (
      shipment_id, driver_id, scan_type, outcome,
      driver_lat, driver_lng, target_lat, target_lng,
      distance_metres, geofence_radius_m, within_geofence,
      server_timestamp, device_id, device_platform, app_version,
      qr_hmac_valid, qr_payload_hash
    ) VALUES ($1,$2,$3,'APPROVED',$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12,$13,TRUE,$14)
    RETURNING id
  `, [
    shipmentId, driverId, scanType,
    driverLat, driverLng, targetLat, targetLng,
    distanceM, radiusM,
    serverTimestamp,
    deviceId, input.devicePlatform, input.appVersion,
    payloadHash,
  ]);

  const scanEventId = eventRows[0].id;

  // ── 6. Write GPS stamp to shipment record ─────────────────────────────────
  if (scanType === 'ORIGIN') {
    await db.query(`
      UPDATE shipments SET
        pickup_confirmed_lat   = $1,
        pickup_confirmed_lng   = $2,
        origin_qr_scanned_at   = $3,
        status                 = 'PICKED_UP',
        updated_at             = NOW()
      WHERE id = $4
    `, [driverLat, driverLng, serverTimestamp, shipmentId]);

    // Trigger T1 payout
    await onOriginQRScan({
      shipmentId,
      driverId,
      grossAmount:  0,   // Fetched inside the worker from financials table
      isExpress:    false,
      t1CashPct:    80,
      t1FuelPct:    20,
      scannedAt:    serverTimestamp.toISOString(),
      originLat:    driverLat,
      originLng:    driverLng,
    } as any);

  } else {
    await db.query(`
      UPDATE shipments SET
        delivery_confirmed_lat     = $1,
        delivery_confirmed_lng     = $2,
        destination_qr_scanned_at  = $3,
        status                     = 'ARRIVED',
        updated_at                 = NOW()
      WHERE id = $4
    `, [driverLat, driverLng, serverTimestamp, shipmentId]);
  }

  console.log(
    `[SCAN] ✅ ${scanType} APPROVED — ${shipmentId} | ` +
    `driver ${Math.round(distanceM)}m from target | ` +
    `event: ${scanEventId} | ${serverTimestamp.toISOString()}`
  );

  return {
    approved:        true,
    outcome:         'APPROVED',
    scanEventId,
    distanceMetres:  distanceM,
    serverTimestamp,
  };
}

// ── Helper: write rejected scan_event and return result ────────────────────
async function _recordAndReject(
  input:           VerifiedScanInput,
  serverTimestamp: Date,
  targetLat:       number,
  targetLng:       number,
  distanceM:       number,
  radiusM:         number,
  outcome:         string,
  reason:          string
): Promise<VerifiedScanResult> {

  const { rows } = await db.query(`
    INSERT INTO scan_events (
      shipment_id, driver_id, scan_type, outcome,
      driver_lat, driver_lng, target_lat, target_lng,
      distance_metres, geofence_radius_m, within_geofence,
      server_timestamp, device_id, device_platform, app_version,
      qr_hmac_valid, rejection_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING id
  `, [
    input.shipmentId, input.driverId, input.scanType, outcome,
    input.driverLat, input.driverLng, targetLat, targetLng,
    distanceM, radiusM, distanceM <= radiusM,
    serverTimestamp,
    input.deviceId, input.devicePlatform, input.appVersion,
    outcome !== 'REJECTED_GEOFENCE',   // QR was valid if rejection was geofence
    reason,
  ]).catch(() => ({ rows: [{ id: 'unknown' }] }));

  console.log(`[SCAN] ❌ ${input.scanType} ${outcome} — ${input.shipmentId} | ${reason}`);

  return {
    approved:        false,
    outcome,
    scanEventId:     rows[0]?.id ?? 'unknown',
    distanceMetres:  distanceM,
    serverTimestamp,
    rejectionReason: reason,
  };
}

// Haversine — already in geofence service, duplicated here to keep escrow self-contained
function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6_371_000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


export async function onOriginQRScan(payload: T1Payload): Promise<void> {
  await t1Queue.add('release-t1', payload, {
    attempts:    3,
    backoff:     { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 100 },
  });
  console.log(`[ESCROW] T1 queued for shipment ${payload.shipmentId}`);
}

/**
 * Triggered when GPS confirms arrival ≤500m from destination.
 * Queues T2 to release after 60-minute hold.
 * Also queues T3 based on shipper type.
 */
export async function onDestinationGPSConfirm(payload: T2Payload & T3Payload): Promise<void> {
  const now     = new Date();
  const t2At    = new Date(now.getTime() + 60 * 60 * 1000);       // +60 minutes
  
  let t3Delay: number;
  if (payload.shipperType === 'CORPORATE') {
    const days  = payload.paymentTerms || 30;
    t3Delay     = days * 24 * 60 * 60 * 1000;                      // Net 30 or 60
  } else {
    t3Delay     = 24 * 60 * 60 * 1000;                             // 24 hours
  }

  // Queue T2 with 60-min delay
  await t2ReleaseQueue.add('release-t2', {
    ...payload,
    holdStartAt:      now.toISOString(),
    releaseScheduled: t2At.toISOString(),
  }, {
    delay:    60 * 60 * 1000,
    jobId:    `t2-${payload.shipmentId}`,          // Idempotent: dedup by shipmentId
    attempts: 5,
    backoff:  { type: 'exponential', delay: 5000 },
  });

  // Queue T3 with 24h or Net-30/60 delay
  const t3At = new Date(now.getTime() + t3Delay);
  await t3ReleaseQueue.add('release-t3', {
    ...payload,
    holdStartAt:      now.toISOString(),
    releaseScheduled: t3At.toISOString(),
  }, {
    delay:    t3Delay,
    jobId:    `t3-${payload.shipmentId}`,
    attempts: 5,
    backoff:  { type: 'exponential', delay: 5000 },
  });

  // Update DB with scheduled times
  await db.query(`
    UPDATE financials SET
      t2_hold_start        = $1,
      t2_release_scheduled = $2,
      t3_hold_start        = $1,
      t3_release_scheduled = $3,
      t3_hold_type         = $4,
      payment_stage        = 'T2_COUNTING',
      updated_at           = NOW()
    WHERE shipment_id = $5
  `, [now, t2At, t3At,
      payload.shipperType === 'CORPORATE' ? `NET${payload.paymentTerms}` : '24H',
      payload.shipmentId]);

  console.log(`[ESCROW] T2 scheduled at ${t2At.toISOString()} for ${payload.shipmentId}`);
  console.log(`[ESCROW] T3 scheduled at ${t3At.toISOString()} for ${payload.shipmentId}`);
}

/**
 * Triggered when driver requests Early Release on T3.
 * Cancels the scheduled T3 job and processes immediately at -5%.
 */
export async function requestEarlyRelease(
  shipmentId: string,
  driverId:   string
): Promise<void> {
  const row = await db.query(`
    SELECT f.*, s.shipper_id
    FROM financials f
    JOIN shipments s ON s.id = f.shipment_id
    WHERE f.shipment_id = $1 AND f.driver_id = $2
      AND f.t3_released_at IS NULL
      AND f.early_released_at IS NULL
      AND f.t2_released_at IS NOT NULL
  `, [shipmentId, driverId]);

  if (!row.rows[0]) {
    throw new Error('Early release not available: T2 not yet cleared or T3 already released');
  }

  const fin = row.rows[0];
  const { earlyFee, driverNet } = computeEarlyRelease(parseFloat(fin.t3_amount));

  // Cancel the scheduled T3 job
  const t3Job = await t3ReleaseQueue.getJob(`t3-${shipmentId}`);
  if (t3Job) await t3Job.remove();

  // Queue early release (immediate)
  await earlyReleaseQueue.add('early-release', {
    shipmentId,
    financialId:  fin.id,
    driverId,
    t3Amount:     parseFloat(fin.t3_amount),
    earlyFeePct:  6,                  // EXPRESS_HELD_RATE applied retroactively
    earlyFeeAmt:  earlyFee,
    earlyNetAmt:  driverNet,
    requestedAt:  new Date().toISOString(),
  } as EarlyReleasePayload, {
    attempts: 5,
    backoff:  { type: 'exponential', delay: 2000 },
  });

  // Mark requested in DB
  await db.query(`
    UPDATE financials SET
      early_release_requested    = TRUE,
      early_release_requested_at = NOW(),
      early_release_fee_pct      = 6,
      early_release_fee_amount   = $1,
      early_release_net_amount   = $2,
      updated_at                 = NOW()
    WHERE shipment_id = $3
  `, [fee, net, shipmentId]);

  console.log(`[ESCROW] Early release queued for ${shipmentId}: net MAD ${net}`);
}

/**
 * File a dispute — pauses T2 or T3 automatic release.
 */
export async function fileDispute(
  shipmentId:     string,
  raisedById:     string,
  tranche:        'T2' | 'T3',
  reason:         string,
  evidenceUrls:   string[]
): Promise<void> {
  // Pause the relevant timer
  const jobId = tranche === 'T2' ? `t2-${shipmentId}` : `t3-${shipmentId}`;
  const queue = tranche === 'T2' ? t2ReleaseQueue : t3ReleaseQueue;
  const job   = await queue.getJob(jobId);
  if (job) await job.remove();   // BullMQ: remove to prevent auto-release

  const fin = await db.query(
    'SELECT id, t2_amount, t3_amount FROM financials WHERE shipment_id = $1',
    [shipmentId]
  );
  const amount = tranche === 'T2'
    ? fin.rows[0].t2_amount
    : fin.rows[0].t3_amount;

  await db.query(`
    INSERT INTO disputes
      (shipment_id, financials_id, raised_by, tranche_disputed, amount_disputed, reason, evidence_urls)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [shipmentId, fin.rows[0].id, raisedById, tranche, amount, reason, evidenceUrls]);

  await db.query(`
    UPDATE shipments SET status = 'DISPUTED', updated_at = NOW()
    WHERE id = $1
  `, [shipmentId]);

  // Notify admin
  await notifQueue.add('dispute-alert', {
    type:       'DISPUTE_FILED',
    shipmentId,
    tranche,
    raisedById,
    reason,
  });

  console.log(`[ESCROW] Dispute filed on ${tranche} for ${shipmentId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKERS: Process the queued jobs
// ─────────────────────────────────────────────────────────────────────────────

const workerOpts = {
  connection:  redis,
  concurrency: 10,
};

// ─── Worker: T1 Release ──────────────────────────────────────────────────────
new Worker(QUEUES.T1_RELEASE, async (job: Job<T1Payload>) => {
  const d      = job.data;
  const split  = computeSplit(d.grossAmount, d.isExpress ?? false);
  const cashAmt = Math.round(split.t1 * d.t1CashPct) / 100;
  const fuelAmt = Math.round(split.t1 * d.t1FuelPct) / 100;

  // ── Fetch insurance opt-in status ────────────────────────────────────────
  // Insurance is optional — only calculate if shipper opted in AND
  // declared a cargo value when creating the shipment.
  const { rows: insuranceRows } = await db.query(`
    SELECT cargo_insurance, declared_cargo_value
    FROM shipments WHERE id = $1
  `, [d.shipmentId]);

  const cargoInsured      = insuranceRows[0]?.cargo_insurance === true;
  const declaredCargoValue = insuranceRows[0]?.declared_cargo_value
    ? parseFloat(insuranceRows[0].declared_cargo_value)
    : null;

  let insurance: ReturnType<typeof calculateInsuranceFees> | null = null;
  if (cargoInsured && declaredCargoValue && declaredCargoValue > 0) {
    insurance = calculateInsuranceFees(declaredCargoValue);
    console.log(
      `[T1] Insurance opted in for ${d.shipmentId}: ` +
      `cargo MAD ${declaredCargoValue} | tier: ${insurance.tier} | ` +
      `rate ${(insurance.retailRate * 100).toFixed(3)}% retail | ` +
      `charged MAD ${insurance.chargedToShipper} | ` +
      `cost MAD ${insurance._internal.wholesaleCost} | ` +
      `profit MAD ${insurance._internal.netProfit}`
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Release T1 to driver wallet
    await client.query(`
      UPDATE users SET
        wallet_balance  = wallet_balance  + $1,
        pending_balance = pending_balance - $1,
        updated_at      = NOW()
      WHERE id = $2
    `, [cashAmt, d.driverId]);

    // Top up fuel card balance
    await client.query(`
      UPDATE users SET
        fuel_card_balance = fuel_card_balance + $1,
        updated_at        = NOW()
      WHERE id = $2
    `, [fuelAmt, d.driverId]);

    // ── Record THREE distinct platform revenue streams ──────────────────
    // 1. Shipper convenience fee (3% added on top — shipper already paid this)
    await client.query(`
      INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
      VALUES ($1, 'SHIPPER_CONVENIENCE_FEE', $2, 'Shipper 3% convenience fee — LOT')
    `, [d.shipmentId, split.revenue.shipperFee]);

    // 2. Driver base fee (3% deducted from driver)
    await client.query(`
      INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
      VALUES ($1, 'DRIVER_BASE_FEE', $2, 'Driver 3% base platform fee — LOT')
    `, [d.shipmentId, split.revenue.driverFee]);

    // 3. Express premium (6% on held 50% — only if express, otherwise 0)
    if (split.revenue.expressFee > 0) {
      await client.query(`
        INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
        VALUES ($1, 'EXPRESS_PREMIUM', $2, 'Express upgrade 6% on held 50% — LOT')
      `, [d.shipmentId, split.revenue.expressFee]);
    }

    // 4. Cargo insurance profit (opt-in only — internal spread, never shown externally)
    if (insurance) {
      await client.query(`
        INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
        VALUES ($1, 'CARGO_INSURANCE', $2, $3)
      `, [
        d.shipmentId,
        insurance._internal.netProfit,
        `Cargo insurance spread — declared MAD ${insurance.declaredCargoValue} | ` +
        `charged MAD ${insurance.chargedToShipper}`,
      ]);
    }

    // Update financials
    await client.query(`
      UPDATE financials SET
        t1_released_at  = NOW(),
        t1_cash_amount  = $1,
        t1_fuel_amount  = $2,
        payment_stage   = 'T1_RELEASED',
        updated_at      = NOW()
      WHERE shipment_id = $3
    `, [cashAmt, fuelAmt, d.shipmentId]);

    // Update shipment status
    await client.query(`
      UPDATE shipments SET
        status            = 'PICKED_UP',
        origin_qr_scanned_at = $1,
        pickup_confirmed_lat = $2,
        pickup_confirmed_lng = $3,
        updated_at        = NOW()
      WHERE id = $4
    `, [d.scannedAt, d.originLat, d.originLng, d.shipmentId]);

    await client.query('COMMIT');

    // Send notifications & generate waybill
    await notifQueue.add('t1-released', {
      driverId:   d.driverId,
      shipmentId: d.shipmentId,
      cashAmount: cashAmt,
      fuelAmount: fuelAmt,
      totalT1:    t1,
    });

    await docQueue.add('generate-waybill', {
      shipmentId: d.shipmentId,
      trigger:    'ORIGIN_SCAN',
    });

    console.log(`[T1] Released MAD ${cashAmt} cash + MAD ${fuelAmt} fuel for ${d.shipmentId}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}, workerOpts);

// ─── Worker: T2 Release (after 60-min hold) ──────────────────────────────────
new Worker(QUEUES.T2_RELEASE, async (job: Job<T2Payload>) => {
  const d = job.data;

  // Check if dispute exists — abort if so
  const dispute = await db.query(`
    SELECT id FROM disputes
    WHERE shipment_id = $1 AND tranche_disputed = 'T2' AND status IN ('OPEN', 'UNDER_REVIEW')
  `, [d.shipmentId]);

  if (dispute.rows.length > 0) {
    console.log(`[T2] Held for dispute on ${d.shipmentId}`);
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE users SET
        wallet_balance  = wallet_balance  + $1,
        pending_balance = pending_balance - $1,
        updated_at      = NOW()
      WHERE id = $2
    `, [d.t2Amount, d.driverId]);

    await client.query(`
      UPDATE financials SET
        t2_released_at = NOW(),
        payment_stage  = 'T2_RELEASED',
        updated_at     = NOW()
      WHERE shipment_id = $1
    `, [d.shipmentId]);

    await client.query(`
      UPDATE shipments SET
        status     = 'INSPECTION_1_COMPLETE',
        updated_at = NOW()
      WHERE id = $1
    `, [d.shipmentId]);

    await client.query('COMMIT');

    await notifQueue.add('t2-released', {
      driverId:   d.driverId,
      shipmentId: d.shipmentId,
      amount:     d.t2Amount,
      message:    `60-min hold cleared. MAD ${d.t2Amount} released.`,
    });

    console.log(`[T2] Released MAD ${d.t2Amount} for ${d.shipmentId}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}, workerOpts);

// ─── Worker: T3 Release (24h or Net-30/60) ───────────────────────────────────
new Worker(QUEUES.T3_RELEASE, async (job: Job<T3Payload>) => {
  const d = job.data;

  // Check for active dispute
  const dispute = await db.query(`
    SELECT id FROM disputes
    WHERE shipment_id = $1 AND tranche_disputed = 'T3' AND status IN ('OPEN', 'UNDER_REVIEW')
  `, [d.shipmentId]);

  if (dispute.rows.length > 0) {
    console.log(`[T3] Held for dispute on ${d.shipmentId}`);
    return;
  }

  // Check T3 not already released (early release could have fired)
  const fin = await db.query(`
    SELECT t3_released_at, early_released_at FROM financials WHERE shipment_id = $1
  `, [d.shipmentId]);

  if (fin.rows[0]?.t3_released_at || fin.rows[0]?.early_released_at) {
    console.log(`[T3] Already released for ${d.shipmentId}, skipping`);
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE users SET
        wallet_balance    = wallet_balance    + $1,
        pending_balance   = pending_balance   - $1,
        lifetime_earnings = lifetime_earnings + $1,
        total_trips       = total_trips       + 1,
        updated_at        = NOW()
      WHERE id = $2
    `, [d.t3Amount, d.driverId]);

    await client.query(`
      UPDATE financials SET
        t3_released_at      = NOW(),
        payment_stage       = 'T3_RELEASED',
        fully_settled_at    = NOW(),
        platform_revenue_fee        = platform_fee_amount,
        platform_revenue_early_fee  = COALESCE(early_release_fee_amount, 0),
        platform_revenue_total      = platform_fee_amount + COALESCE(early_release_fee_amount, 0),
        updated_at          = NOW()
      WHERE shipment_id = $1
    `, [d.shipmentId]);

    await client.query(`
      UPDATE shipments SET
        status     = 'COMPLETED',
        updated_at = NOW()
      WHERE id = $1
    `, [d.shipmentId]);

    await client.query('COMMIT');

    // Generate DGI-compliant invoice (only after full settlement)
    await docQueue.add('generate-einvoice', {
      shipmentId: d.shipmentId,
      trigger:    'T3_SETTLED',
    }, { delay: 2000 }); // 2s grace to ensure DB committed

    await notifQueue.add('trip-settled', {
      driverId:   d.driverId,
      shipperId:  d.shipperId,
      shipmentId: d.shipmentId,
      t3Amount:   d.t3Amount,
      message:    `Trip fully settled. Final MAD ${d.t3Amount} released.`,
    });

    console.log(`[T3] Fully settled shipment ${d.shipmentId}. MAD ${d.t3Amount} released`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}, workerOpts);

// ─── Worker: Early Release ───────────────────────────────────────────────────
new Worker(QUEUES.EARLY_RELEASE, async (job: Job<EarlyReleasePayload>) => {
  const d = job.data;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Release reduced T3 to driver
    await client.query(`
      UPDATE users SET
        wallet_balance    = wallet_balance    + $1,
        pending_balance   = pending_balance   - $2,
        lifetime_earnings = lifetime_earnings + $1,
        total_trips       = total_trips       + 1,
        updated_at        = NOW()
      WHERE id = $3
    `, [d.earlyNetAmt, d.t3Amount, d.driverId]);

    // Record early release fee as platform revenue
    await client.query(`
      INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
      VALUES ($1, 'EXPRESS_PREMIUM', $2, 'Early Release — EXPRESS_HELD_RATE 6% on T3')
    `, [d.shipmentId, d.earlyFeeAmt]);

    await client.query(`
      UPDATE financials SET
        early_released_at           = NOW(),
        payment_stage               = 'T3_EARLY_RELEASED',
        fully_settled_at            = NOW(),
        platform_revenue_early_fee  = $1,
        platform_revenue_total      = platform_fee_amount + $1,
        updated_at                  = NOW()
      WHERE shipment_id = $2
    `, [d.earlyFeeAmt, d.shipmentId]);

    await client.query(`
      UPDATE shipments SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = $1
    `, [d.shipmentId]);

    await client.query('COMMIT');

    // Generate invoice after early release too
    await docQueue.add('generate-einvoice', {
      shipmentId: d.shipmentId,
      trigger:    'EARLY_RELEASE_SETTLED',
    }, { delay: 2000 });

    await notifQueue.add('early-release-processed', {
      driverId:     d.driverId,
      shipmentId:   d.shipmentId,
      netAmount:    d.earlyNetAmt,
      feeAmount:    d.earlyFeeAmt,
    });

    console.log(`[EARLY] Released MAD ${d.earlyNetAmt} (fee: MAD ${d.earlyFeeAmt}) for ${d.shipmentId}`);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}, workerOpts);

// ─── Queue event monitoring (logging / alerting) ─────────────────────────────
const monitorQueue = (name: string, queue: Queue) => {
  const events = new QueueEvents(name, { connection: redis });
  events.on('failed',    ({ jobId, failedReason }) =>
    console.error(`[QUEUE ERROR] ${name} job ${jobId} failed: ${failedReason}`)
  );
  events.on('stalled',   ({ jobId }) =>
    console.warn(`[QUEUE STALL] ${name} job ${jobId} stalled`)
  );
};

monitorQueue(QUEUES.T1_RELEASE,    t1Queue);
monitorQueue(QUEUES.T2_RELEASE,    t2ReleaseQueue);
monitorQueue(QUEUES.T3_RELEASE,    t3ReleaseQueue);
monitorQueue(QUEUES.EARLY_RELEASE, earlyReleaseQueue);

export default {
  onOriginQRScan,
  onDestinationGPSConfirm,
  requestEarlyRelease,
  fileDispute,
  computeSplit,
  computeEarlyRelease,
  calculateInsuranceFees,
};
