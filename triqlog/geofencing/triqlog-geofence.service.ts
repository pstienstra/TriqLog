/**
 * TRIQLOG — Geofencing Service
 *
 * Three systems:
 *
 * 1. LOGISTICS HUBS — Named zones with radius, type, and allowed QR actions.
 *    A QR scan (ORIGIN or DESTINATION) is only permitted if the driver's GPS
 *    is within the hub's radius at the moment of the scan attempt.
 *
 * 2. QR GEOFENCE LOCK — Before displaying the QR code, the app calls
 *    checkQRPermission(). If the driver is outside every permitted hub,
 *    the QR is withheld and the driver sees the distance to the nearest hub.
 *
 * 3. STATIONARY ALERT ENGINE — A BullMQ worker polls GPS pings every 15 min.
 *    If a truck has moved < 500m in 4 consecutive hours while on an active
 *    shipment, it fires a STATIONARY_ALERT to the admin dashboard via
 *    Redis pub/sub and logs it to the incidents table.
 */

import { Pool }    from 'pg';
import IORedis     from 'ioredis';
import { Queue, Worker } from 'bullmq';

const db    = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new IORedis({ host: process.env.REDIS_HOST || 'localhost', maxRetriesPerRequest: null });
const alertQueue = new Queue('triqlog:geo-alerts', { connection: redis });

// ─────────────────────────────────────────────────────────────────────────────
// 1. LOGISTICS HUBS
// ─────────────────────────────────────────────────────────────────────────────

export interface LogisticsHub {
  id:             string;
  name:           string;
  nameAr:         string;
  city:           string;
  lat:            number;
  lng:            number;
  radiusM:        number;       // QR scan allowed within this radius (metres)
  type:           HubType;
  allowedScans:   QRScanType[]; // Which scan types are valid at this hub
  operatingHours: { open: number; close: number }; // 0-23 hours UTC+1
  active:         boolean;
}

export type HubType    = 'PORT' | 'WHOLESALE_MARKET' | 'INDUSTRIAL_ZONE' | 'HIGHWAY_REST' | 'CUSTOMS';
export type QRScanType = 'ORIGIN' | 'DESTINATION' | 'BOTH';

export const LOGISTICS_HUBS: LogisticsHub[] = [
  // ── TANGIER MED ──────────────────────────────────────────────────────────
  {
    id:             'hub-tangier-med',
    name:           'Tanger Med Port',
    nameAr:         'ميناء طنجة المتوسط',
    city:           'Tanger',
    lat:            35.8836,
    lng:            -5.5029,
    radiusM:        1000,
    type:           'PORT',
    allowedScans:   ['ORIGIN', 'DESTINATION'],
    operatingHours: { open: 0, close: 23 },   // 24h port
    active:         true,
  },
  // ── CASABLANCA PORT ───────────────────────────────────────────────────────
  {
    id:             'hub-casa-port',
    name:           'Casablanca — Port Commercial',
    nameAr:         'ميناء الدار البيضاء التجاري',
    city:           'Casablanca',
    lat:            33.6028,
    lng:            -7.6186,
    radiusM:        1000,
    type:           'PORT',
    allowedScans:   ['ORIGIN', 'DESTINATION'],
    operatingHours: { open: 6, close: 22 },
    active:         true,
  },
  // ── CASABLANCA ZI OULED SALEH ─────────────────────────────────────────────
  {
    id:             'hub-casa-zi',
    name:           'Casablanca — Zone Industrielle',
    nameAr:         'الدار البيضاء — المنطقة الصناعية',
    city:           'Casablanca',
    lat:            33.5356,
    lng:            -7.6689,
    radiusM:        1500,
    type:           'INDUSTRIAL_ZONE',
    allowedScans:   ['DESTINATION'],
    operatingHours: { open: 6, close: 21 },
    active:         true,
  },
  // ── AGADIR WHOLESALE MARKET ───────────────────────────────────────────────
  {
    id:             'hub-agadir-souk',
    name:           'Agadir — Marché de Gros',
    nameAr:         'أكادير — سوق الجملة',
    city:           'Agadir',
    lat:            30.4210,
    lng:            -9.5979,
    radiusM:        800,
    type:           'WHOLESALE_MARKET',
    allowedScans:   ['ORIGIN', 'DESTINATION'],
    operatingHours: { open: 4, close: 14 },   // Early morning market
    active:         true,
  },
  // ── FÈS INDUSTRIAL ZONE ───────────────────────────────────────────────────
  {
    id:             'hub-fes-zi',
    name:           'Fès — Zone Industrielle Sidi Brahim',
    nameAr:         'فاس — المنطقة الصناعية سيدي إبراهيم',
    city:           'Fès',
    lat:            33.9917,
    lng:            -4.9994,
    radiusM:        1200,
    type:           'INDUSTRIAL_ZONE',
    allowedScans:   ['BOTH'],
    operatingHours: { open: 7, close: 20 },
    active:         true,
  },
  // ── MARRAKECH LOGISTICS PARK ──────────────────────────────────────────────
  {
    id:             'hub-marrakech-park',
    name:           'Marrakech — Parc Logistique',
    nameAr:         'مراكش — المنطقة اللوجستية',
    city:           'Marrakech',
    lat:            31.6340,
    lng:            -8.0560,
    radiusM:        1000,
    type:           'INDUSTRIAL_ZONE',
    allowedScans:   ['BOTH'],
    operatingHours: { open: 6, close: 21 },
    active:         true,
  },
  // ── KENITRA — STELLANTIS PLANT ────────────────────────────────────────────
  {
    id:             'hub-kenitra-auto',
    name:           'Kénitra — Pôle Automobile',
    nameAr:         'القنيطرة — قطب السيارات',
    city:           'Kénitra',
    lat:            34.2539,
    lng:            -6.5899,
    radiusM:        800,
    type:           'INDUSTRIAL_ZONE',
    allowedScans:   ['ORIGIN'],
    operatingHours: { open: 6, close: 22 },
    active:         true,
  },
  // ── OUJDA BORDER CUSTOMS ──────────────────────────────────────────────────
  {
    id:             'hub-oujda-customs',
    name:           'Oujda — Douane / Frontière',
    nameAr:         'وجدة — الجمارك / الحدود',
    city:           'Oujda',
    lat:            34.6895,
    lng:            -1.9031,
    radiusM:        600,
    type:           'CUSTOMS',
    allowedScans:   ['BOTH'],
    operatingHours: { open: 0, close: 23 },
    active:         true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. GEOFENCE MATH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Haversine formula — returns distance in metres between two GPS points.
 */
export function haversineMetres(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R    = 6_371_000; // Earth radius in metres
  const φ1   = lat1 * Math.PI / 180;
  const φ2   = lat2 * Math.PI / 180;
  const Δφ   = (lat2 - lat1) * Math.PI / 180;
  const Δλ   = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface NearestHub {
  hub:        LogisticsHub;
  distanceM:  number;
  inside:     boolean;
}

/**
 * Find the nearest hub to a GPS point and whether the driver is inside it.
 */
export function findNearestHub(lat: number, lng: number): NearestHub | null {
  let nearest: NearestHub | null = null;

  for (const hub of LOGISTICS_HUBS) {
    if (!hub.active) continue;
    const distM = haversineMetres(lat, lng, hub.lat, hub.lng);
    if (!nearest || distM < nearest.distanceM) {
      nearest = { hub, distanceM: distM, inside: distM <= hub.radiusM };
    }
  }
  return nearest;
}

/**
 * Returns all hubs within a given radius of a point.
 */
export function hubsWithinRadius(lat: number, lng: number, radiusM: number): NearestHub[] {
  return LOGISTICS_HUBS
    .filter(h => h.active)
    .map(hub => ({
      hub,
      distanceM: haversineMetres(lat, lng, hub.lat, hub.lng),
      inside:    haversineMetres(lat, lng, hub.lat, hub.lng) <= hub.radiusM,
    }))
    .filter(n => n.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. QR GEOFENCE LOCK
// ─────────────────────────────────────────────────────────────────────────────

export interface QRPermissionResult {
  allowed:      boolean;
  hub?:         LogisticsHub;
  distanceM?:   number;
  reason?:      string;
  nearestHub?:  NearestHub;
}

/**
 * Called by the driver app before showing the QR code.
 * Returns allowed=true only if the driver is physically inside a
 * hub that permits this scan type.
 *
 * @param driverLat   Current GPS latitude
 * @param driverLng   Current GPS longitude
 * @param scanType    'ORIGIN' | 'DESTINATION'
 * @param shipmentId  Used to verify this scan is for the right hub
 */
export async function checkQRPermission(
  driverLat:  number,
  driverLng:  number,
  scanType:   'ORIGIN' | 'DESTINATION',
  shipmentId: string
): Promise<QRPermissionResult> {

  // Get expected hub from shipment record
  const { rows } = await db.query(`
    SELECT
      origin_lat,   origin_lng,   origin_city,
      destination_lat, destination_lng, destination_city
    FROM shipments WHERE id = $1
  `, [shipmentId]);

  if (!rows[0]) {
    return { allowed: false, reason: 'Shipment not found' };
  }

  const s = rows[0];
  const targetLat = scanType === 'ORIGIN' ? s.origin_lat   : s.destination_lat;
  const targetLng = scanType === 'ORIGIN' ? s.origin_lng   : s.destination_lng;

  // Find hubs near the target location (shipment's origin or destination)
  const nearTarget = hubsWithinRadius(targetLat, targetLng, 2000); // 2km search
  if (nearTarget.length === 0) {
    // No registered hub near this shipment point — use GPS proximity directly
    const distToTarget = haversineMetres(driverLat, driverLng, targetLat, targetLng);
    if (distToTarget <= 1000) {
      return { allowed: true, distanceM: distToTarget };
    }
    return {
      allowed:   false,
      reason:    `Vous devez être à moins de 1km du point de ${scanType === 'ORIGIN' ? 'départ' : 'livraison'}`,
      distanceM: distToTarget,
    };
  }

  // Check if driver is inside any of those hubs
  for (const nearHub of nearTarget) {
    const hub = nearHub.hub;

    // Hub must allow this scan type
    if (!hub.allowedScans.includes(scanType) && !hub.allowedScans.includes('BOTH')) continue;

    // Check operating hours (Morocco UTC+1)
    const localHour = new Date().getUTCHours() + 1;
    if (localHour < hub.operatingHours.open || localHour >= hub.operatingHours.close) {
      return {
        allowed:  false,
        reason:   `${hub.name} est fermé (horaires: ${hub.operatingHours.open}h–${hub.operatingHours.close}h)`,
        hub,
      };
    }

    // Check driver is actually inside the hub
    const distToHub = haversineMetres(driverLat, driverLng, hub.lat, hub.lng);
    if (distToHub <= hub.radiusM) {
      // Log the geofence entry
      await redis.setex(
        `geo:qr-entry:${shipmentId}:${scanType}`,
        3600,
        JSON.stringify({ hub: hub.id, lat: driverLat, lng: driverLng, ts: Date.now() })
      );
      return { allowed: true, hub, distanceM: distToHub };
    }
  }

  // Driver not inside any valid hub
  const nearest = findNearestHub(driverLat, driverLng);
  return {
    allowed:     false,
    reason:      'Vous n\'êtes pas dans la zone autorisée pour scanner ce QR',
    nearestHub:  nearest || undefined,
    distanceM:   nearest?.distanceM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. STATIONARY ALERT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const STATIONARY_CHECK_INTERVAL_MIN = 15;  // Check every 15 minutes
const STATIONARY_THRESHOLD_HOURS    = 4;   // Alert after 4h stationary
const STATIONARY_MOVEMENT_MIN_M     = 500; // Must move 500m to reset timer
const HIGHWAY_SPEED_THRESHOLD_KPH   = 10;  // Below this = "stationary"

export interface StationaryAlert {
  truckId:        string;
  truckPlate:     string;
  driverName:     string;
  driverPhone:    string;
  shipmentId:     string;
  lotNumber:      string;
  stationaryFrom: Date;
  stationaryMins: number;
  lastLat:        number;
  lastLng:        number;
  nearestHub:     NearestHub | null;
  severity:       'WARNING' | 'CRITICAL';  // WARNING=4h, CRITICAL=6h+
}

/**
 * BullMQ worker — runs every 15 minutes, checks all active shipments
 * for trucks that haven't moved.
 */
new Worker('triqlog:geo-alerts', async (job) => {
  if (job.name === 'check-stationary') {
    await runStationaryCheck();
  }
}, { connection: redis, concurrency: 1 });

/**
 * Schedule the recurring stationary check.
 */
export async function scheduleStationaryChecks(): Promise<void> {
  await alertQueue.add(
    'check-stationary',
    {},
    {
      repeat:   { every: STATIONARY_CHECK_INTERVAL_MIN * 60 * 1000 },
      jobId:    'stationary-check-recurring',
    }
  );
  console.log(`[GEO] Stationary check scheduled every ${STATIONARY_CHECK_INTERVAL_MIN} min`);
}

async function runStationaryCheck(): Promise<void> {
  // Get all trucks currently on active shipments
  const { rows: activeTrucks } = await db.query(`
    SELECT
      t.id           AS truck_id,
      t.plate        AS truck_plate,
      t.current_lat,
      t.current_lng,
      t.current_speed_kph,
      t.last_gps_at,
      u.id           AS driver_id,
      u.full_name    AS driver_name,
      u.phone        AS driver_phone,
      s.id           AS shipment_id,
      s.lot_number,
      s.origin_city,
      s.destination_city
    FROM shipments s
    JOIN trucks t ON t.id = s.truck_id
    JOIN users  u ON u.id = s.driver_id
    WHERE s.status IN ('PICKED_UP', 'IN_TRANSIT', 'ARRIVED')
      AND t.current_lat IS NOT NULL
  `);

  for (const truck of activeTrucks) {
    await checkTruckStationary(truck);
  }
}

async function checkTruckStationary(truck: any): Promise<void> {
  const key      = `geo:stationary:${truck.truck_id}`;
  const existing = await redis.get(key);

  // Get GPS pings for last 4 hours
  const { rows: pings } = await db.query(`
    SELECT lat, lng, speed_kph, recorded_at
    FROM gps_pings
    WHERE truck_id = $1
      AND recorded_at > NOW() - INTERVAL '4 hours'
    ORDER BY recorded_at ASC
  `, [truck.truck_id]);

  if (pings.length < 2) return; // Not enough data

  // Calculate total displacement over 4 hours
  const first    = pings[0];
  const last     = pings[pings.length - 1];
  const totalMovementM = haversineMetres(
    parseFloat(first.lat), parseFloat(first.lng),
    parseFloat(last.lat),  parseFloat(last.lng)
  );

  // Average speed in last 30 min
  const recentPings = pings.filter(p =>
    new Date(p.recorded_at).getTime() > Date.now() - 30 * 60 * 1000
  );
  const avgRecentSpeed = recentPings.length > 0
    ? recentPings.reduce((sum, p) => sum + (p.speed_kph || 0), 0) / recentPings.length
    : 0;

  const isStationary = totalMovementM < STATIONARY_MOVEMENT_MIN_M
                    && avgRecentSpeed  < HIGHWAY_SPEED_THRESHOLD_KPH;

  if (!isStationary) {
    // Truck is moving — clear any existing stationary timer
    if (existing) {
      await redis.del(key);
      console.log(`[GEO] Truck ${truck.truck_plate} moving again — alert cleared`);
    }
    return;
  }

  // Truck is stationary
  let stationaryFrom: Date;
  let stationaryMins: number;

  if (existing) {
    const state  = JSON.parse(existing);
    stationaryFrom = new Date(state.since);
    stationaryMins = Math.floor((Date.now() - stationaryFrom.getTime()) / 60000);
  } else {
    // First detection — record start time
    stationaryFrom = new Date(first.recorded_at);
    stationaryMins = Math.floor((Date.now() - stationaryFrom.getTime()) / 60000);
    await redis.setex(key, 24 * 3600, JSON.stringify({
      since:   stationaryFrom.toISOString(),
      lat:     last.lat,
      lng:     last.lng,
      alerted: false,
    }));
  }

  // Only alert after threshold
  const thresholdMins = STATIONARY_THRESHOLD_HOURS * 60;
  if (stationaryMins < thresholdMins) return;

  // Check if alert already sent recently (debounce 1h)
  const alertKey = `geo:alert-sent:${truck.truck_id}`;
  const alreadySent = await redis.get(alertKey);
  if (alreadySent) return;

  const severity: 'WARNING' | 'CRITICAL' = stationaryMins >= 360 ? 'CRITICAL' : 'WARNING';
  const nearestHub = findNearestHub(parseFloat(last.lat), parseFloat(last.lng));

  const alert: StationaryAlert = {
    truckId:        truck.truck_id,
    truckPlate:     truck.truck_plate,
    driverName:     truck.driver_name,
    driverPhone:    truck.driver_phone,
    shipmentId:     truck.shipment_id,
    lotNumber:      truck.lot_number,
    stationaryFrom,
    stationaryMins,
    lastLat:        parseFloat(last.lat),
    lastLng:        parseFloat(last.lng),
    nearestHub,
    severity,
  };

  // Publish to admin dashboard via Redis pub/sub
  await redis.publish('triqlog:admin-alerts', JSON.stringify({
    type:    'STATIONARY_ALERT',
    alert,
    ts:      Date.now(),
  }));

  // Persist to incidents table
  await db.query(`
    INSERT INTO incidents (
      truck_id, shipment_id, incident_type, severity,
      lat, lng, stationary_since, stationary_mins, metadata
    ) VALUES ($1, $2, 'STATIONARY', $3, $4, $5, $6, $7, $8)
    ON CONFLICT DO NOTHING
  `, [
    truck.truck_id, truck.shipment_id, severity,
    last.lat, last.lng, stationaryFrom, stationaryMins,
    JSON.stringify({ nearestHub: nearestHub?.hub?.id, driverPhone: truck.driver_phone }),
  ]);

  // Mark as sent (1h debounce)
  await redis.setex(alertKey, 3600, '1');

  console.log(`[GEO] 🚨 STATIONARY ALERT — ${truck.truck_plate} | ${stationaryMins}min | ${severity}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL: incidents table (add to schema.sql)
// ─────────────────────────────────────────────────────────────────────────────
export const INCIDENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  truck_id         UUID REFERENCES trucks(id),
  shipment_id      UUID REFERENCES shipments(id),
  incident_type    VARCHAR(40) NOT NULL,  -- 'STATIONARY' | 'GEOFENCE_VIOLATION' | 'SPEEDING'
  severity         VARCHAR(10) NOT NULL,  -- 'WARNING' | 'CRITICAL'
  lat              DECIMAL(10,7),
  lng              DECIMAL(10,7),
  stationary_since TIMESTAMPTZ,
  stationary_mins  INTEGER,
  resolved         BOOLEAN DEFAULT FALSE,
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID REFERENCES users(id),
  resolution_notes TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(truck_id, incident_type, stationary_since)
);
CREATE INDEX IF NOT EXISTS idx_incidents_truck    ON incidents(truck_id);
CREATE INDEX IF NOT EXISTS idx_incidents_unresolved ON incidents(resolved) WHERE resolved = FALSE;
`;

export default {
  LOGISTICS_HUBS,
  haversineMetres,
  findNearestHub,
  hubsWithinRadius,
  checkQRPermission,
  scheduleStationaryChecks,
};
