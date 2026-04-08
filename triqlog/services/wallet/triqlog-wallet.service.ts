/**
 * TRIQLOG — Wallet Service
 *
 * Listens for QR_SCAN_SUCCESS events from the Geofence service.
 * Executes the split transfer on Origin scan (T1):
 *
 *   Gross Amount
 *     − Platform fee (3% Standard or 6% Express)
 *     = Net to driver
 *       → T1 (50% of net) released immediately:
 *           30% of T1 → Fuel Wallet  (Afriquia card)
 *           20% of T1 → Cash Out     (CashPlus / Wafacash / Jibi)
 *       → T2 (25% of net) held in escrow → released by 60-min timer
 *       → T3 (25% of net) held in escrow → released by 24h timer or shipper settlement
 *
 * On Destination scan:
 *   → Starts T2 countdown (handled by escrow service)
 *   → Records delivery confirmation in wallet ledger
 *
 * All transfers are:
 *   - Idempotent (UUID idempotency key per transfer leg)
 *   - Atomic (PostgreSQL transaction wraps all DB writes)
 *   - Retried (3 attempts, exponential backoff via withRetry)
 *   - Logged (wallet_transactions table)
 *   - Reversible (reverse() on every provider)
 */

import { Pool }              from 'pg';
import IORedis               from 'ioredis';
import { Queue, Worker }     from 'bullmq';
import { v4 as uuid }        from 'uuid';

import {
  QRScanSuccessEvent, WalletSplitResult, WalletTransferRequest,
  WalletTransferResult, WalletProvider, PayoutMode,
} from './triqlog-wallet.types';

import {
  CashPlusAdapter,
  WafacashAdapter,
  JibiAdapter,
  AfriquiaFuelCardAdapter,
} from './triqlog-wallet.providers';

import { estimateRequiredFuel } from '../triqlog-fuel.service';

// ─── Infrastructure ──────────────────────────────────────────────────────────
const db    = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  maxRetriesPerRequest: null,
});

const walletQueue  = new Queue('triqlog:wallet',        { connection: redis });
const notifQueue   = new Queue('triqlog:notifications', { connection: redis });
const escrowQueue  = new Queue('triqlog:t1-release',    { connection: redis });

// ─── Fee constants — three distinct revenue streams ─────────────────────────
//
//   SHIPPER_CONVENIENCE_FEE  = loadValue × 3%          → Paid by shipper on top
//   DRIVER_BASE_FEE          = loadValue × 3%          → Deducted from driver always
//   EXPRESS_PREMIUM          = (loadValue × 50%) × 6%  → Only when express chosen
//
//   Standard (MAD 5,000):  TriqLog = MAD 300 (150+150+0)    Driver = MAD 4,850
//   Express  (MAD 5,000):  TriqLog = MAD 450 (150+150+150)  Driver = MAD 4,700
//
const SHIPPER_FEE_RATE   = 0.03;   // Added on top — SHIPPER_CONVENIENCE_FEE
const DRIVER_FEE_RATE    = 0.03;   // Deducted from driver — DRIVER_BASE_FEE
const EXPRESS_HELD_RATE  = 0.06;   // On held 50% only — EXPRESS_PREMIUM

// T1 wallet buckets (as % of driver net, not of T1)
const T1_FUEL_OF_NET = 0.30;   // 30% of net → Afriquia Fuel Card
const T1_CASH_OF_NET = 0.20;   // 20% of net → Cash Out (CashPlus / Wafacash / Jibi)

// ─── Provider registry ────────────────────────────────────────────────────────
const PROVIDERS = {
  CASHPLUS:  new CashPlusAdapter(),
  WAFACASH:  new WafacashAdapter(),
  JIBI:      new JibiAdapter(),
  FUEL_CARD: new AfriquiaFuelCardAdapter(),
} as const;

function getProvider(name: WalletProvider) {
  const p = PROVIDERS[name as keyof typeof PROVIDERS];
  if (!p) throw new Error(`Unknown wallet provider: ${name}`);
  return p;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SPLIT CALCULATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure function — no side effects.
 * Implements the corrected three-stream revenue model.
 *
 * @param loadValue    The agreed load price (what shipper budgets before fees)
 * @param isExpress    Driver chose Express: T3 released immediately, +6% on held half
 * @param paymentTerms Days until shipper bank transfer clears (0=informal, 30, 60)
 */
export function calculateWalletSplit(
  loadValue:    number,
  isExpress:    boolean   = false,
  paymentTerms: number    = 0
): WalletSplitResult {

  const r2 = (n: number) => Math.round(n * 100) / 100;

  // ── Three revenue streams ────────────────────────────────────────────────
  const shipperFee  = r2(loadValue * SHIPPER_FEE_RATE);   // Paid by shipper on top
  const driverFee   = r2(loadValue * DRIVER_FEE_RATE);    // Always deducted from driver
  const heldHalf    = r2(loadValue * 0.50);
  const expressFee  = isExpress ? r2(heldHalf * EXPRESS_HELD_RATE) : 0;

  const totalFee    = r2(shipperFee + driverFee + expressFee);
  const feePercent  = r2((totalFee / loadValue) * 100);

  // ── Driver net ───────────────────────────────────────────────────────────
  const netAmount   = r2(loadValue - driverFee - expressFee);

  // ── 50 / 25 / 25 tranches ────────────────────────────────────────────────
  const t1Total     = r2(netAmount * 0.50);
  const t2Amount    = r2(netAmount * 0.25);
  const t3Amount    = r2(netAmount - t1Total - t2Amount);

  // ── T1 wallet buckets ────────────────────────────────────────────────────
  const t1FuelAmount = r2(netAmount * T1_FUEL_OF_NET);    // 30% of net
  const t1CashAmount = r2(t1Total - t1FuelAmount);        // 20% of net

  // ── T3 hold type ─────────────────────────────────────────────────────────
  let t3HoldType: WalletSplitResult['t3HoldType'];
  if (isExpress)                t3HoldType = 'IMMEDIATE';
  else if (paymentTerms === 60) t3HoldType = 'NET60';
  else if (paymentTerms === 30) t3HoldType = 'NET30';
  else                          t3HoldType = '24H';

  return {
    grossAmount:  loadValue,
    payoutMode:   isExpress ? 'EXPRESS' : 'STANDARD',
    feePercent,
    feeAmount:    totalFee,
    netAmount,
    t1Total,
    t1FuelAmount,
    t1CashAmount,
    t2Amount,
    t3Amount,
    t3HoldType,
    platformFee:  totalFee,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. QR_SCAN_SUCCESS EVENT LISTENER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the triqlog:qr-scan-success Redis channel.
 * Published by geofence.service.ts after checkQRPermission() succeeds.
 */
export function startWalletEventListener(): void {
  const subscriber = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    maxRetriesPerRequest: null,
  });

  subscriber.subscribe('triqlog:qr-scan-success', (err) => {
    if (err) console.error('[WALLET] Subscribe error:', err);
    else     console.log('[WALLET] Listening for QR_SCAN_SUCCESS events');
  });

  subscriber.on('message', async (channel, message) => {
    if (channel !== 'triqlog:qr-scan-success') return;

    try {
      const event: QRScanSuccessEvent = JSON.parse(message);
      console.log(`[WALLET] QR_SCAN_SUCCESS — ${event.scanType} — ${event.lotNumber}`);

      // Queue the wallet split job (BullMQ for retry safety)
      await walletQueue.add(
        `wallet-split-${event.scanType.toLowerCase()}`,
        event,
        {
          jobId:    `wallet:${event.shipmentId}:${event.scanType}`,
          attempts: 5,
          backoff:  { type: 'exponential', delay: 2000 },
        }
      );
    } catch (err) {
      console.error('[WALLET] Failed to queue wallet split:', err);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. WALLET SPLIT WORKER
// ─────────────────────────────────────────────────────────────────────────────

new Worker('triqlog:wallet', async (job) => {
  const event: QRScanSuccessEvent = job.data;

  if (event.scanType === 'ORIGIN') {
    await executeT1Split(event);
  } else if (event.scanType === 'DESTINATION') {
    await recordDeliveryConfirmation(event);
  }
}, {
  connection:  redis,
  concurrency: 20,   // Handle many simultaneous deliveries
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. T1 SPLIT — ORIGIN SCAN
// ─────────────────────────────────────────────────────────────────────────────

async function executeT1Split(event: QRScanSuccessEvent): Promise<void> {
  const {
    shipmentId, lotNumber, driverId, driverPhone, driverName,
    shipperId, payoutMode, grossAmount, preferredProvider,
  } = event;

  // Get payment terms from DB (corporate vs informal)
  const { rows } = await db.query(`
    SELECT
      u.shipper_type,
      u.default_payment_terms,
      f.id AS financials_id
    FROM shipments s
    JOIN users u       ON u.id = s.shipper_id
    JOIN financials f  ON f.shipment_id = s.id
    WHERE s.id = $1
      AND f.t1_released_at IS NULL   -- Idempotency: don't double-pay
  `, [shipmentId]);

  if (!rows[0]) {
    console.log(`[WALLET] T1 already released for ${shipmentId} — skipping`);
    return;
  }

  const paymentTerms = rows[0].default_payment_terms || 0;
  const financialsId = rows[0].financials_id;
  const split        = calculateWalletSplit(grossAmount, payoutMode === 'EXPRESS', paymentTerms);

  // ── Cap fuel card at estimated trip fuel cost ─────────────────────────────
  // Fuel card should only load what the driver needs for this specific trip.
  // Any T1 fuel budget above the estimate is redirected to cash out.
  // This prevents idle fuel card balance and potential misuse.
  let fuelCardAmount = split.t1FuelAmount;
  let cashOutAmount  = split.t1CashAmount;
  let fuelCapApplied = false;
  let fuelEstimate: number | null = null;

  try {
    const est = await estimateRequiredFuel(shipmentId);
    fuelEstimate = est.driverNetCostMAD;   // What the trip actually costs after rebate

    if (fuelCardAmount > fuelEstimate) {
      const overflow = round2(fuelCardAmount - fuelEstimate);
      fuelCardAmount = fuelEstimate;
      cashOutAmount  = round2(cashOutAmount + overflow);
      fuelCapApplied = true;
      console.log(
        `[WALLET] Fuel cap applied for ${lotNumber}: ` +
        `T1 fuel MAD ${split.t1FuelAmount} → capped at MAD ${fuelCardAmount} ` +
        `(estimate: MAD ${fuelEstimate}) | overflow MAD ${overflow} → cash`
      );
    }
  } catch (err) {
    // If estimation fails (no distance set, no truck assigned yet),
    // fall back to the percentage-based split — do not block the payout
    console.warn(`[WALLET] Fuel estimate unavailable for ${shipmentId}, using percentage split:`, err);
  }

  console.log(`[WALLET] T1 split for ${lotNumber}:
    Gross: MAD ${split.grossAmount}
    Fee (${split.feePercent}%): −MAD ${split.feeAmount}
    Net: MAD ${split.netAmount}
    T1 Fuel → Afriquia: MAD ${fuelCardAmount}${fuelCapApplied ? ` (capped from MAD ${split.t1FuelAmount}, est: MAD ${fuelEstimate})` : ''}
    T1 Cash → ${preferredProvider}: MAD ${cashOutAmount}${fuelCapApplied ? ' (includes fuel overflow)' : ''}
    T2 escrow: MAD ${split.t2Amount}
    T3 escrow: MAD ${split.t3Amount} (${split.t3HoldType})`);

  // Build idempotency keys — deterministic from shipmentId
  const fuelKey = `triqlog:${shipmentId}:t1:fuel`;
  const cashKey = `triqlog:${shipmentId}:t1:cash`;

  // ── Execute both transfers concurrently ─────────────────────────────────
  const [fuelResult, cashResult] = await Promise.allSettled([
    executeTransfer({
      idempotencyKey: fuelKey,
      fromAccount:    process.env.TRIQLOG_PLATFORM_ACCOUNT!,
      toPhone:        driverPhone,
      toName:         driverName,
      amountMAD:      fuelCardAmount,
      bucket:         'FUEL_CARD',
      provider:       'FUEL_CARD',
      reference:      `${lotNumber}-T1-FUEL`,
      description:    `TriqLog ${lotNumber} — Fuel card (trip estimate: MAD ${fuelEstimate ?? 'N/A'})`,
      metadata:       { shipmentId, lotNumber, leg: 'T1_FUEL', capped: fuelCapApplied, estimate: fuelEstimate },
    }),
    executeTransfer({
      idempotencyKey: cashKey,
      fromAccount:    process.env.TRIQLOG_PLATFORM_ACCOUNT!,
      toPhone:        driverPhone,
      toName:         driverName,
      amountMAD:      cashOutAmount,
      bucket:         'CASH_OUT',
      provider:       preferredProvider,
      reference:      `${lotNumber}-T1-CASH`,
      description:    `TriqLog ${lotNumber} — Cash out${fuelCapApplied ? ' (+ fuel overflow)' : ''}`,
      metadata:       { shipmentId, lotNumber, leg: 'T1_CASH', fuelOverflowIncluded: fuelCapApplied },
    }),
  ]);

  const fuelOk = fuelResult.status === 'fulfilled' && fuelResult.value.success;
  const cashOk = cashResult.status === 'fulfilled' && cashResult.value.success;

  const fuelTxId = fuelOk ? (fuelResult as PromiseFulfilledResult<WalletTransferResult>).value.transactionId : null;
  const cashTxId = cashOk ? (cashResult as PromiseFulfilledResult<WalletTransferResult>).value.transactionId : null;

  // ── Persist to DB atomically ─────────────────────────────────────────────
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Update financials — store actual amounts transferred, not percentage targets
    await client.query(`
      UPDATE financials SET
        t1_released_at      = NOW(),
        t1_cash_amount      = $1,
        t1_fuel_amount      = $2,
        payment_stage       = 'T1_RELEASED',
        platform_fee_amount = $3,
        updated_at          = NOW()
      WHERE id = $4
    `, [cashOutAmount, fuelCardAmount, split.feeAmount, financialsId]);

    // Log platform revenue
    await client.query(`
      INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
      VALUES ($1, 'COMMISSION', $2, $3)
    `, [shipmentId, split.feeAmount, `${payoutMode} fee ${split.feePercent}% — ${lotNumber}`]);

    // Update driver wallet balance in users table
    await client.query(`
      UPDATE users SET
        wallet_balance    = wallet_balance    + $1,
        fuel_card_balance = fuel_card_balance + $2,
        updated_at        = NOW()
      WHERE id = $3
    `, [split.t1CashAmount, split.t1FuelAmount, driverId]);

    // Update shipment status
    await client.query(`
      UPDATE shipments SET
        status            = 'PICKED_UP',
        origin_qr_scanned_at = NOW(),
        updated_at        = NOW()
      WHERE id = $1
    `, [shipmentId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');

    // If DB failed but transfers went through — attempt reversals
    if (fuelOk && fuelTxId) {
      await PROVIDERS.FUEL_CARD.reverse(fuelTxId, 'DB_COMMIT_FAILED').catch(() => null);
    }
    if (cashOk && cashTxId) {
      await getProvider(preferredProvider).reverse(cashTxId!, 'DB_COMMIT_FAILED').catch(() => null);
    }
    throw err;
  } finally {
    client.release();
  }

  // ── Notify driver ────────────────────────────────────────────────────────
  await notifQueue.add('t1-wallet-split', {
    driverId,
    driverPhone,
    shipmentId,
    lotNumber,
    fuelAmount:  split.t1FuelAmount,
    cashAmount:  split.t1CashAmount,
    t2Amount:    split.t2Amount,
    t3Amount:    split.t3Amount,
    t3HoldType:  split.t3HoldType,
    payoutMode,
    fuelOk,
    cashOk,
    message: fuelOk && cashOk
      ? `💰 MAD ${split.t1CashAmount} → ${preferredProvider} · ⛽ MAD ${split.t1FuelAmount} → Afriquia`
      : `⚠️ Transfert partiel — contactez le support`,
  });

  // ── Trigger T2 + T3 timers via escrow service ────────────────────────────
  await escrowQueue.add('start-t2-t3', {
    shipmentId,
    financialsId,
    driverId,
    shipperId,
    grossAmount,
    t2Amount:    split.t2Amount,
    t3Amount:    split.t3Amount,
    t3HoldType:  split.t3HoldType,
    payoutMode,
  });

  console.log(`[WALLET] T1 complete — ${lotNumber} | Cash: ${cashOk ? '✓' : '✗'} MAD ${split.t1CashAmount} | Fuel: ${fuelOk ? '✓' : '✗'} MAD ${split.t1FuelAmount}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. DESTINATION SCAN — Record delivery, trigger T2 countdown
// ─────────────────────────────────────────────────────────────────────────────

async function recordDeliveryConfirmation(event: QRScanSuccessEvent): Promise<void> {
  const { shipmentId, lotNumber, driverId } = event;

  await db.query(`
    UPDATE shipments SET
      status = 'ARRIVED',
      destination_qr_scanned_at = NOW(),
      delivery_confirmed_lat    = $1,
      delivery_confirmed_lng    = $2,
      updated_at                = NOW()
    WHERE id = $3
  `, [event.lat, event.lng, shipmentId]);

  console.log(`[WALLET] Delivery confirmed — ${lotNumber} — T2 timer starting`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. T2 RELEASE — Called by escrow service after 60-min hold
// ─────────────────────────────────────────────────────────────────────────────

export async function releaseT2(
  shipmentId:    string,
  driverId:      string,
  driverPhone:   string,
  driverName:    string,
  t2Amount:      number,
  preferredProvider: WalletProvider
): Promise<WalletTransferResult> {

  const result = await executeTransfer({
    idempotencyKey: `triqlog:${shipmentId}:t2:cash`,
    fromAccount:    process.env.TRIQLOG_PLATFORM_ACCOUNT!,
    toPhone:        driverPhone,
    toName:         driverName,
    amountMAD:      t2Amount,
    bucket:         'CASH_OUT',
    provider:       preferredProvider,
    reference:      `T2-${shipmentId.slice(0,8)}`,
    description:    `TriqLog — T2 60min release`,
    metadata:       { shipmentId, leg: 'T2' },
  });

  if (result.success) {
    await db.query(`
      UPDATE financials SET
        t2_released_at = NOW(),
        payment_stage  = 'T2_RELEASED',
        updated_at     = NOW()
      WHERE shipment_id = $1
    `, [shipmentId]);

    await db.query(`
      UPDATE users SET wallet_balance = wallet_balance + $1, updated_at = NOW()
      WHERE id = $2
    `, [t2Amount, driverId]);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. T3 RELEASE — Called by escrow service after 24h / Net30 / Net60
// ─────────────────────────────────────────────────────────────────────────────

export async function releaseT3(
  shipmentId:    string,
  driverId:      string,
  driverPhone:   string,
  driverName:    string,
  t3Amount:      number,
  preferredProvider: WalletProvider,
  earlyRelease:  boolean = false
): Promise<WalletTransferResult> {

  const earlyFeePct = earlyRelease ? 0.05 : 0;
  const earlyFee    = round2(t3Amount * earlyFeePct);
  const netT3       = round2(t3Amount - earlyFee);

  const result = await executeTransfer({
    idempotencyKey: `triqlog:${shipmentId}:t3:cash`,
    fromAccount:    process.env.TRIQLOG_PLATFORM_ACCOUNT!,
    toPhone:        driverPhone,
    toName:         driverName,
    amountMAD:      netT3,
    bucket:         'CASH_OUT',
    provider:       preferredProvider,
    reference:      `T3-${earlyRelease ? 'EARLY' : 'STD'}-${shipmentId.slice(0,8)}`,
    description:    `TriqLog — T3 final release${earlyRelease ? ' (early −5%)' : ''}`,
    metadata:       { shipmentId, leg: 'T3', earlyRelease, earlyFee },
  });

  if (result.success) {
    if (earlyRelease && earlyFee > 0) {
      await db.query(`
        INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
        VALUES ($1, 'EARLY_RELEASE', $2, 'Early release fee 5%')
      `, [shipmentId, earlyFee]);
    }

    await db.query(`
      UPDATE financials SET
        t3_released_at   = NOW(),
        early_released_at = ${earlyRelease ? 'NOW()' : 'NULL'},
        payment_stage    = $1,
        fully_settled_at = NOW(),
        updated_at       = NOW()
      WHERE shipment_id  = $2
    `, [earlyRelease ? 'T3_EARLY_RELEASED' : 'T3_RELEASED', shipmentId]);

    await db.query(`
      UPDATE users SET
        wallet_balance    = wallet_balance    + $1,
        lifetime_earnings = lifetime_earnings + $1,
        total_trips       = total_trips       + 1,
        updated_at        = NOW()
      WHERE id = $2
    `, [netT3, driverId]);

    await db.query(`
      UPDATE shipments SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = $1
    `, [shipmentId]);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SHARED TRANSFER EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

async function executeTransfer(
  req: WalletTransferRequest
): Promise<WalletTransferResult> {

  const provider = getProvider(req.provider);

  try {
    const result = await provider.transfer(req);

    // Log every transfer attempt to DB
    await db.query(`
      INSERT INTO wallet_transactions (
        idempotency_key, provider, bucket, to_phone,
        amount_mad, fee_mad, net_mad, status,
        transaction_id, provider_ref, reference, description, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [
      req.idempotencyKey, req.provider, req.bucket, req.toPhone,
      req.amountMAD, result.feeMAD, result.netAmountMAD, result.status,
      result.transactionId, result.providerRef, req.reference,
      req.description, JSON.stringify(req.metadata || {}),
    ]);

    return result;

  } catch (err: any) {
    // Log failure
    await db.query(`
      INSERT INTO wallet_transactions (
        idempotency_key, provider, bucket, to_phone,
        amount_mad, fee_mad, net_mad, status, description, metadata
      ) VALUES ($1,$2,$3,$4,$5,0,$5,'FAILED',$6,$7)
      ON CONFLICT (idempotency_key) DO UPDATE SET status = 'FAILED'
    `, [
      req.idempotencyKey, req.provider, req.bucket, req.toPhone,
      req.amountMAD, req.description, JSON.stringify({ error: err.message }),
    ]);

    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. DRIVER PREFERRED PROVIDER SELECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-select the best provider for a driver based on:
 * 1. Their stored preference
 * 2. Whether their account is verified with that provider
 * 3. Fallback chain: CashPlus → Wafacash → Jibi
 */
export async function resolveDriverProvider(
  driverId: string,
  phone:    string
): Promise<WalletProvider> {

  const { rows } = await db.query(
    'SELECT preferred_payout FROM users WHERE id = $1',
    [driverId]
  );

  const preferred = rows[0]?.preferred_payout as WalletProvider | undefined;
  const fallbacks: WalletProvider[] = ['CASHPLUS', 'WAFACASH', 'JIBI'];
  const order = preferred
    ? [preferred, ...fallbacks.filter(p => p !== preferred)]
    : fallbacks;

  for (const providerName of order) {
    if (providerName === 'FUEL_CARD' || providerName === 'INTERNAL') continue;
    try {
      const ok = await getProvider(providerName).verify(phone);
      if (ok) return providerName;
    } catch { continue; }
  }

  return 'CASHPLUS'; // Ultimate fallback
}

export default {
  calculateWalletSplit,
  startWalletEventListener,
  releaseT2,
  releaseT3,
  resolveDriverProvider,
};
