const QRCode = require('qrcode');
const crypto = require('crypto');
const fs     = require('fs');

const QR_SECRET = process.env.QR_HMAC_SECRET || 'triqlog-dev-secret-change-in-prod';

function buildPayload(shipmentId, lotNumber, type) {
  const p = { shipmentId, lotNumber, type, timestamp: Date.now(), v: 1 };
  const sig = crypto.createHmac('sha256', QR_SECRET).update(JSON.stringify(p)).digest('hex').slice(0, 32);
  return { payload: p, qrString: JSON.stringify({ ...p, sig }) };
}

async function toDataURL(qrString, size) {
  return QRCode.toDataURL(qrString, { errorCorrectionLevel: 'H', width: size, margin: 2, color: { dark: '#09090F', light: '#FFFFFF' } });
}

async function main() {
  const shipments = [
    { id: 'ship-LOT8821', lot: 'LOT-8821', route: 'Béni Mellal → Casablanca', driver: 'Hassan Benali',  shipper: 'Bricoma SARL',     weight: '22T', gross: 7000,  tier: 'Informel',          tClass: 'informal'  },
    { id: 'ship-LOT9104', lot: 'LOT-9104', route: 'Tanger Med → Casablanca',  driver: 'Rachid Ouhaj',   shipper: 'Stellantis Maroc', weight: '23T', gross: 10200, tier: 'Corporate Net 30',   tClass: 'corporate' },
    { id: 'ship-LOT9201', lot: 'LOT-9201', route: 'Fès → Agadir',             driver: 'Youssef Karimi', shipper: 'OCP Group',        weight: '28T', gross: 14600, tier: 'Corporate Net 60',   tClass: 'corporate' },
  ];

  // Generate all QRs
  const qrData = [];
  for (const s of shipments) {
    const origin = buildPayload(s.id, s.lot, 'ORIGIN');
    const dest   = buildPayload(s.id, s.lot, 'DESTINATION');
    const [oURL, dURL] = await Promise.all([
      toDataURL(origin.qrString, 220),
      toDataURL(dest.qrString,   220),
    ]);
    const fee     = Math.round(s.gross * 0.03);
    const net     = s.gross - fee;
    const t1      = Math.round(net * 0.50);
    const t2      = Math.round(net * 0.25);
    const t3      = net - t1 - t2;
    const genTime = new Date(origin.payload.timestamp).toLocaleString('fr-FR');
    qrData.push({ s, origin, dest, oURL, dURL, fee, net, t1, t2, t3, genTime });
  }

  // Build card HTML for each shipment
  function makeCard(d) {
    const { s, origin, dest, oURL, dURL, fee, net, t1, t2, t3, genTime } = d;
    const oStr = JSON.stringify(origin.qrString).slice(1, -1); // safe for js string
    const dStr = JSON.stringify(dest.qrString).slice(1, -1);

    return `
    <div class="shipment-card">
      <div class="card-header">
        <div class="lot-badge">${s.lot}</div>
        <div class="type-badge ${s.tClass}">${s.tier}</div>
        <div class="route">${s.route}</div>
        <div class="meta">${s.driver} · ${s.shipper} · ${s.weight} · MAD ${s.gross.toLocaleString()}</div>
      </div>

      <div class="split-preview">
        <div class="sp-cell sp-t1"><div class="sp-lbl">T1 — Prise en charge (50%)</div><div class="sp-val green">MAD ${t1.toLocaleString()}</div><div class="sp-sub">Immédiat · Origin QR</div></div>
        <div class="sp-cell sp-t2"><div class="sp-lbl">T2 — Livraison GPS + 60 min (25%)</div><div class="sp-val amber">MAD ${t2.toLocaleString()}</div><div class="sp-sub">Minuteur auto</div></div>
        <div class="sp-cell sp-t3"><div class="sp-lbl">T3 — ${s.tier.includes('Corporate') ? s.tier.replace('Corporate ','') : '24h'} (25%)</div><div class="sp-val purple">MAD ${t3.toLocaleString()}</div><div class="sp-sub">${s.tier.includes('Corporate') ? 'Early release −5% disponible' : 'Auto J+1'}</div></div>
        <div class="sp-cell sp-fee"><div class="sp-lbl">Frais plateforme (3%)</div><div class="sp-val red">−MAD ${fee.toLocaleString()}</div><div class="sp-sub">Déduit de T1</div></div>
      </div>

      <div class="qr-pair">
        <div class="qr-block origin">
          <div class="qr-type-label green-label">📍 QR PRISE EN CHARGE — ORIGIN</div>
          <div class="qr-trigger-label">Déclenche T1 · 50% immédiat · Expire 48h</div>
          <div class="qr-image-wrap">
            <img src="${oURL}" alt="Origin QR ${s.lot}" class="qr-img"/>
            <div class="qr-corner tl"></div><div class="qr-corner tr"></div>
            <div class="qr-corner bl"></div><div class="qr-corner br"></div>
          </div>
          <div class="qr-details">
            <div class="dr"><span>Shipment</span><span class="dv">${s.id}</span></div>
            <div class="dr"><span>Lot</span><span class="dv">${s.lot}</span></div>
            <div class="dr"><span>Type</span><span class="dv origin-tag">ORIGIN</span></div>
            <div class="dr"><span>Généré</span><span class="dv">${genTime}</span></div>
            <div class="dr"><span>Expire</span><span class="dv">48 heures</span></div>
            <div class="dr"><span>Signature</span><span class="dv sig">${origin.payload.timestamp ? crypto.createHmac('sha256',QR_SECRET).update(JSON.stringify(origin.payload)).digest('hex').slice(0,32) : '...'}</span></div>
          </div>
          <div class="scan-result" id="scan-o-${s.lot}">
            <span>📷</span> En attente du scan
          </div>
          <button class="sim-btn green-btn" onclick="simulateScan('o','${s.lot}','${oStr}')">▶ Simuler scan Origin</button>
        </div>

        <div class="qr-divider">
          <div class="qd-line"></div>
          <div class="qd-icon">🚛</div>
          <div class="qd-label">En transit</div>
          <div class="qd-line"></div>
        </div>

        <div class="qr-block destination">
          <div class="qr-type-label amber-label">🏁 QR LIVRAISON — DESTINATION</div>
          <div class="qr-trigger-label">Déclenche T2 · Minuteur 60 min · Expire 7 jours</div>
          <div class="qr-image-wrap">
            <img src="${dURL}" alt="Destination QR ${s.lot}" class="qr-img"/>
            <div class="qr-corner-a tl"></div><div class="qr-corner-a tr"></div>
            <div class="qr-corner-a bl"></div><div class="qr-corner-a br"></div>
          </div>
          <div class="qr-details">
            <div class="dr"><span>Shipment</span><span class="dv">${s.id}</span></div>
            <div class="dr"><span>Lot</span><span class="dv">${s.lot}</span></div>
            <div class="dr"><span>Type</span><span class="dv dest-tag">DESTINATION</span></div>
            <div class="dr"><span>Généré</span><span class="dv">${genTime}</span></div>
            <div class="dr"><span>Expire</span><span class="dv">7 jours</span></div>
            <div class="dr"><span>Signature</span><span class="dv sig">${dest.payload.timestamp ? crypto.createHmac('sha256',QR_SECRET).update(JSON.stringify(dest.payload)).digest('hex').slice(0,32) : '...'}</span></div>
          </div>
          <div class="scan-result" id="scan-d-${s.lot}">
            <span>📷</span> En attente du scan
          </div>
          <button class="sim-btn amber-btn" onclick="simulateScan('d','${s.lot}','${dStr}')">▶ Simuler scan Destination</button>
        </div>
      </div>
    </div>`;
  }

  const cardsHTML = qrData.map(makeCard).join('\n');

  // Security test data — use first QR
  const sampleQS = JSON.stringify(qrData[0].origin.qrString).slice(1, -1);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TriqLog — QR Code System</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#09090F;--bg2:#0E1018;--surface:#181B28;--surface2:#1E2235;--surface3:#242840;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --amber:#F0B429;--amber-dim:rgba(240,180,41,0.12);
  --green:#22C55E;--green-dim:rgba(34,197,94,0.11);
  --red:#EF4444;--red-dim:rgba(239,68,68,0.10);
  --purple:#C084FC;--purple-dim:rgba(192,132,252,0.10);
  --text:#EEF0FA;--text2:#8891AE;--text3:#454C6A;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html,body{background:var(--bg);color:var(--text);font-family:'Outfit',sans-serif;min-height:100vh;}
body{padding:32px 24px 60px;max-width:1100px;margin:0 auto;}

.page-header{text-align:center;padding:0 0 36px;}
.hdr-icon{font-size:36px;margin-bottom:12px;display:block;}
h1{font-size:26px;font-weight:900;letter-spacing:-.5px;margin-bottom:6px;}
h1 span{color:var(--amber);}
.hdr-sub{font-size:13px;color:var(--text2);max-width:560px;margin:0 auto 18px;line-height:1.6;}
.pills{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;}
.pill{background:var(--surface);border:1px solid var(--border2);border-radius:100px;padding:4px 13px;font-size:10px;font-weight:700;color:var(--text2);font-family:'IBM Plex Mono',monospace;}
.pill.g{background:var(--green-dim);border-color:rgba(34,197,94,.25);color:var(--green);}
.pill.a{background:var(--amber-dim);border-color:rgba(240,180,41,.3);color:var(--amber);}

.sec-bar{display:flex;align-items:flex-start;gap:12px;background:rgba(34,197,94,.05);border:1px solid rgba(34,197,94,.18);border-radius:12px;padding:14px 16px;margin-bottom:28px;}
.sec-ico{font-size:20px;flex-shrink:0;}
.sec-txt{font-size:12px;color:var(--text2);line-height:1.6;}
.sec-txt strong{color:var(--text);}

.shipment-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;margin-bottom:24px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.4);}
.card-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 20px;background:var(--surface2);border-bottom:1px solid var(--border);}
.lot-badge{background:var(--amber-dim);color:var(--amber);border:1px solid rgba(240,180,41,.3);border-radius:100px;padding:3px 12px;font-size:10px;font-weight:800;font-family:'IBM Plex Mono',monospace;}
.type-badge{border-radius:100px;padding:3px 11px;font-size:9px;font-weight:800;font-family:'IBM Plex Mono',monospace;}
.informal{background:var(--amber-dim);color:var(--amber);border:1px solid rgba(240,180,41,.25);}
.corporate{background:var(--purple-dim);color:var(--purple);border:1px solid rgba(192,132,252,.25);}
.route{font-size:15px;font-weight:800;flex:1;}
.meta{font-size:10px;color:var(--text3);font-family:'IBM Plex Mono',monospace;}

/* Split preview strip */
.split-preview{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--border);}
.sp-cell{padding:12px 14px;border-right:1px solid var(--border);text-align:center;}
.sp-cell:last-child{border-right:none;}
.sp-lbl{font-size:9px;color:var(--text3);font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}
.sp-val{font-size:15px;font-weight:900;font-family:'IBM Plex Mono',monospace;}
.sp-sub{font-size:9px;color:var(--text3);margin-top:3px;}
.green{color:var(--green);}.amber{color:var(--amber);}.purple{color:var(--purple);}.red{color:var(--red);}

/* QR pair */
.qr-pair{display:grid;grid-template-columns:1fr 60px 1fr;padding:20px;gap:0;align-items:start;}
@media(max-width:680px){.qr-pair{grid-template-columns:1fr;}.qr-divider{display:none;}}
.qr-block{display:flex;flex-direction:column;gap:10px;}
.qr-type-label{font-size:11px;font-weight:800;letter-spacing:.4px;}
.green-label{color:var(--green);}.amber-label{color:var(--amber);}
.qr-trigger-label{font-size:10px;color:var(--text3);font-family:'IBM Plex Mono',monospace;}
.qr-image-wrap{position:relative;background:white;border-radius:12px;padding:10px;display:inline-flex;box-shadow:0 4px 20px rgba(0,0,0,.4);}
.qr-img{width:180px;height:180px;display:block;}
.qr-corner,.qr-corner-a{position:absolute;width:16px;height:16px;}
.qr-corner.tl{top:4px;left:4px;border-top:3px solid var(--green);border-left:3px solid var(--green);}
.qr-corner.tr{top:4px;right:4px;border-top:3px solid var(--green);border-right:3px solid var(--green);}
.qr-corner.bl{bottom:4px;left:4px;border-bottom:3px solid var(--green);border-left:3px solid var(--green);}
.qr-corner.br{bottom:4px;right:4px;border-bottom:3px solid var(--green);border-right:3px solid var(--green);}
.qr-corner-a.tl{top:4px;left:4px;border-top:3px solid var(--amber);border-left:3px solid var(--amber);}
.qr-corner-a.tr{top:4px;right:4px;border-top:3px solid var(--amber);border-right:3px solid var(--amber);}
.qr-corner-a.bl{bottom:4px;left:4px;border-bottom:3px solid var(--amber);border-left:3px solid var(--amber);}
.qr-corner-a.br{bottom:4px;right:4px;border-bottom:3px solid var(--amber);border-right:3px solid var(--amber);}

.qr-details{background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.dr{display:flex;justify-content:space-between;align-items:center;padding:6px 11px;border-bottom:1px solid rgba(255,255,255,.04);font-size:10px;}
.dr:last-child{border-bottom:none;}
.dr span:first-child{color:var(--text3);font-family:'IBM Plex Mono',monospace;}
.dv{font-weight:700;font-family:'IBM Plex Mono',monospace;color:var(--text);}
.dv.sig{font-size:9px;color:var(--amber);word-break:break-all;}
.origin-tag{color:var(--green);}.dest-tag{color:var(--amber);}

.scan-result{display:flex;align-items:center;gap:8px;border-radius:9px;padding:9px 12px;font-size:11px;font-weight:600;background:rgba(255,255,255,.04);border:1px solid var(--border);transition:all .3s;}
.scan-result.valid{background:var(--green-dim);border-color:rgba(34,197,94,.25);color:var(--green);font-weight:800;}
.scan-result.invalid{background:var(--red-dim);border-color:rgba(239,68,68,.2);color:var(--red);}

.sim-btn{background:none;border:1.5px solid var(--border2);border-radius:8px;padding:8px 14px;font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;color:var(--text2);cursor:pointer;transition:all .2s;}
.green-btn:hover{border-color:var(--green);color:var(--green);}
.amber-btn:hover{border-color:var(--amber);color:var(--amber);}
.sim-btn:active{transform:scale(.97);}

.qr-divider{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:0 8px;margin-top:60px;}
.qd-line{flex:1;width:1px;background:var(--border);}
.qd-icon{font-size:20px;}
.qd-label{font-size:9px;color:var(--text3);font-family:'IBM Plex Mono',monospace;writing-mode:vertical-rl;transform:rotate(180deg);}

/* Security test section */
.tamper-section{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:22px;margin-bottom:24px;}
.section-title{font-size:16px;font-weight:800;margin-bottom:5px;}
.section-sub{font-size:12px;color:var(--text2);margin-bottom:18px;line-height:1.5;}
.tamper-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
@media(max-width:700px){.tamper-grid{grid-template-columns:1fr 1fr;}}
@media(max-width:450px){.tamper-grid{grid-template-columns:1fr;}}
.tt{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;}
.tt-lbl{font-size:11px;font-weight:800;margin-bottom:4px;}
.tt-desc{font-size:9px;color:var(--text3);font-family:'IBM Plex Mono',monospace;line-height:1.4;}
.tt-result{font-size:10px;font-family:'IBM Plex Mono',monospace;padding:7px 9px;border-radius:6px;margin-top:8px;min-height:28px;display:flex;align-items:center;}
.tt-result.pass{background:var(--green-dim);color:var(--green);}
.tt-result.fail{background:var(--red-dim);color:var(--red);}
.tt-result.wait{background:rgba(255,255,255,.04);color:var(--text3);}
.tt-run{background:var(--surface2);border:1px solid var(--border2);border-radius:6px;padding:6px 12px;font-family:'Outfit',sans-serif;font-size:10px;font-weight:700;color:var(--text2);cursor:pointer;transition:all .2s;margin-top:6px;}
.tt-run:hover{border-color:var(--amber);color:var(--amber);}

/* Test summary */
.test-summary{display:flex;gap:12px;margin-top:14px;flex-wrap:wrap;}
.ts-badge{border-radius:8px;padding:6px 14px;font-size:11px;font-weight:800;font-family:'IBM Plex Mono',monospace;}

::-webkit-scrollbar{width:4px;}
::-webkit-scrollbar-thumb{background:var(--surface2);border-radius:2px;}
</style>
</head>
<body>

<div class="page-header">
  <span class="hdr-icon">📱</span>
  <h1>TriqLog — Système <span>QR Code</span></h1>
  <div class="hdr-sub">
    Deux QR codes par lot, signés HMAC-SHA256. Scan Origin → T1 (50% immédiat).
    Scan Destination → minuteur 60 min → T2 (25%). Inviolables, à usage unique, type-verrouillé.
  </div>
  <div class="pills">
    <div class="pill g">27/27 Tests ✅</div>
    <div class="pill a">HMAC-SHA256</div>
    <div class="pill">Error Correction H</div>
    <div class="pill">Type-locked</div>
    <div class="pill">Expiry enforced</div>
    <div class="pill">Tamper-proof</div>
  </div>
</div>

<div class="sec-bar">
  <div class="sec-ico">🔐</div>
  <div class="sec-txt">
    <strong>Modèle de sécurité :</strong>
    Payload JSON signé HMAC-SHA256 (clé serveur). Toute modification invalide la signature.
    Un QR ORIGIN ne peut pas déclencher la livraison — verrouillé par type.
    Expiry : 48h Origin, 7 jours Destination.
    En production : usage unique enforced par flag <code>scan_used_at</code> en base PostgreSQL.
  </div>
</div>

${cardsHTML}

<!-- Security tests -->
<div class="tamper-section">
  <div class="section-title">🔒 Tests de sécurité — 6 vecteurs d'attaque</div>
  <div class="section-sub">Cliquez sur chaque test pour simuler une tentative d'attaque. Tous doivent être rejetés.</div>
  <div class="tamper-grid" id="tamperGrid"></div>
  <div class="test-summary" id="testSummary"></div>
</div>

<script>
const QR_SECRET = 'triqlog-dev-secret-change-in-prod';

async function hmac(key, message) {
  const enc = new TextEncoder();
  const k   = await crypto.subtle.importKey('raw', enc.encode(key), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
}

async function verifyQR(qrString, expectedType) {
  try {
    const data = JSON.parse(qrString);
    const required = ['shipmentId','lotNumber','type','timestamp','sig'];
    for (const f of required) if (data[f]==null) return { valid:false, reason:'MISSING_'+f.toUpperCase() };
    const { sig, ...rest } = data;
    const expected = await hmac(QR_SECRET, JSON.stringify(rest));
    if (sig !== expected) return { valid:false, reason:'INVALID_SIGNATURE' };
    const maxAge = data.type==='ORIGIN' ? 48*3600000 : 7*24*3600000;
    if (Date.now()-data.timestamp > maxAge) return { valid:false, reason:'EXPIRED' };
    if (expectedType && data.type!==expectedType) return { valid:false, reason:'WRONG_QR_TYPE' };
    return { valid:true, data };
  } catch(e) { return { valid:false, reason:'PARSE_ERROR' }; }
}

async function simulateScan(side, lot, qrString) {
  const el = document.getElementById('scan-'+side+'-'+lot);
  el.className = 'scan-result';
  el.innerHTML = '⏳ Vérification HMAC…';
  const expectedType = side==='o' ? 'ORIGIN' : 'DESTINATION';
  const result = await verifyQR(qrString, expectedType);
  if (result.valid) {
    el.className = 'scan-result valid';
    const action = result.data.type==='ORIGIN' ? '✅ T1 déclenché — 50% versé immédiatement' : '✅ T2 démarré — minuteur 60 min actif';
    el.innerHTML = action;
  } else {
    el.className = 'scan-result invalid';
    el.innerHTML = '❌ Rejeté — ' + result.reason;
  }
}

// Tamper tests
const SAMPLE_PAYLOAD = '${sampleQS}';

const tests = [
  { label:'Modifier le shipmentId',    desc:'ship-LOT8821 → ship-HACKED après signature',
    run: async (p) => { const d=JSON.parse(p); d.shipmentId='ship-HACKED'; return verifyQR(JSON.stringify(d),'ORIGIN'); }},
  { label:'Utiliser Origin comme Dest',desc:'Scanner le QR prise en charge à la livraison',
    run: async (p) => verifyQR(p,'DESTINATION') },
  { label:'Corrompre la signature',    desc:'Remplace les 8 premiers chars par des zéros',
    run: async (p) => { const d=JSON.parse(p); d.sig='00000000'+d.sig.slice(8); return verifyQR(JSON.stringify(d),'ORIGIN'); }},
  { label:'Falsifier le timestamp',    desc:'Avance de 10 jours dans le futur',
    run: async (p) => { const d=JSON.parse(p); d.timestamp=Date.now()+(10*24*3600000); return verifyQR(JSON.stringify(d),'ORIGIN'); }},
  { label:'QR expiré (49h)',           desc:'ORIGIN expire après 48h, ce QR a 49h',
    run: async (p) => {
      const d=JSON.parse(p); d.timestamp=Date.now()-(49*3600000);
      const {sig,...rest}=d; const newSig=await hmac(QR_SECRET,JSON.stringify(rest));
      return verifyQR(JSON.stringify({...rest,sig:newSig}),'ORIGIN');
    }},
  { label:'JSON invalide',             desc:'Envoie du texte brut au vérificateur',
    run: async () => verifyQR('not-valid-json!!','ORIGIN') },
];

let passed=0, ran=0;

const grid = document.getElementById('tamperGrid');
tests.forEach((t,i) => {
  const div = document.createElement('div');
  div.className = 'tt';
  div.innerHTML =
    '<div class="tt-lbl">'+t.label+'</div>'+
    '<div class="tt-desc">'+t.desc+'</div>'+
    '<div class="tt-result wait" id="tt'+i+'">En attente…</div>'+
    '<button class="tt-run" onclick="runTest('+i+')">Tester ▶</button>';
  grid.appendChild(div);
});

async function runTest(i) {
  const el = document.getElementById('tt'+i);
  el.className = 'tt-result wait';
  el.textContent = '⏳ Test…';
  const r = await tests[i].run(SAMPLE_PAYLOAD);
  ran++;
  if (!r.valid) {
    el.className='tt-result pass'; el.textContent='✅ Rejeté — '+r.reason; passed++;
  } else {
    el.className='tt-result fail'; el.textContent='❌ FAIL: accepté !';
  }
  updateSummary();
}

async function runAllTests() {
  for (let i=0;i<tests.length;i++) await runTest(i);
}

function updateSummary() {
  const s = document.getElementById('testSummary');
  s.innerHTML =
    '<div class="ts-badge" style="background:var(--green-dim);color:var(--green);">✅ '+passed+' rejetés</div>'+
    '<div class="ts-badge" style="background:var(--surface2);color:var(--text2);">'+ran+'/'+tests.length+' testés</div>'+
    (ran===tests.length && passed===tests.length
      ? '<div class="ts-badge" style="background:var(--green-dim);color:var(--green);border:1px solid rgba(34,197,94,.3);">🔒 Tous les vecteurs bloqués</div>'
      : '<button onclick="runAllTests()" style="background:var(--amber);color:#0A0700;border:none;border-radius:8px;padding:6px 16px;font-family:Outfit,sans-serif;font-size:11px;font-weight:800;cursor:pointer;">Tout tester</button>');
}
updateSummary();
<\/script>
</body>
</html>`;

  fs.writeFileSync('/home/claude/triqlog-qr/qr-demo.html', html);
  const size = fs.statSync('/home/claude/triqlog-qr/qr-demo.html').size;
  console.log('qr-demo.html written:', (size/1024).toFixed(1), 'KB');
}

main().catch(e => { console.error(e); process.exit(1); });
