/**
 * TRIQLOG — Fuel Rebate Calculator
 * 
 * Handles the Afriquia / Total Energies rebate split:
 *   - 90% of discount → Driver (applied to fuel card)
 *   - 10% of discount → Platform revenue ledger
 * 
 * Also handles the T1 bucket split (cash vs fuel card at pickup).
 */

import { Pool } from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  maxRetriesPerRequest: null,
});

const db = new Pool({ connectionString: process.env.DATABASE_URL });

const notifQueue = new Queue('triqlog:notifications', { connection: redis });
const revenueQueue = new Queue('triqlog:revenue', { connection: redis });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FuelFillInput {
  driverId:                  string;
  shipmentId?:               string;    // Optional — fuelling between trips
  stationName:               string;
  stationLocation:           string;
  litersFilledActual:        number;    // Actual litres pumped
  pumpPricePerLiter:         number;    // MAD/L shown on pump
  negotiatedDiscountPerLiter: number;   // From Afriquia contract e.g. 0.50 MAD/L
  fuelDate?:                 Date;
}

export interface FuelRebateResult {
  liters:               number;
  grossCost:            number;    // Without any discount
  totalDiscount:        number;    // Negotiated discount × litres
  driverRebateAmount:   number;    // 90% of discount
  platformRebateAmount: number;    // 10% of discount
  netCostToDriver:      number;    // What driver actually pays
  effectivePricePerL:   number;    // Net price per litre
  savingsVsMarket:      number;    // Total driver savings
}

// ─── Core Calculation ────────────────────────────────────────────────────────

/**
 * Pure function — no side effects.
 * Calculates rebate split before writing to DB.
 */
export function calculateFuelRebate(
  liters:                    number,
  pumpPrice:                 number,
  negotiatedDiscount:        number,
  driverRebatePct:           number = 90,
  platformRebatePct:         number = 10
): FuelRebateResult {

  if (driverRebatePct + platformRebatePct !== 100) {
    throw new Error('Rebate split must total 100%');
  }
  if (negotiatedDiscount > pumpPrice) {
    throw new Error('Discount cannot exceed pump price');
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const grossCost            = round2(liters * pumpPrice);
  const totalDiscount        = round2(liters * negotiatedDiscount);
  const driverRebateAmount   = round2(totalDiscount * (driverRebatePct  / 100));
  const platformRebateAmount = round2(totalDiscount * (platformRebatePct / 100));
  const netCostToDriver      = round2(grossCost - driverRebateAmount);
  const effectivePricePerL   = round2(netCostToDriver / liters);
  const savingsVsMarket      = driverRebateAmount;

  return {
    liters,
    grossCost,
    totalDiscount,
    driverRebateAmount,
    platformRebateAmount,
    netCostToDriver,
    effectivePricePerL,
    savingsVsMarket,
  };
}

/**
 * Records a fuel fill, calculates rebate, applies to driver fuel card,
 * logs platform revenue.
 */
export async function recordFuelFill(input: FuelFillInput): Promise<FuelRebateResult> {
  const result = calculateFuelRebate(
    input.litersFilledActual,
    input.pumpPricePerLiter,
    input.negotiatedDiscountPerLiter
  );

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insert fuel transaction record
    const { rows } = await client.query(`
      INSERT INTO fuel_transactions (
        driver_id, shipment_id, station_name, station_location,
        fuel_date, liters_filled, pump_price_per_liter,
        negotiated_discount_per_liter,
        rebate_settled, settled_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW())
      RETURNING id
    `, [
      input.driverId,
      input.shipmentId || null,
      input.stationName,
      input.stationLocation,
      input.fuelDate || new Date(),
      input.litersFilledActual,
      input.pumpPricePerLiter,
      input.negotiatedDiscountPerLiter,
    ]);

    const fuelTxId = rows[0].id;

    // Apply driver rebate to fuel card balance
    await client.query(`
      UPDATE users SET
        fuel_card_balance = fuel_card_balance + $1,
        updated_at        = NOW()
      WHERE id = $2
    `, [result.driverRebateAmount, input.driverId]);

    // Log platform revenue (10% cut)
    await client.query(`
      INSERT INTO platform_revenue (shipment_id, revenue_type, amount, description)
      VALUES ($1, 'FUEL_REBATE', $2, $3)
    `, [
      input.shipmentId || null,
      result.platformRebateAmount,
      `Fuel rebate 10% cut — ${input.litersFilledActual}L @ ${input.stationName}`,
    ]);

    await client.query('COMMIT');

    // Send driver notification
    await notifQueue.add('fuel-rebate-applied', {
      driverId:       input.driverId,
      shipmentId:     input.shipmentId,
      liters:         input.litersFilledActual,
      driverSaving:   result.driverRebateAmount,
      effectivePrice: result.effectivePricePerL,
      fuelTxId,
    });

    console.log(
      `[FUEL] ${input.litersFilledActual}L @ ${input.stationName} | ` +
      `Driver saves MAD ${result.driverRebateAmount} | ` +
      `Platform earns MAD ${result.platformRebateAmount}`
    );

    return result;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUEL ESTIMATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Estimates how much fuel a trip will consume and what it will cost.
// Used by the driver app to show expected fuel card usage before departure,
// and by the platform to pre-load the T1 fuel bucket with enough balance.

// ── Consumption rates by truck type (L/100km at standard load) ───────────────
const BASE_CONSUMPTION_RATE: Record<string, number> = {
  SEMI_TRAILER:  35,   // L/100km — fully loaded
  CURTAINSIDER:  32,   // L/100km
  REFRIGERATED:  38,   // L/100km — compressor adds ~3L/100km
  FLATBED:       30,   // L/100km
  TANKER:        34,   // L/100km
  BOX_TRUCK:     22,   // L/100km
  TIPPER:        28,   // L/100km
};

// ── Weight penalty: +0.8% consumption per tonne over base load ───────────────
const WEIGHT_PENALTY_PER_TONNE = 0.008;   // 0.8% per extra tonne
const BASE_LOAD_TONNES         = 5;        // Penalty starts above 5T
const SAFETY_BUFFER            = 1.15;     // 15% buffer for traffic, terrain, AC

// ── Refrigerated surcharge (compressor load) ─────────────────────────────────
const REEFER_SURCHARGE_PER_HOUR = 2.5;    // L/h for refrigeration compressor

// ── Default fuel price if not available from DB ──────────────────────────────
const FALLBACK_FUEL_PRICE_MAD = 12.50;    // MAD/L — update when Afriquia prices change

export interface FuelEstimate {
  distanceKm:         number;
  weightTonnes:       number;
  truckType:          string;
  baseRateLPer100km:  number;   // L/100km without weight penalty
  weightPenaltyPct:   number;   // Extra % due to load weight
  effectiveRateLPer100km: number; // After weight penalty
  estimatedLiters:    number;   // With 15% safety buffer
  fuelPricePerLiter:  number;   // MAD/L (live or fallback)
  estimatedCostMAD:   number;   // Total fuel cost estimate
  rebatePerLiter:     number;   // Afriquia discount
  driverNetCostMAD:   number;   // After 90% rebate applied
  platformCutMAD:     number;   // 10% of rebate
  reeferHours?:       number;   // Only for refrigerated trucks
  reeferFuelLiters?:  number;   // Extra liters for compressor
}

/**
 * Estimates fuel consumption and cost for a shipment before departure.
 * Pulls truck type, distance, and weight from the DB.
 * Uses live fuel price from platform_config if available, falls back to constant.
 *
 * @param shipmentId  The shipment to estimate for
 * @returns           Full breakdown of estimated consumption and cost
 */
export async function estimateRequiredFuel(shipmentId: string): Promise<FuelEstimate> {
  // ── Fetch shipment + truck data from DB ────────────────────────────────────
  const { rows } = await db.query(`
    SELECT
      s.distance_km,
      s.weight_tonnes,
      s.requires_temp_control,
      s.delivery_deadline,
      s.pickup_deadline,
      t.truck_type,
      t.max_weight_tonnes
    FROM shipments s
    JOIN trucks t ON t.id = s.truck_id
    WHERE s.id = $1
  `, [shipmentId]);

  if (!rows[0]) {
    throw new Error(`Shipment ${shipmentId} not found or has no truck assigned`);
  }

  const s = rows[0];

  if (!s.distance_km || s.distance_km <= 0) {
    throw new Error(`Shipment ${shipmentId} has no distance set — cannot estimate fuel`);
  }

  const truckType    = s.truck_type as string;
  const distanceKm   = parseFloat(s.distance_km);
  const weightTonnes = parseFloat(s.weight_tonnes);

  // ── Base consumption rate by truck type ────────────────────────────────────
  const baseRate = BASE_CONSUMPTION_RATE[truckType] ?? BASE_CONSUMPTION_RATE['BOX_TRUCK'];

  // ── Weight penalty ─────────────────────────────────────────────────────────
  // +0.8% per tonne above BASE_LOAD_TONNES (5T)
  const excessTonnes     = Math.max(0, weightTonnes - BASE_LOAD_TONNES);
  const weightPenaltyPct = excessTonnes * WEIGHT_PENALTY_PER_TONNE * 100;
  const weightMultiplier = 1 + (excessTonnes * WEIGHT_PENALTY_PER_TONNE);
  const effectiveRate    = Math.round(baseRate * weightMultiplier * 100) / 100;

  // ── Base fuel liters (with safety buffer) ─────────────────────────────────
  let estimatedLiters = (distanceKm / 100) * effectiveRate * SAFETY_BUFFER;

  // ── Refrigeration surcharge ────────────────────────────────────────────────
  let reeferHours: number | undefined;
  let reeferFuelLiters: number | undefined;

  if (s.requires_temp_control || truckType === 'REFRIGERATED') {
    // Estimate hours from distance assuming avg 70km/h
    reeferHours      = Math.ceil(distanceKm / 70);
    reeferFuelLiters = reeferHours * REEFER_SURCHARGE_PER_HOUR;
    estimatedLiters += reeferFuelLiters;
  }

  estimatedLiters = Math.round(estimatedLiters * 10) / 10; // Round to 1 decimal

  // ── Live fuel price (from DB config table, fallback to constant) ───────────
  let fuelPricePerLiter = FALLBACK_FUEL_PRICE_MAD;
  try {
    const priceRow = await db.query(`
      SELECT value::numeric AS price
      FROM platform_config
      WHERE key = 'fuel_price_mad_per_liter'
        AND updated_at > NOW() - INTERVAL '24 hours'
    `);
    if (priceRow.rows[0]) {
      fuelPricePerLiter = parseFloat(priceRow.rows[0].price);
    }
  } catch {
    // platform_config table may not exist yet — use fallback silently
  }

  // ── Afriquia rebate (fetch driver's negotiated rate if available) ──────────
  // Default to 0.50 MAD/L until Afriquia contract is confirmed
  const negotiatedDiscount = 0.50;
  const driverRebatePct    = 0.90;
  const platformRebatePct  = 0.10;

  const estimatedCostMAD   = Math.round(estimatedLiters * fuelPricePerLiter * 100) / 100;
  const totalDiscount      = Math.round(estimatedLiters * negotiatedDiscount * 100) / 100;
  const driverNetCostMAD   = Math.round((estimatedCostMAD - totalDiscount * driverRebatePct) * 100) / 100;
  const platformCutMAD     = Math.round(totalDiscount * platformRebatePct * 100) / 100;

  const estimate: FuelEstimate = {
    distanceKm,
    weightTonnes,
    truckType,
    baseRateLPer100km:      baseRate,
    weightPenaltyPct:       Math.round(weightPenaltyPct * 100) / 100,
    effectiveRateLPer100km: effectiveRate,
    estimatedLiters,
    fuelPricePerLiter,
    estimatedCostMAD,
    rebatePerLiter:         negotiatedDiscount,
    driverNetCostMAD,
    platformCutMAD,
    ...(reeferHours !== undefined && { reeferHours, reeferFuelLiters }),
  };

  console.log(
    `[FUEL EST] ${truckType} | ${distanceKm}km | ${weightTonnes}T | ` +
    `~${estimatedLiters}L | MAD ${estimatedCostMAD} gross | MAD ${driverNetCostMAD} net`
  );

  return estimate;
}

/**
 * Updates the live fuel price in the platform_config table.
 * Called by a daily cron job that fetches prices from Afriquia / CMH API.
 */
export async function updateFuelPrice(pricePerLiter: number, source: string): Promise<void> {
  await db.query(`
    INSERT INTO platform_config (key, value, description, updated_at)
    VALUES ('fuel_price_mad_per_liter', $1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value       = $1,
      description = $2,
      updated_at  = NOW()
  `, [pricePerLiter.toString(), `Updated from ${source}`]);

  console.log(`[FUEL] Price updated to MAD ${pricePerLiter}/L from ${source}`);
}

// ─── T1 Bucket Split (Cash vs Fuel Card at pickup) ──────────────────────────

export interface T1BucketInput {
  t1NetAmount:    number;    // T1 amount after platform fee
  cashPct:        number;    // Default 80
  fuelPct:        number;    // Default 20
}

export interface T1BucketResult {
  cashAmount: number;
  fuelAmount: number;
  total:      number;
}

export function splitT1Buckets(input: T1BucketInput): T1BucketResult {
  if (input.cashPct + input.fuelPct !== 100) {
    throw new Error('T1 bucket split must total 100%');
  }
  const cashAmount = Math.round(input.t1NetAmount * input.cashPct) / 100;
  const fuelAmount = Math.round((input.t1NetAmount - cashAmount) * 100) / 100;
  return {
    cashAmount,
    fuelAmount,
    total: cashAmount + fuelAmount,
  };
}

// ─── Monthly rebate summary (for platform reporting) ─────────────────────────

export async function getMonthlyFuelSummary(year: number, month: number) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                   AS fills,
      SUM(liters_filled)                         AS total_liters,
      SUM(gross_fuel_cost)                       AS total_gross_cost,
      SUM(total_discount)                        AS total_discount,
      SUM(driver_rebate_amount)                  AS total_driver_savings,
      SUM(platform_rebate_amount)                AS total_platform_revenue,
      AVG(negotiated_discount_per_liter)         AS avg_discount_per_liter,
      AVG(liters_filled)                         AS avg_fill_liters
    FROM fuel_transactions
    WHERE
      EXTRACT(YEAR  FROM fuel_date) = $1 AND
      EXTRACT(MONTH FROM fuel_date) = $2
  `, [year, month]);
  return rows[0];
}

// ─── Projection tool: annual platform fuel revenue ───────────────────────────

export function projectAnnualFuelRevenue(
  avgMonthlyDrivers:         number,
  avgFillsPerDriverPerMonth: number,
  avgLitersPerFill:          number,
  negotiatedDiscountPerL:    number,
  platformPct:               number = 10
): {
  monthlyLiters:       number;
  annualLiters:        number;
  monthlyRevenue:      number;
  annualRevenue:       number;
  revenuePerDriver:    number;
} {
  const monthlyLiters   = avgMonthlyDrivers * avgFillsPerDriverPerMonth * avgLitersPerFill;
  const annualLiters    = monthlyLiters * 12;
  const monthlyRevenue  = Math.round(monthlyLiters * negotiatedDiscountPerL * (platformPct / 100) * 100) / 100;
  const annualRevenue   = Math.round(annualLiters  * negotiatedDiscountPerL * (platformPct / 100) * 100) / 100;
  const revenuePerDriver = Math.round((annualRevenue / avgMonthlyDrivers) * 100) / 100;

  return { monthlyLiters, annualLiters, monthlyRevenue, annualRevenue, revenuePerDriver };
}

export default {
  calculateFuelRebate,
  recordFuelFill,
  estimateRequiredFuel,
  updateFuelPrice,
  splitT1Buckets,
  getMonthlyFuelSummary,
  projectAnnualFuelRevenue,
};
