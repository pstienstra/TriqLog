/**
 * TRIQLOG — Wallet Types & Provider Interface
 *
 * Defines the contracts every M-Wallet provider must implement.
 * Business logic never touches provider-specific code directly —
 * it only calls WalletProvider methods.
 *
 * Providers implemented:
 *   - CashPlus    (widest informal network, ~12,000 agents)
 *   - Wafacash    (Attijariwafa, corporate + bank accounts)
 *   - Jibi        (Maroc Telecom digital wallet)
 *   - FuelCard    (Afriquia partner card — fuel only)
 *   - Internal    (TriqLog platform wallet — escrow holding)
 */

// ─── Wallet bucket types ──────────────────────────────────────────────────────
export type WalletBucket =
  | 'FUEL_CARD'         // Afriquia fuel card — restricted to fuel purchases
  | 'CASH_OUT'          // Withdrawable cash — CashPlus / Wafacash / Jibi
  | 'ESCROW'            // Held by TriqLog — released on timer events
  | 'PLATFORM'          // TriqLog revenue account
  | 'CNSS'              // Social security deduction holding

export type WalletProvider =
  | 'CASHPLUS'
  | 'WAFACASH'
  | 'JIBI'
  | 'FUEL_CARD'
  | 'INTERNAL'
  | 'BANK_WIRE'

export type TransferStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED'
  | 'REVERSED'

export type PayoutMode =
  | 'STANDARD'    // 3% fee — T3 held until shipper bank transfer clears
  | 'EXPRESS'     // 6% fee — TriqLog floats T3, driver gets everything now

// ─── Core transfer request ────────────────────────────────────────────────────
export interface WalletTransferRequest {
  idempotencyKey:   string        // UUID — prevents double-send on retry
  fromAccount:      string        // TriqLog platform account ID
  toPhone:          string        // Driver's registered mobile number
  toName:           string        // Driver full name for provider records
  amountMAD:        number        // Amount in Moroccan Dirhams
  bucket:           WalletBucket
  provider:         WalletProvider
  reference:        string        // e.g. "LOT-8821-T1-FUEL"
  description:      string        // Human-readable for statement
  metadata?:        Record<string, unknown>
}

export interface WalletTransferResult {
  success:          boolean
  transactionId?:   string        // Provider's transaction reference
  status:           TransferStatus
  amountMAD:        number
  feeMAD:           number        // Provider's own fee (usually 0 for B2B)
  netAmountMAD:     number        // What driver actually receives
  processedAt?:     Date
  failureReason?:   string
  providerRef?:     string        // Provider's internal reference
}

export interface WalletBalance {
  phone:            string
  provider:         WalletProvider
  availableMAD:     number
  pendingMAD:       number
  fuelCardMAD:      number
  lastUpdated:      Date
}

// ─── Provider interface — every adapter must implement this ───────────────────
export interface IWalletProvider {
  name:             WalletProvider
  transfer(req: WalletTransferRequest): Promise<WalletTransferResult>
  getBalance(phone: string): Promise<WalletBalance>
  reverse(transactionId: string, reason: string): Promise<boolean>
  verify(phone: string): Promise<boolean>   // Check account exists
}

// ─── Split calculation result ─────────────────────────────────────────────────
export interface WalletSplitResult {
  grossAmount:      number
  payoutMode:       PayoutMode
  feePercent:       number         // 3 or 6
  feeAmount:        number
  netAmount:        number         // gross - fee

  // T1 — released immediately on QR_SCAN_SUCCESS
  t1Total:          number         // 50% of net
  t1FuelAmount:     number         // 30% of t1Total → Fuel Card
  t1CashAmount:     number         // 20% of t1Total → Cash Out

  // T2 — released after 60-min GPS hold
  t2Amount:         number         // 25% of net

  // T3 — released after 24h (standard) or immediately (express)
  t3Amount:         number         // 25% of net
  t3HoldType:       '24H' | 'NET30' | 'NET60' | 'IMMEDIATE'

  // Platform revenue
  platformFee:      number         // feeAmount
  earlyReleaseFee?: number         // 5% of t3 if early release requested
}

// ─── QR scan success event payload ───────────────────────────────────────────
export interface QRScanSuccessEvent {
  shipmentId:       string
  lotNumber:        string
  driverId:         string
  driverPhone:      string
  driverName:       string
  shipperId:        string
  scanType:         'ORIGIN' | 'DESTINATION'
  scannedAt:        Date
  hubId:            string        // Which logistics hub
  hubName:          string
  lat:              number
  lng:              number
  payoutMode:       PayoutMode
  grossAmount:      number
  preferredProvider: WalletProvider
}
