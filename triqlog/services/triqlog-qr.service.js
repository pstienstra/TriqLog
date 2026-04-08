/**
 * TRIQLOG — QR Code Service
 *
 * Generates and verifies tamper-proof QR codes for shipment scan events.
 * Each QR code carries a signed JSON payload (HMAC-SHA256).
 *
 * Two QR codes per shipment:
 *   ORIGIN      — Scanned by driver at pickup      → triggers T1 release
 *   DESTINATION — Scanned by driver at delivery    → starts 60-min T2 timer
 *
 * Security model:
 *   - Payload signed with HMAC-SHA256 (server secret)
 *   - Expiry: ORIGIN = 48h, DESTINATION = 7 days (allows delays)
 *   - One-time use enforced via DB flag (scan_used_at)
 *   - Type-locked: ORIGIN code cannot trigger DESTINATION event
 */

const QRCode = require('qrcode');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const QR_SECRET      = process.env.QR_HMAC_SECRET || 'triqlog-dev-secret-change-in-prod';
const SIG_LENGTH     = 32;   // hex chars (128-bit HMAC prefix)
const ORIGIN_MAX_AGE = 48  * 60 * 60 * 1000;   // 48 hours
const DEST_MAX_AGE   = 7   * 24 * 60 * 60 * 1000; // 7 days

const QR_OPTIONS = {
  errorCorrectionLevel: 'H',   // Highest — survives partial damage/dirt
  type:                 'image/png',
  margin:               2,
  color: {
    dark:  '#09090F',   // TriqLog dark background
    light: '#FFFFFF',
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} QRPayload
 * @property {string} shipmentId
 * @property {string} lotNumber
 * @property {'ORIGIN'|'DESTINATION'} type
 * @property {number} timestamp
 * @property {string} sig   - HMAC-SHA256 signature
 */

/**
 * @typedef {Object} QRVerifyResult
 * @property {boolean} valid
 * @property {QRPayload|null} data
 * @property {string|null} reason   - Error reason if invalid
 */

// ─── GENERATE ────────────────────────────────────────────────────────────────

/**
 * Creates the signed JSON string embedded in the QR code.
 * @param {string} shipmentId
 * @param {string} lotNumber
 * @param {'ORIGIN'|'DESTINATION'} type
 * @returns {string} JSON string to encode in QR
 */
function buildQRPayload(shipmentId, lotNumber, type) {
  const payload = {
    shipmentId,
    lotNumber,
    type,
    timestamp: Date.now(),
    v: 1,           // schema version for future compatibility
  };

  // Sign the payload (without sig field present)
  const sig = crypto
    .createHmac('sha256', QR_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, SIG_LENGTH);

  return JSON.stringify({ ...payload, sig });
}

/**
 * Generates a QR code as a base64 PNG data URL.
 * Suitable for embedding in HTML email or mobile app.
 *
 * @param {string} shipmentId
 * @param {string} lotNumber
 * @param {'ORIGIN'|'DESTINATION'} type
 * @param {number} [size=400]  - pixel width
 * @returns {Promise<{dataURL: string, payload: string}>}
 */
async function generateQRDataURL(shipmentId, lotNumber, type, size = 400) {
  const qrString = buildQRPayload(shipmentId, lotNumber, type);

  const dataURL = await QRCode.toDataURL(qrString, {
    ...QR_OPTIONS,
    width: size,
  });

  return { dataURL, payload: qrString };
}

/**
 * Generates a QR code as an SVG string.
 * Lighter weight for WhatsApp messages and PDFs.
 *
 * @param {string} shipmentId
 * @param {string} lotNumber
 * @param {'ORIGIN'|'DESTINATION'} type
 * @returns {Promise<{svg: string, payload: string}>}
 */
async function generateQRSVG(shipmentId, lotNumber, type) {
  const qrString = buildQRPayload(shipmentId, lotNumber, type);

  const svg = await QRCode.toString(qrString, {
    type:                 'svg',
    errorCorrectionLevel: 'H',
    margin:               2,
  });

  return { svg, payload: qrString };
}

/**
 * Generates a QR code PNG saved to disk.
 * Used for generating printable load documents.
 *
 * @param {string} shipmentId
 * @param {string} lotNumber
 * @param {'ORIGIN'|'DESTINATION'} type
 * @param {string} outputPath
 * @returns {Promise<{filePath: string, payload: string}>}
 */
async function generateQRFile(shipmentId, lotNumber, type, outputPath) {
  const qrString = buildQRPayload(shipmentId, lotNumber, type);

  await QRCode.toFile(outputPath, qrString, {
    ...QR_OPTIONS,
    width: 500,
  });

  return { filePath: outputPath, payload: qrString };
}

/**
 * Generate BOTH origin and destination QR codes for a shipment at once.
 * Returns base64 PNGs ready to embed in email / waybill PDF.
 *
 * @param {string} shipmentId
 * @param {string} lotNumber
 * @returns {Promise<{origin: Object, destination: Object}>}
 */
async function generateShipmentQRPair(shipmentId, lotNumber) {
  const [origin, destination] = await Promise.all([
    generateQRDataURL(shipmentId, lotNumber, 'ORIGIN',      350),
    generateQRDataURL(shipmentId, lotNumber, 'DESTINATION', 350),
  ]);
  return { origin, destination };
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────

/**
 * Verifies a QR code scanned by the driver.
 * Checks: signature, expiry, type correctness.
 *
 * @param {string}                    qrString  - Raw string from camera scan
 * @param {'ORIGIN'|'DESTINATION'}    expectedType
 * @returns {QRVerifyResult}
 */
function verifyQR(qrString, expectedType) {
  // 1. Parse
  let data;
  try {
    data = JSON.parse(qrString);
  } catch {
    return { valid: false, data: null, reason: 'PARSE_ERROR' };
  }

  // 2. Required fields present
  const required = ['shipmentId', 'lotNumber', 'type', 'timestamp', 'sig'];
  for (const field of required) {
    if (data[field] == null) {
      return { valid: false, data: null, reason: `MISSING_FIELD_${field.toUpperCase()}` };
    }
  }

  // 3. Verify HMAC signature
  const { sig, ...payloadWithoutSig } = data;
  const expectedSig = crypto
    .createHmac('sha256', QR_SECRET)
    .update(JSON.stringify(payloadWithoutSig))
    .digest('hex')
    .slice(0, SIG_LENGTH);

  if (!crypto.timingSafeEqual(
    Buffer.from(sig,         'hex'),
    Buffer.from(expectedSig, 'hex')
  )) {
    return { valid: false, data: null, reason: 'INVALID_SIGNATURE' };
  }

  // 4. Check expiry
  const maxAge = data.type === 'ORIGIN' ? ORIGIN_MAX_AGE : DEST_MAX_AGE;
  const age    = Date.now() - data.timestamp;
  if (age > maxAge) {
    return { valid: false, data: null, reason: 'EXPIRED' };
  }

  // 5. Type must match what we expect at this scan point
  if (expectedType && data.type !== expectedType) {
    return {
      valid:  false,
      data:   null,
      reason: `WRONG_QR_TYPE_GOT_${data.type}_EXPECTED_${expectedType}`,
    };
  }

  return { valid: true, data, reason: null };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  generateQRDataURL,
  generateQRSVG,
  generateQRFile,
  generateShipmentQRPair,
  verifyQR,
  buildQRPayload,  // exposed for testing
};
