/**
 * TRIQLOG — Load Dispatch Service
 *
 * Broadcast → Race → Claim model (Uber-style).
 *
 * Rules:
 *  1. A driver CANNOT accept a new load if they have ANY active shipment
 *     (status not in COMPLETED / CANCELLED).
 *  2. Drivers CAN browse/preview upcoming loads near their destination
 *     while on a trip — but Accept is hard-locked until current trip settles.
 *  3. Priority window: Premium/Gold drivers get 30s first look.
 *     Silver gets next 30s. Bronze gets remaining time.
 *  4. Claim is atomic via Redis SET NX — only one driver wins the race.
 *  5. If unclaimed after 5 min, radius expands 50→100→200km, repeat 3×.
 *  6. All notified drivers who lose the race get an instant "Taken" update.
 */

import { Pool }        from 'pg';
import IORedis         from 'ioredis';
import { Queue }       from 'bullmq';

const db    = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new IORedis({ host: process.env.REDIS_HOST || 'localhost', maxRetriesPerRequest: null });

const notifQueue    = new Queue('triqlog:notifications',  { connection: redis });
const dispatchQueue = new Queue('triqlog:dispatch',       { connection: redis });

// ─── Constants ───────────────────────────────────────────────────────────────
const PRIORITY_WINDOW_SECS = 30;     // Premium/Gold get 30s head start
const SILVER_WINDOW_SECS   = 30;     // Silver gets next 30s
const TOTAL_ROUND_SECS     = 5 * 60; // 5 min per radius round before expanding
const RADIUS_STEPS_KM      = [50, 100, 200];
const MAX_ROUNDS           = 3;
const CLAIM_TTL_SECS       = 3600;   // Redis claim key lives 1h

// Driver tiers in priority order
const TIER_PRIORITY: Record<string, number> = {
  PREMIUM: 0,
  GOLD:    0,   // Gold same priority as Premium
  SILVER:  1,
  BRONZE:  2,
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface DriverCandidate {
  id:           string;
  fullName:     string;
  phone:        string;
  fcmToken:     string | null;
  tier:         string;
  trustScore:   number;
  distanceKm:   number;
  currentLat:   number;
  currentLng:   number;
  truckId:      string;
  truckPlate:   string;
  truckType:    string;
}

interface DispatchRound {
  shipmentId:   string;
  radiusKm:     number;
  round:        number;
  startedAt:    Date;
}

// ─── Eligibility: hard lock on double-load ───────────────────────────────────

/**
 * Returns true ONLY if the driver has zero active shipments.
 * Active = any status that is not COMPLETED or CANCELLED.
 */
export async function isDriverEligible(driverId: string): Promise<{
  eligible:  boolean;
  reason?:   string;
  blockedBy?: string;   // shipment lot number if blocked
}> {
  const { rows } = await db.query(`
    SELECT
      s.id,
      s.lot_number,
      s.status,
      s.origin_city,
      s.destination_city
    FROM shipments s
    WHERE s.driver_id  = $1
      AND s.status NOT IN ('COMPLETED', 'CANCELLED')
    LIMIT 1
  `, [driverId]);

  if (rows.length > 0) {
    return {
      eligible:  false,
      reason:    `Active trip in progress: ${rows[0].lot_number} (${rows[0].status})`,
      blockedBy: rows[0].lot_number,
    };
  }

  // Also check driver docs not critically expired
  const { rows: driverRows } = await db.query(`
    SELECT
      insurance_expiry,
      visite_tech_expiry,
      is_active
    FROM users WHERE id = $1
  `, [driverId]);

  if (!driverRows[0]?.is_active) {
    return { eligible: false, reason: 'Driver account inactive' };
  }

  const now = new Date();
  if (driverRows[0].insurance_expiry && new Date(driverRows[0].insurance_expiry) < now) {
    return { eligible: false, reason: 'Insurance expired' };
  }
  if (driverRows[0].visite_tech_expiry && new Date(driverRows[0].visite_tech_expiry) < now) {
    return { eligible: false, reason: 'Visite technique expired' };
  }

  return { eligible: true };
}

// ─── Find candidates within radius ───────────────────────────────────────────

/**
 * Returns drivers ordered by tier priority then distance.
 * Uses PostGIS for accurate distance calculation.
 */
export async function findCandidates(
  shipmentId:   string,
  radiusKm:     number,
  truckType?:   string
): Promise<DriverCandidate[]> {

  const { rows: shipRow } = await db.query(
    'SELECT origin_lat, origin_lng, required_truck_type FROM shipments WHERE id = $1',
    [shipmentId]
  );
  if (!shipRow[0]) throw new Error('Shipment not found');

  const { origin_lat, origin_lng, required_truck_type } = shipRow[0];
  const reqType = truckType || required_truck_type;

  const { rows } = await db.query(`
    SELECT
      u.id,
      u.full_name,
      u.phone,
      u.fcm_token,
      u.tier,
      u.trust_score,
      t.id           AS truck_id,
      t.plate        AS truck_plate,
      t.truck_type,
      u.last_known_lat,
      u.last_known_lng,
      -- Haversine distance in km (fallback if PostGIS not available)
      (6371 * acos(
        cos(radians($1)) * cos(radians(u.last_known_lat))
        * cos(radians(u.last_known_lng) - radians($2))
        + sin(radians($1)) * sin(radians(u.last_known_lat))
      )) AS distance_km
    FROM users u
    JOIN trucks t ON t.driver_id = u.id AND t.is_available = TRUE
    WHERE
      u.role          = 'DRIVER'
      AND u.is_active  = TRUE
      AND t.is_available = TRUE
      -- Within radius
      AND (6371 * acos(
        cos(radians($1)) * cos(radians(u.last_known_lat))
        * cos(radians(u.last_known_lng) - radians($2))
        + sin(radians($1)) * sin(radians(u.last_known_lat))
      )) <= $3
      -- Truck type match (or no requirement)
      AND ($4::text IS NULL OR t.truck_type = $4)
      -- No active shipments (double-load prevention)
      AND NOT EXISTS (
        SELECT 1 FROM shipments s2
        WHERE s2.driver_id = u.id
          AND s2.status NOT IN ('COMPLETED', 'CANCELLED')
      )
      -- Documents not expired
      AND (u.insurance_expiry IS NULL     OR u.insurance_expiry     > NOW())
      AND (u.visite_tech_expiry IS NULL   OR u.visite_tech_expiry   > NOW())
    ORDER BY
      CASE u.tier
        WHEN 'PREMIUM' THEN 0
        WHEN 'GOLD'    THEN 0
        WHEN 'SILVER'  THEN 1
        WHEN 'BRONZE'  THEN 2
        ELSE 3
      END ASC,
      distance_km ASC
    LIMIT 100
  `, [origin_lat, origin_lng, radiusKm, reqType || null]);

  return rows.map(r => ({
    id:          r.id,
    fullName:    r.full_name,
    phone:       r.phone,
    fcmToken:    r.fcm_token,
    tier:        r.tier,
    trustScore:  r.trust_score,
    distanceKm:  parseFloat(r.distance_km).toFixed(1) as unknown as number,
    currentLat:  r.last_known_lat,
    currentLng:  r.last_known_lng,
    truckId:     r.truck_id,
    truckPlate:  r.truck_plate,
    truckType:   r.truck_type,
  }));
}

// ─── Start broadcast for a shipment ──────────────────────────────────────────

export async function startDispatch(shipmentId: string): Promise<void> {
  // Mark shipment as dispatching
  await db.query(
    `UPDATE shipments SET status = 'PENDING_PICKUP', updated_at = NOW() WHERE id = $1`,
    [shipmentId]
  );

  // Store dispatch state in Redis
  await redis.setex(
    `dispatch:state:${shipmentId}`,
    TOTAL_ROUND_SECS * MAX_ROUNDS + 600,
    JSON.stringify({ round: 1, radiusKm: RADIUS_STEPS_KM[0], startedAt: Date.now() })
  );

  await runDispatchRound(shipmentId, RADIUS_STEPS_KM[0], 1);
}

async function runDispatchRound(
  shipmentId: string,
  radiusKm:   number,
  round:      number
): Promise<void> {

  const candidates = await findCandidates(shipmentId, radiusKm);

  if (candidates.length === 0) {
    console.log(`[DISPATCH] No candidates within ${radiusKm}km for ${shipmentId} (round ${round})`);
    if (round < MAX_ROUNDS) {
      // Expand radius after timeout
      const nextRadius = RADIUS_STEPS_KM[round] || RADIUS_STEPS_KM[RADIUS_STEPS_KM.length - 1];
      await dispatchQueue.add('expand-radius', { shipmentId, radiusKm: nextRadius, round: round + 1 }, {
        delay: TOTAL_ROUND_SECS * 1000,
      });
    } else {
      await notifyShipperNoDrivers(shipmentId);
    }
    return;
  }

  console.log(`[DISPATCH] ${candidates.length} candidates found within ${radiusKm}km (round ${round})`);

  // Separate by priority tier
  const premiumGold = candidates.filter(d => ['PREMIUM','GOLD'].includes(d.tier));
  const silver      = candidates.filter(d => d.tier === 'SILVER');
  const bronze      = candidates.filter(d => d.tier === 'BRONZE');

  const now = Date.now();

  // Get shipment details for notification payload
  const { rows } = await db.query(`
    SELECT
      s.lot_number, s.origin_city, s.destination_city,
      s.weight_tonnes, s.cargo_type, s.pickup_deadline,
      f.gross_amount, f.net_to_driver, f.t1_amount
    FROM shipments s
    JOIN financials f ON f.shipment_id = s.id
    WHERE s.id = $1
  `, [shipmentId]);

  const load = rows[0];

  // Store which drivers were notified (for "Taken" broadcast later)
  const notifiedIds = candidates.map(d => d.id);
  await redis.setex(
    `dispatch:notified:${shipmentId}`,
    TOTAL_ROUND_SECS * MAX_ROUNDS + 600,
    JSON.stringify(notifiedIds)
  );

  // Broadcast with staggered priority windows
  const broadcastGroups = [
    { drivers: premiumGold, delayMs: 0 },
    { drivers: silver,      delayMs: PRIORITY_WINDOW_SECS * 1000 },
    { drivers: bronze,      delayMs: (PRIORITY_WINDOW_SECS * 2) * 1000 },
  ];

  for (const group of broadcastGroups) {
    if (group.drivers.length === 0) continue;

    for (const driver of group.drivers) {
      // Queue push notification to each driver
      await notifQueue.add('load-offer', {
        driverId:     driver.id,
        fcmToken:     driver.fcmToken,
        phone:        driver.phone,
        shipmentId,
        lotNumber:    load.lot_number,
        originCity:   load.origin_city,
        destCity:     load.destination_city,
        distanceKm:   driver.distanceKm,
        weightTonnes: load.weight_tonnes,
        cargoType:    load.cargo_type,
        grossAmount:  load.gross_amount,
        netAmount:    load.net_to_driver,
        t1Amount:     load.t1_amount,
        expiresAt:    now + group.delayMs + TOTAL_ROUND_SECS * 1000,
        offerWindowSecs: TOTAL_ROUND_SECS - (group.delayMs / 1000),
      }, {
        delay: group.delayMs,
      });
    }
  }

  // Schedule radius expansion if unclaimed
  await dispatchQueue.add('check-unclaimed', { shipmentId, round }, {
    delay:  TOTAL_ROUND_SECS * 1000,
    jobId:  `unclaimed-check:${shipmentId}:${round}`,
  });

  console.log(`[DISPATCH] Broadcast sent to ${candidates.length} drivers for ${shipmentId}`);
  console.log(`  Premium/Gold: ${premiumGold.length} (now)`);
  console.log(`  Silver:       ${silver.length}      (+${PRIORITY_WINDOW_SECS}s)`);
  console.log(`  Bronze:       ${bronze.length}      (+${PRIORITY_WINDOW_SECS * 2}s)`);
}

// ─── Atomic claim (Redis SET NX — only one driver wins) ───────────────────────

export async function claimLoad(
  shipmentId: string,
  driverId:   string,
  truckId:    string
): Promise<{
  success:    boolean;
  reason?:    string;
  claimedBy?: string;   // winner's name if lost race
}> {

  // 1. Double-load guard — re-check at claim time (not just at broadcast time)
  const eligibility = await isDriverEligible(driverId);
  if (!eligibility.eligible) {
    return {
      success: false,
      reason:  eligibility.reason || 'Not eligible',
    };
  }

  // 2. Atomic Redis claim — SET NX with 1-hour TTL
  const claimKey = `dispatch:claimed:${shipmentId}`;
  const claimed  = await redis.set(claimKey, driverId, 'EX', CLAIM_TTL_SECS, 'NX');

  if (claimed !== 'OK') {
    // Someone else won the race
    const winnerId = await redis.get(claimKey);
    const { rows } = await db.query('SELECT full_name FROM users WHERE id = $1', [winnerId]);
    return {
      success:   false,
      reason:    'Load already claimed',
      claimedBy: rows[0]?.full_name || 'Another driver',
    };
  }

  // 3. Won the race — persist to DB atomically
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Double-check in DB within transaction (belt + suspenders)
    const { rows: activeTrips } = await client.query(`
      SELECT id FROM shipments
      WHERE driver_id = $1
        AND status NOT IN ('COMPLETED','CANCELLED')
        AND id != $2
    `, [driverId, shipmentId]);

    if (activeTrips.length > 0) {
      await client.query('ROLLBACK');
      await redis.del(claimKey);  // Release Redis claim
      return { success: false, reason: 'Active trip detected at DB level' };
    }

    // Assign driver to shipment
    await client.query(`
      UPDATE shipments SET
        driver_id  = $1,
        truck_id   = $2,
        status     = 'PENDING_PICKUP',
        updated_at = NOW()
      WHERE id = $3
        AND driver_id IS NULL   -- Extra guard: must still be unassigned
    `, [driverId, truckId, shipmentId]);

    // Mark truck unavailable
    await client.query(
      `UPDATE trucks SET is_available = FALSE, updated_at = NOW() WHERE id = $1`,
      [truckId]
    );

    // Cancel the radius-expansion job
    await dispatchQueue.removeJobScheduler(`unclaimed-check:${shipmentId}:1`);
    await dispatchQueue.removeJobScheduler(`unclaimed-check:${shipmentId}:2`);
    await dispatchQueue.removeJobScheduler(`unclaimed-check:${shipmentId}:3`);

    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK');
    await redis.del(claimKey);
    throw err;
  } finally {
    client.release();
  }

  // 4. Broadcast "Taken" to all other notified drivers
  await broadcastTaken(shipmentId, driverId);

  // 5. Confirm to winning driver
  const { rows: winnerRows } = await db.query(
    'SELECT full_name, phone FROM users WHERE id = $1',
    [driverId]
  );
  console.log(`[DISPATCH] Load ${shipmentId} claimed by ${winnerRows[0]?.full_name}`);

  await notifQueue.add('load-claimed-winner', {
    driverId,
    shipmentId,
    message: 'Lot confirmé ! Rendez-vous au point de départ.',
  });

  return { success: true };
}

// ─── Broadcast "Taken" to losing drivers ─────────────────────────────────────

async function broadcastTaken(shipmentId: string, winnerId: string): Promise<void> {
  const notifiedRaw = await redis.get(`dispatch:notified:${shipmentId}`);
  if (!notifiedRaw) return;

  const notifiedIds: string[] = JSON.parse(notifiedRaw);
  const losers = notifiedIds.filter(id => id !== winnerId);

  for (const driverId of losers) {
    await notifQueue.add('load-taken', {
      driverId,
      shipmentId,
      message: 'Ce lot a été pris par un autre chauffeur.',
    });
  }
  console.log(`[DISPATCH] "Taken" broadcast to ${losers.length} drivers`);
}

// ─── Pass (driver declines offer) ────────────────────────────────────────────

export async function passLoad(shipmentId: string, driverId: string): Promise<void> {
  // Track pass count in Redis (too many passes might affect trust score)
  await redis.hincrby(`dispatch:passes:${shipmentId}`, driverId, 1);
  console.log(`[DISPATCH] Driver ${driverId} passed on ${shipmentId}`);
}

// ─── Notify shipper when no driver found ─────────────────────────────────────

async function notifyShipperNoDrivers(shipmentId: string): Promise<void> {
  const { rows } = await db.query(
    'SELECT shipper_id FROM shipments WHERE id = $1', [shipmentId]
  );
  await notifQueue.add('no-driver-found', {
    shipperId:  rows[0]?.shipper_id,
    shipmentId,
    message:    'Aucun chauffeur disponible dans la zone. Essayez d\'augmenter le tarif ou de modifier l\'heure.',
  });
  await db.query(
    `UPDATE shipments SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
    [shipmentId]
  );
  console.log(`[DISPATCH] No driver found for ${shipmentId} after ${MAX_ROUNDS} rounds`);
}

export default { startDispatch, claimLoad, passLoad, isDriverEligible, findCandidates };
