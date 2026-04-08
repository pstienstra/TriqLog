/**
 * TRIQLOG — Morocco DGI E-Invoice Generator
 * 
 * Generates UBL 2.1 XML invoices for B2B transport transactions.
 * Compliant with Direction Générale des Impôts (DGI) e-invoicing 2026.
 * 
 * Key fields: Shipper ICE, Driver ICE (Auto-Entrepreneur), TVA 20%, DGI hash.
 * Invoice is generated ONLY after T3 is released (fully settled).
 * 
 * UBL 2.1 standard: http://docs.oasis-open.org/ubl/UBL-2.1.html
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis({ host: process.env.REDIS_HOST || 'localhost', maxRetriesPerRequest: null });
const db    = new Pool({ connectionString: process.env.DATABASE_URL });
const dispatchQueue = new Queue('triqlog:documents', { connection: redis });

// ─── Types ───────────────────────────────────────────────────────────────────

interface InvoiceParty {
  name:        string;
  ice:         string;    // 15-digit ICE
  if_number?:  string;
  rc_number?:  string;
  address:     string;
  city:        string;
  country:     string;   // 'MA'
  phone?:      string;
  email?:      string;
}

interface InvoiceLine {
  description:     string;
  quantity:        number;
  unitCode:        string;   // 'TNE' = metric tonne, 'KM', 'EA'
  unitPrice:       number;
  lineTotal:       number;
  vatCategory:     'S' | 'Z' | 'E';  // Standard, Zero, Exempt
  vatRate:         number;            // 20 for transport
}

interface InvoiceInput {
  shipmentId:        string;
  lotNumber:         string;
  issueDate:         Date;
  shipper:           InvoiceParty;
  driver:            InvoiceParty;    // Auto-Entrepreneur
  lines:             InvoiceLine[];
  netAmount:         number;          // HT
  vatAmount:         number;
  stampTax:          number;          // Timbre fiscal (20 MAD standard)
  totalTTC:          number;          // TTC = HT + TVA + timbre
  paymentDueDate?:   Date;
  dgiSequenceNumber: string;          // INV-2026-NNNN
}

// ─── DGI Hash (SHA-256 of key invoice fields) ────────────────────────────────

function generateDGIHash(input: InvoiceInput): string {
  const payload = [
    input.dgiSequenceNumber,
    input.issueDate.toISOString().split('T')[0],
    input.shipper.ice,
    input.driver.ice,
    input.netAmount.toFixed(2),
    input.vatAmount.toFixed(2),
    input.totalTTC.toFixed(2),
    input.lotNumber,
  ].join('|');

  return createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
}

// ─── UBL 2.1 XML Generator ───────────────────────────────────────────────────

function buildUBLXML(input: InvoiceInput, dgiHash: string): string {
  const isoDate     = input.issueDate.toISOString().split('T')[0];
  const dueDate     = input.paymentDueDate
    ? input.paymentDueDate.toISOString().split('T')[0]
    : isoDate;

  const linesXML = input.lines.map((line, idx) => `
    <cac:InvoiceLine>
      <cbc:ID>${idx + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${line.unitCode}">${line.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="MAD">${line.lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXML(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${line.vatCategory}</cbc:ID>
          <cbc:Percent>${line.vatRate}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="MAD">${line.unitPrice.toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:dgi="urn:dgi:ma:einvoice:2026">

  <!-- ═══ DGI CLEARANCE BLOCK ═══ -->
  <dgi:ClearanceMetadata>
    <dgi:InvoiceHash>${dgiHash}</dgi:InvoiceHash>
    <dgi:HashAlgorithm>SHA-256</dgi:HashAlgorithm>
    <dgi:GeneratedAt>${input.issueDate.toISOString()}</dgi:GeneratedAt>
    <dgi:Platform>TriqLog-TRIQLOG-v1</dgi:Platform>
  </dgi:ClearanceMetadata>

  <!-- ═══ HEADER ═══ -->
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:dgi:ma:einvoice:customization:1.0</cbc:CustomizationID>
  <cbc:ID>${escapeXML(input.dgiSequenceNumber)}</cbc:ID>
  <cbc:IssueDate>${isoDate}</cbc:IssueDate>
  <cbc:DueDate>${dueDate}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Transport routier · Lot: ${escapeXML(input.lotNumber)} · Plateforme TRIQLOG</cbc:Note>
  <cbc:DocumentCurrencyCode>MAD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>MAD</cbc:TaxCurrencyCode>
  <cbc:BuyerReference>${escapeXML(input.lotNumber)}</cbc:BuyerReference>

  <!-- ═══ SHIPPER (AccountingSupplierParty) ═══ -->
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="ICE">${escapeXML(input.shipper.ice)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyIdentification>
        <cbc:ID schemeID="IF">${escapeXML(input.shipper.if_number || '')}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${escapeXML(input.shipper.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXML(input.shipper.address)}</cbc:StreetName>
        <cbc:CityName>${escapeXML(input.shipper.city)}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>MA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:Contact>
        <cbc:Telephone>${escapeXML(input.shipper.phone || '')}</cbc:Telephone>
        <cbc:ElectronicMail>${escapeXML(input.shipper.email || '')}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <!-- ═══ DRIVER / AUTO-ENTREPRENEUR (AccountingCustomerParty) ═══ -->
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="ICE_AE">${escapeXML(input.driver.ice)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${escapeXML(input.driver.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:CityName>${escapeXML(input.driver.city)}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>MA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:Contact>
        <cbc:Telephone>${escapeXML(input.driver.phone || '')}</cbc:Telephone>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <!-- ═══ TAX TOTAL (TVA 20%) ═══ -->
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="MAD">${input.vatAmount.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="MAD">${input.netAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="MAD">${input.vatAmount.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>20</cbc:Percent>
        <cbc:TaxExemptionReason>Transport routier national — TVA 20%</cbc:TaxExemptionReason>
        <cac:TaxScheme><cbc:ID>TVA</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>

  <!-- ═══ TIMBRE FISCAL ═══ -->
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReasonCode>TAX</cbc:AllowanceChargeReasonCode>
    <cbc:AllowanceChargeReason>Timbre fiscal</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="MAD">${input.stampTax.toFixed(2)}</cbc:Amount>
  </cac:AllowanceCharge>

  <!-- ═══ MONETARY TOTALS ═══ -->
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="MAD">${input.netAmount.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="MAD">${input.netAmount.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="MAD">${(input.netAmount + input.vatAmount).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:ChargeTotalAmount currencyID="MAD">${input.stampTax.toFixed(2)}</cbc:ChargeTotalAmount>
    <cbc:PayableAmount currencyID="MAD">${input.totalTTC.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  <!-- ═══ INVOICE LINES ═══ -->
  ${linesXML}

</Invoice>`;
}

function escapeXML(str: string): string {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// ─── Auto-Sequence Generator ─────────────────────────────────────────────────

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const { rows } = await db.query(`
    SELECT COUNT(*) + 1 AS next_seq
    FROM documents
    WHERE doc_type = 'INVOICE'
      AND EXTRACT(YEAR FROM created_at) = $1
  `, [year]);
  const seq = String(rows[0].next_seq).padStart(4, '0');
  return `INV-${year}-${seq}`;
}

// ─── Main: Generate & Persist Invoice ───────────────────────────────────────

export async function generateEInvoice(shipmentId: string): Promise<{
  docNumber:  string;
  dgiHash:    string;
  xmlContent: string;
}> {
  // Fetch all data needed
  const { rows } = await db.query(`
    SELECT
      s.lot_number, s.origin_city, s.destination_city,
      s.cargo_type, s.weight_tonnes, s.cargo_description,
      s.delivery_deadline,
      -- Shipper
      sh.full_name     AS shipper_name,
      sh.ice           AS shipper_ice,
      sh.if_number     AS shipper_if,
      sh.rc_number     AS shipper_rc,
      sh.company_name  AS shipper_company,
      sh.phone         AS shipper_phone,
      sh.email         AS shipper_email,
      sh.city          AS shipper_city,
      -- Driver
      d.full_name      AS driver_name,
      d.ice            AS driver_ice,
      d.ae_number      AS driver_ae,
      d.phone          AS driver_phone,
      d.city           AS driver_city,
      -- Financials
      f.gross_amount,
      f.platform_fee_amount,
      f.net_to_driver,
      f.fully_settled_at
    FROM shipments s
    JOIN users sh ON sh.id = s.shipper_id
    JOIN users d  ON d.id  = s.driver_id
    JOIN financials f ON f.shipment_id = s.id
    WHERE s.id = $1
      AND s.status = 'COMPLETED'
      AND f.fully_settled_at IS NOT NULL
  `, [shipmentId]);

  if (!rows[0]) {
    throw new Error(`Shipment ${shipmentId} not settled — cannot generate invoice`);
  }

  const r            = rows[0];
  const docNumber    = await nextInvoiceNumber();
  const netHT        = parseFloat(r.gross_amount);           // Gross = HT in transport
  const vatAmount    = Math.round(netHT * 20) / 100;        // TVA 20%
  const stampTax     = 20;                                   // Fixed timbre fiscal
  const totalTTC     = Math.round((netHT + vatAmount + stampTax) * 100) / 100;

  const input: InvoiceInput = {
    shipmentId,
    lotNumber:  r.lot_number,
    issueDate:  new Date(r.fully_settled_at),
    dgiSequenceNumber: docNumber,

    shipper: {
      name:      r.shipper_company || r.shipper_name,
      ice:       r.shipper_ice     || '000000000000000',
      if_number: r.shipper_if,
      rc_number: r.shipper_rc,
      address:   r.origin_city,
      city:      r.shipper_city || r.origin_city,
      country:   'MA',
      phone:     r.shipper_phone,
      email:     r.shipper_email,
    },

    driver: {
      name:    r.driver_name,
      ice:     r.driver_ice || r.driver_ae || '000000000000000',
      address: r.driver_city,
      city:    r.driver_city,
      country: 'MA',
      phone:   r.driver_phone,
    },

    lines: [
      {
        description: `Transport routier ${r.origin_city} → ${r.destination_city} — ${r.weight_tonnes}T ${r.cargo_type}`,
        quantity:    1,
        unitCode:    'EA',
        unitPrice:   netHT,
        lineTotal:   netHT,
        vatCategory: 'S',
        vatRate:     20,
      },
    ],

    netAmount:   netHT,
    vatAmount,
    stampTax,
    totalTTC,
    paymentDueDate: r.delivery_deadline ? new Date(r.delivery_deadline) : undefined,
  };

  const dgiHash  = generateDGIHash(input);
  const xmlContent = buildUBLXML(input, dgiHash);

  // Persist to documents table
  await db.query(`
    INSERT INTO documents (
      shipment_id, doc_type, doc_number,
      dgi_hash, xml_content,
      shipper_ice, driver_ice,
      vat_amount, gross_amount
    ) VALUES ($1, 'INVOICE', $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (doc_number) DO NOTHING
  `, [
    shipmentId, docNumber, dgiHash, xmlContent,
    r.shipper_ice, r.driver_ice,
    vatAmount, netHT,
  ]);

  // Queue for dispatch (email + SMS + DGI API submission)
  await dispatchQueue.add('dispatch-invoice', {
    shipmentId,
    docNumber,
    dgiHash,
    shipperEmail: r.shipper_email,
    shipperPhone: r.shipper_phone,
    driverPhone:  r.driver_phone,
    totalTTC,
  }, { delay: 1000 });

  console.log(`[INVOICE] Generated ${docNumber} | Hash: ${dgiHash.slice(0, 16)}… | TTC: MAD ${totalTTC}`);

  return { docNumber, dgiHash, xmlContent };
}

// ─── DGI API Submission (stub — connect to DGI portal when live) ─────────────

export async function submitToDGI(docNumber: string, xmlContent: string, dgiHash: string): Promise<{
  acknowledged: boolean;
  dgiRef:       string;
}> {
  // In production: POST to https://api.dgi.ma/einvoice/submit
  // with mTLS certificate + OAuth2 token
  // 
  // const response = await fetch(process.env.DGI_API_URL, {
  //   method:  'POST',
  //   headers: { 'Content-Type': 'application/xml', 'Authorization': `Bearer ${token}` },
  //   body:    xmlContent,
  // });

  // Stub response for development
  const dgiRef = `DGI-${new Date().getFullYear()}-${Math.floor(Math.random() * 999999).toString().padStart(6, '0')}`;

  await db.query(`
    UPDATE documents SET
      dgi_submitted_at    = NOW(),
      dgi_acknowledged_at = NOW(),
      dgi_ref             = $1
    WHERE doc_number = $2
  `, [dgiRef, docNumber]);

  console.log(`[DGI] Submitted ${docNumber} → Ref: ${dgiRef}`);
  return { acknowledged: true, dgiRef };
}

export default { generateEInvoice, submitToDGI, generateDGIHash };
