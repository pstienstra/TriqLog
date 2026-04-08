# 🚛 TriqLog — Morocco Digital Freight Platform
### طريق لوج · المغرب الرقمي

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TRIQLOG PLATFORM                      │
├──────────────┬──────────────┬───────────┬───────────────┤
│  Flutter App │  Node.js API │ PostgreSQL │     Redis     │
│  (Drivers)   │  (Express)   │ (Database) │  (BullMQ)     │
└──────────────┴──────────────┴───────────┴───────────────┘
```

---

## File Map

| File | Description |
|------|-------------|
| `db/schema.sql` | Full PostgreSQL schema — 9 tables + views |
| `db/wallet_schema.sql` | Wallet transactions table + provider fields |
| `services/triqlog-escrow.service.ts` | Triple-lock payment waterfall (BullMQ) |
| `services/triqlog-fuel.service.ts` | Fuel rebate calculator (90/10 split) |
| `services/triqlog-dispatch.service.ts` | Broadcast → Race → Atomic claim |
| `services/triqlog-qr.service.js` | QR generation + HMAC-SHA256 verification |
| `services/wallet/triqlog-wallet.types.ts` | Wallet types and provider interface |
| `services/wallet/triqlog-wallet.providers.ts` | CashPlus, Wafacash, Jibi, Afriquia adapters |
| `services/wallet/triqlog-wallet.service.ts` | QR_SCAN_SUCCESS listener + split engine |
| `compliance/triqlog-einvoice.service.ts` | UBL 2.1 DGI e-invoice generator |
| `geofencing/triqlog-geofence.service.ts` | Hub zones, QR lock, stationary alerts |
| `flutter/triqlog_driver_dashboard.dart` | Flutter Android driver dashboard |

---

## Revenue Model (3 / 3 / 6)

| Stream | Rate | On MAD 5,000 |
|--------|------|-------------|
| SHIPPER_CONVENIENCE_FEE | 3% on top | +MAD 150 |
| DRIVER_BASE_FEE | 3% of load | −MAD 150 |
| EXPRESS_PREMIUM | 6% of held 50% | −MAD 150 (express only) |

Standard: TriqLog MAD 300 · Driver MAD 4,850
Express:  TriqLog MAD 450 · Driver MAD 4,700

---

## Payment Waterfall

```
T1 (50%) → Origin QR Scan → immediate
  └─ 30% of net → Afriquia Fuel Card
  └─ 20% of net → Cash Out (CashPlus / Wafacash / Jibi)
T2 (25%) → GPS ≤500m → 60-min timer → auto-release
T3 (25%) → 24h informal / Net30/60 corporate
         → Express: released immediately (paid for upfront)
```

---

## Geofencing Hubs

| Hub | Radius | Hours |
|-----|--------|-------|
| Tanger Med Port | 1,000m | 24h |
| Casablanca Port | 1,000m | 06–22h |
| Casablanca ZI | 1,500m | 06–21h |
| Agadir Marché de Gros | 800m | 04–14h |
| Fès ZI Sidi Brahim | 1,200m | 07–20h |
| Kénitra Pôle Auto | 800m | 06–22h |
| Oujda Douane | 600m | 24h |
| Marrakech Parc Log. | 1,000m | 06–21h |

---

## QR Security — 27/27 Tests Passing
- HMAC-SHA256 signed payload
- Type-locked (ORIGIN ≠ DESTINATION)
- QR not shown until driver taps action button
- Expiry: 48h Origin / 7 days Destination
- Tamper detection on all fields

---

## Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js / Express / TypeScript |
| Database | PostgreSQL 15 |
| Queue | BullMQ (Redis) |
| Mobile | Flutter 3 (Android-first) |
| E-Invoice | UBL 2.1 + DGI API 2026 |
| SMS/WhatsApp | Twilio |

---

*TriqLog — طريق لوج · Logistics as Fintech · Morocco 2026*
