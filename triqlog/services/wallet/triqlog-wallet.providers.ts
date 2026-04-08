/**
 * TRIQLOG — M-Wallet Provider Adapters
 *
 * Each class wraps one provider's REST API.
 * All adapters conform to IWalletProvider.
 *
 * CashPlus  — B2B disbursement API, ~12,000 agent points Morocco
 * Wafacash  — Attijariwafa, bank-grade, corporate shippers
 * Jibi      — Maroc Telecom wallet, strong in Casablanca / Rabat
 * FuelCard  — Afriquia group card API, fuel-restricted
 */

import axios, { AxiosInstance } from 'axios';
import {
  IWalletProvider, WalletProvider, WalletTransferRequest,
  WalletTransferResult, WalletBalance,
} from './triqlog-wallet.types';

// ─── Shared retry helper ──────────────────────────────────────────────────────
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs     = 1000
): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try   { return await fn(); }
    catch (e: any) {
      lastErr = e;
      if (i < maxAttempts - 1)
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ═════════════════════════════════════════════════════════════════════════════
// CASHPLUS ADAPTER
// Docs: B2B Cash-Out API v2 — requires partner agreement + API key
// Coverage: 12,000+ agents, all major Moroccan cities
// ═════════════════════════════════════════════════════════════════════════════

export class CashPlusAdapter implements IWalletProvider {
  name: WalletProvider = 'CASHPLUS';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.CASHPLUS_API_URL || 'https://api.cashplus.ma/b2b/v2',
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${process.env.CASHPLUS_API_KEY}`,
        'X-Partner-ID':  process.env.CASHPLUS_PARTNER_ID || '',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    });
  }

  async transfer(req: WalletTransferRequest): Promise<WalletTransferResult> {
    return withRetry(async () => {
      const payload = {
        idempotencyKey:   req.idempotencyKey,
        beneficiaryMsisdn: req.toPhone.replace(/\s/g, ''),
        beneficiaryName:  req.toName,
        amount:           req.amountMAD,
        currency:         'MAD',
        reference:        req.reference,
        description:      req.description,
        partnerTxId:      req.idempotencyKey,
        notifyBeneficiary: true,     // SMS notification to driver
        channel:          'B2B_DISBURSEMENT',
      };

      try {
        const { data } = await this.client.post('/transfers/initiate', payload);

        return {
          success:        data.status === 'SUCCESS' || data.status === 'PENDING',
          transactionId:  data.transactionId,
          status:         data.status === 'SUCCESS' ? 'SUCCESS' : 'PROCESSING',
          amountMAD:      req.amountMAD,
          feeMAD:         data.fee || 0,
          netAmountMAD:   round2(req.amountMAD - (data.fee || 0)),
          processedAt:    new Date(data.processedAt || Date.now()),
          providerRef:    data.externalRef,
        };
      } catch (err: any) {
        // CashPlus 409 = duplicate idempotency key (already processed — treat as success)
        if (err.response?.status === 409) {
          return {
            success:       true,
            transactionId: err.response.data.existingTransactionId,
            status:        'SUCCESS',
            amountMAD:     req.amountMAD,
            feeMAD:        0,
            netAmountMAD:  req.amountMAD,
            processedAt:   new Date(),
            providerRef:   err.response.data.existingTransactionId,
          };
        }
        throw err;
      }
    });
  }

  async getBalance(phone: string): Promise<WalletBalance> {
    const { data } = await this.client.get(`/accounts/${phone.replace(/\s/g, '')}/balance`);
    return {
      phone,
      provider:     'CASHPLUS',
      availableMAD: data.availableBalance,
      pendingMAD:   data.pendingBalance || 0,
      fuelCardMAD:  0,
      lastUpdated:  new Date(data.timestamp),
    };
  }

  async reverse(transactionId: string, reason: string): Promise<boolean> {
    const { data } = await this.client.post(`/transfers/${transactionId}/reverse`, { reason });
    return data.reversed === true;
  }

  async verify(phone: string): Promise<boolean> {
    try {
      const { data } = await this.client.get(`/accounts/${phone.replace(/\s/g, '')}/exists`);
      return data.exists === true;
    } catch { return false; }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WAFACASH ADAPTER
// Attijariwafa bank — strongest for corporate shippers, bank account holders
// ═════════════════════════════════════════════════════════════════════════════

export class WafacashAdapter implements IWalletProvider {
  name: WalletProvider = 'WAFACASH';
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: Date | null   = null;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.WAFACASH_API_URL || 'https://api.wafacash.ma/v1',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // OAuth2 token refresh
  private async getToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }
    const { data } = await axios.post(
      `${process.env.WAFACASH_API_URL}/oauth/token`,
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     process.env.WAFACASH_CLIENT_ID     || '',
        client_secret: process.env.WAFACASH_CLIENT_SECRET || '',
        scope:         'disbursement',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 60) * 1000);
    return this.accessToken!;
  }

  async transfer(req: WalletTransferRequest): Promise<WalletTransferResult> {
    return withRetry(async () => {
      const token = await this.getToken();
      const { data } = await this.client.post(
        '/payments/disburse',
        {
          externalId:        req.idempotencyKey,
          recipientPhone:    req.toPhone,
          recipientFullName: req.toName,
          amount:            req.amountMAD,
          currency:          'MAD',
          purpose:           'TRANSPORT_PAYMENT',
          reference:         req.reference,
          remarks:           req.description,
          notifySMS:         true,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      return {
        success:       ['COMPLETED', 'PENDING'].includes(data.state),
        transactionId: data.paymentId,
        status:        data.state === 'COMPLETED' ? 'SUCCESS' : 'PROCESSING',
        amountMAD:     req.amountMAD,
        feeMAD:        data.charges || 0,
        netAmountMAD:  round2(req.amountMAD - (data.charges || 0)),
        processedAt:   new Date(data.completedAt || Date.now()),
        providerRef:   data.wafacashRef,
      };
    });
  }

  async getBalance(phone: string): Promise<WalletBalance> {
    const token = await this.getToken();
    const { data } = await this.client.get(
      `/accounts/balance?phone=${encodeURIComponent(phone)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return {
      phone,
      provider:     'WAFACASH',
      availableMAD: data.balance.available,
      pendingMAD:   data.balance.reserved || 0,
      fuelCardMAD:  0,
      lastUpdated:  new Date(data.asOf),
    };
  }

  async reverse(transactionId: string, reason: string): Promise<boolean> {
    const token = await this.getToken();
    const { data } = await this.client.post(
      `/payments/${transactionId}/refund`,
      { reason },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data.refunded === true;
  }

  async verify(phone: string): Promise<boolean> {
    try {
      const token = await this.getToken();
      const { data } = await this.client.get(
        `/accounts/lookup?phone=${encodeURIComponent(phone)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return data.accountExists === true;
    } catch { return false; }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// JIBI ADAPTER (Maroc Telecom)
// Digital wallet — strong in Casablanca, Rabat, younger drivers
// ═════════════════════════════════════════════════════════════════════════════

export class JibiAdapter implements IWalletProvider {
  name: WalletProvider = 'JIBI';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.JIBI_API_URL || 'https://api.jibi.ma/partner/v1',
      timeout: 12000,
      headers: {
        'X-Api-Key':    process.env.JIBI_API_KEY || '',
        'X-Partner':    process.env.JIBI_PARTNER_CODE || '',
        'Content-Type': 'application/json',
      },
    });
  }

  async transfer(req: WalletTransferRequest): Promise<WalletTransferResult> {
    return withRetry(async () => {
      const { data } = await this.client.post('/wallet/credit', {
        idempotencyKey:  req.idempotencyKey,
        receiverMsisdn:  req.toPhone,
        amount:          req.amountMAD * 100,   // Jibi uses centimes
        currency:        'MAD',
        label:           req.description,
        partnerReference: req.reference,
      });

      return {
        success:       data.result === 'OK',
        transactionId: data.operationId,
        status:        data.result === 'OK' ? 'SUCCESS' : 'FAILED',
        amountMAD:     req.amountMAD,
        feeMAD:        0,
        netAmountMAD:  req.amountMAD,
        processedAt:   new Date(),
        providerRef:   data.operationId,
        failureReason: data.result !== 'OK' ? data.errorMessage : undefined,
      };
    });
  }

  async getBalance(phone: string): Promise<WalletBalance> {
    const { data } = await this.client.get(`/wallet/balance/${phone}`);
    return {
      phone,
      provider:     'JIBI',
      availableMAD: data.balance / 100,
      pendingMAD:   0,
      fuelCardMAD:  0,
      lastUpdated:  new Date(),
    };
  }

  async reverse(transactionId: string, reason: string): Promise<boolean> {
    const { data } = await this.client.post(`/wallet/reverse/${transactionId}`, { reason });
    return data.result === 'OK';
  }

  async verify(phone: string): Promise<boolean> {
    try {
      const { data } = await this.client.get(`/wallet/exists/${phone}`);
      return data.exists === true;
    } catch { return false; }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FUEL CARD ADAPTER (Afriquia)
// Restricted-use card — only usable at Afriquia stations
// TriqLog negotiated group rate: −0.50 MAD/litre
// ═════════════════════════════════════════════════════════════════════════════

export class AfriquiaFuelCardAdapter implements IWalletProvider {
  name: WalletProvider = 'FUEL_CARD';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.AFRIQUIA_API_URL || 'https://fleet.afriquia.ma/api/v1',
      timeout: 10000,
      headers: {
        'Authorization': `ApiKey ${process.env.AFRIQUIA_API_KEY}`,
        'X-Fleet-ID':    process.env.AFRIQUIA_FLEET_ID || '',
        'Content-Type':  'application/json',
      },
    });
  }

  async transfer(req: WalletTransferRequest): Promise<WalletTransferResult> {
    return withRetry(async () => {
      // Afriquia fuel cards are topped up by driver card number, not phone
      // The card number is stored in users.fuel_card_number (added to schema)
      const { data } = await this.client.post('/cards/topup', {
        idempotencyRef: req.idempotencyKey,
        cardLinkedPhone: req.toPhone,
        topupAmountMAD:  req.amountMAD,
        reference:       req.reference,
        restrict:        'FUEL_ONLY',    // Card cannot be used for non-fuel
      });

      return {
        success:       data.success === true,
        transactionId: data.topupRef,
        status:        data.success ? 'SUCCESS' : 'FAILED',
        amountMAD:     req.amountMAD,
        feeMAD:        0,
        netAmountMAD:  req.amountMAD,
        processedAt:   new Date(data.timestamp || Date.now()),
        providerRef:   data.topupRef,
        failureReason: data.success ? undefined : data.error,
      };
    });
  }

  async getBalance(phone: string): Promise<WalletBalance> {
    const { data } = await this.client.get(`/cards/balance?phone=${phone}`);
    return {
      phone,
      provider:     'FUEL_CARD',
      availableMAD: 0,
      pendingMAD:   0,
      fuelCardMAD:  data.fuelBalance,
      lastUpdated:  new Date(data.asOf),
    };
  }

  async reverse(transactionId: string, reason: string): Promise<boolean> {
    const { data } = await this.client.post(`/cards/topup/${transactionId}/reverse`, { reason });
    return data.reversed === true;
  }

  async verify(phone: string): Promise<boolean> {
    try {
      const { data } = await this.client.get(`/cards/exists?phone=${phone}`);
      return data.cardExists === true;
    } catch { return false; }
  }
}
