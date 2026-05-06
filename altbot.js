'use strict';

// ============================================================
// ALT-BOT — Confirmation dépôts ligne par ligne
// Logique : my-managment (ligne par ligne, plus ancienne en 1er)
//   → cherche le paiement dans YapsonPress (expéditeur déduit
//     de la colonne "NOM DE LA BANQUE")
//   → confirme si paiement trouvé APRÈS la commande
//   → rejette si introuvable et âge >= seuil rejet
//
// Paramètres configurables depuis le dashboard :
//   - CONF_MIN  : traiter les commandes de plus de X min (2/10/30)
//   - REJ_MIN   : rejeter les commandes de plus de X min (45/50/60)
// ============================================================

const express = require('express');
const fetch   = require('node-fetch');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Variables d'environnement ─────────────────────────────────
const YAPSON_TOKEN = process.env.YAPSON_TOKEN || '';
const YAPSON_URL   = (process.env.YAPSON_URL || 'https://sms-mirror-production.up.railway.app').replace(/\/$/, '');
const MGMT_URL     = (process.env.MGMT_URL   || 'https://my-managment.com').replace(/\/$/, '');
const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || '30', 10);
const PORT         = parseInt(process.env.PORT || '3000', 10);

// Valeurs autorisées
const CONF_MIN_ALLOWED = [2, 10, 30];
const REJ_MIN_ALLOWED  = [45, 50, 60];

// ── État global ───────────────────────────────────────────────
let state = {
  status: 'starting',
  polls: 0,
  confirmed: 0,
  rejected: 0,
  approved: 0,
  errors: 0,
  logs: [],
  lastRun: null,
  cookiesReady: false,
  cookies: null,
  yapsonToken: YAPSON_TOKEN,
};

// Config modifiable depuis le dashboard
let altConfig = {
  confMin:  parseInt(process.env.CONF_MIN || '10', 10),  // traiter si âge >= confMin
  rejMin:   parseInt(process.env.REJ_MIN  || '50', 10),  // rejeter si âge >= rejMin
};

// ── Logs ──────────────────────────────────────────────────────
function log(msg) {
  const ts    = new Date().toLocaleTimeString('fr-FR');
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  state.logs.unshift(entry);
  if (state.logs.length > 300) state.logs.pop();
}

// ── Utilitaires ───────────────────────────────────────────────
function normPhone(s) {
  if (!s) return '';
  const d = String(s).replace(/[^\d]/g, '');
  if (d.length === 13 && d.startsWith('2250')) return d.slice(3);
  if (d.length === 12 && d.startsWith('225'))  return '0' + d.slice(3);
  return d;
}

function parseAmount(s) {
  if (!s) return 0;
  const str     = String(s).trim();
  const numPart = str.match(/^[\d\s\u00a0.,]+/)?.[0] || str;
  const clean   = numPart.replace(/[\s\u00a0]/g, '').replace(/[.,]\d{1,2}$/, '');
  return parseInt(clean.replace(/[^\d]/g, ''), 10) || 0;
}

function fmtAmt(n) { return (n || 0).toLocaleString('fr-FR'); }

function parseMgmtDate(str) {
  if (!str) return null;
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`);
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00Z`);
  return null;
}

// Extraire le nombre de minutes depuis la colonne "PROCESSING TIME"
// ex: "10 minutes" → 10, "less than 1 minute" → 0, "2 heures, 3 minutes" → 123
function parseProcessingTime(str) {
  if (!str) return 0;
  const s = str.toLowerCase();
  if (s.includes('less than') || s.includes('moins')) return 0;
  let total = 0;
  const hm = s.match(/(\d+)\s*heure/);
  const mm = s.match(/(\d+)\s*minute/);
  if (hm) total += parseInt(hm[1]) * 60;
  if (mm) total += parseInt(mm[1]);
  if (!hm && !mm) {
    const num = s.match(/(\d+)/);
    if (num) total = parseInt(num[1]);
  }
  return total;
}

// Déduire l'expéditeur YapsonPress depuis la colonne "NOM DE LA BANQUE"
// Wave → "Wave Business" | Orange → "+454" | Mtn/Mobile → "MobileMoney" | Moov → "MoovMoney"
function bankToSender(bankName) {
  const b = (bankName || '').toLowerCase();
  if (b.includes('wave'))   return 'Wave Business';
  if (b.includes('orange')) return '+454';
  if (b.includes('mtn') || b.includes('mobile')) return 'MobileMoney';
  if (b.includes('moov'))   return 'MoovMoney';
  return null; // inconnu → chercher dans tous
}

// Retourne le nom d'expéditeur effectif d'un message YapsonPress
function getMsgSender(msg) {
  return msg.sender || msg.app_name || msg.sender_name || msg.device_name || '';
}

// ── Normalisation timestamp ───────────────────────────────────
function normTs(raw) {
  if (!raw) return null;
  let ts;
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && d.getTime() > 1e12) return d.getTime();
    ts = parseFloat(raw);
  } else {
    ts = Number(raw);
  }
  if (isNaN(ts) || ts <= 0) return null;
  if (ts < 1e11) ts = ts * 1000; // secondes → ms
  return ts;
}

// ── Parseurs SMS YapsonPress ──────────────────────────────────
function parseMsg(sender, content) {
  if (sender === 'Wave Business') {
    const m = content.match(/\((0\d{9})\)\s+a\s+pay[eé]\s+([\d\s\u00a0.,]+)\s*F/i);
    if (m) return { phone: m[1], amount: parseAmount(m[2]) };
  }
  if (sender === '+454' || sender.includes('MobileMoney') || sender.includes('Orange')) {
    const m1 = content.match(/recu\s+([\d\s.,]+)\s*FCFA\s+du\s+\+?225\s*(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    const m2 = content.match(/transfert de ([\d\s.,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m2) return { phone: normPhone(m2[2]), amount: parseAmount(m2[1]) };
    const m3 = content.match(/([\d\s.,]+)\s*FCFA.*?(0\d{9})/i);
    if (m3) return { phone: normPhone(m3[2]), amount: parseAmount(m3[1]) };
    const m4 = content.match(/(0\d{9}).*?([\d\s.,]+)\s*FCFA/i);
    if (m4) return { phone: normPhone(m4[1]), amount: parseAmount(m4[2]) };
  }
  if (sender.includes('MoovMoney')) {
    const m1 = content.match(/de\s+([\d\s.,]+)\s*FCFA\s+du\s+(0\d{9})/i);
    if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
    const m2 = content.match(/(0\d{9}).*?([\d\s.,]+)\s*FCFA/i);
    if (m2) return { phone: normPhone(m2[1]), amount: parseAmount(m2[2]) };
  }
  // Générique : n'importe quel expéditeur
  const g = content.match(/(0\d{9}).*?(\d[\d\s\u00a0]{2,})/);
  if (g) return { phone: g[1], amount: parseAmount(g[2]) };
  return null;
}

// ── API YapsonPress ───────────────────────────────────────────
// Fetch les messages d'un expéditeur précis depuis fromTs
async function yapsonSearch(senderFilter, phone, fromTs) {
  const token = state.yapsonToken;
  if (!token) throw new Error('YAPSON_TOKEN manquant');
  const res = await fetch(`${YAPSON_URL}/api/messages`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`YapsonPress API ${res.status}`);
  const data = await res.json();
  const messages = Array.isArray(data) ? data : (data.messages || data.data || Object.values(data));

  const results = [];
  for (const msg of messages) {
    const sender = getMsgSender(msg);
    // Filtrer sur l'expéditeur attendu (ou tous si null)
    if (senderFilter && !sender.includes(senderFilter)) continue;

    const parsed = parseMsg(sender, msg.content || msg.body || msg.message || '');
    if (!parsed) continue;
    if (normPhone(String(parsed.phone)) !== phone) continue;

    const ts = normTs(msg.timestamp)
            || normTs(msg.received_at)
            || normTs(msg.createdAt)
            || normTs(msg.created_at)
            || normTs(msg.date)
            || normTs(msg.time);

    // Inclure si ts >= fromTs (paiement après/pendant la commande)
    // ou si pas de timestamp (inclure par défaut)
    if (ts && ts < fromTs) continue;

    results.push({
      phone:    parsed.phone,
      amount:   parsed.amount,
      msgId:    msg.id || msg._id,
      approved: msg.status === 'approuve' || msg.status === 'approved',
      sender,
      ts: ts || Date.now(),
    });
  }
  return results;
}

async function yapsonApprove(msgId) {
  const token = state.yapsonToken;
  try {
    const res = await fetch(`${YAPSON_URL}/api/messages/${msgId}/status`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approuve' }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Playwright : session my-managment ────────────────────────
let browser = null;
let page    = null;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    log('🚀 Lancement Chromium…');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
  }
}

async function mgmtLogin() {
  if (!state.cookies) {
    log('🍪 Cookies my-managment requis — en attente via le dashboard…');
    state.status     = 'waiting_cookies';
    state.cookiesReady = false;
    for (let i = 0; i < 1800; i++) {
      if (state.cookies) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!state.cookies) throw new Error('Cookies timeout');
  }
  log('🍪 Injection des cookies my-managment…');
  await ensureBrowser();
  let cookieList;
  try {
    cookieList = JSON.parse(state.cookies);
    if (!Array.isArray(cookieList)) throw new Error('Format invalide');
  } catch(e) {
    state.cookies      = null;
    state.cookiesReady = false;
    throw new Error('Cookies JSON invalides');
  }
  await page.goto(MGMT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const context = page.context();
  await context.clearCookies();
  const cleaned = cookieList.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain || '.my-managment.com',
    path:     c.path   || '/',
    httpOnly: c.httpOnly || false,
    secure:   c.secure   || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
  await context.addCookies(cleaned);
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
  if (page.url().includes('login') || page.url().includes('signin')) {
    state.cookies      = null;
    state.cookiesReady = false;
    state.status       = 'waiting_cookies';
    throw new Error('Cookies refusés par my-managment');
  }
  log('✅ Connecté à my-managment via cookies');
  state.cookiesReady = true;
  state.status       = 'running';
}

async function ensureLoggedIn() {
  await ensureBrowser();
  if (!state.cookiesReady || !state.cookies) {
    await mgmtLogin();
    return;
  }
  try {
    const url = page.url();
    if (!url || url.includes('login') || url.includes('signin') || url === 'about:blank') {
      await mgmtLogin();
    }
  } catch { await mgmtLogin(); }
}

// ── Injecter une valeur dans un input Vue.js ──────────────────
async function setVueInput(locator, value) {
  await locator.evaluate((el, val) => {
    el.focus();
    el.select && el.select();
    const proto      = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, '');
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }, String(value));
  await page.waitForTimeout(200);
}

// ── Attendre le bouton CONFIRMER dans la modale ───────────────
async function waitModalConfirmBtn(timeoutMs = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    await page.evaluate(() => {
      document.querySelectorAll('.container-preloader').forEach(p => p.style.display = 'none');
    }).catch(() => {});
    for (const b of await page.$$('button')) {
      try {
        const txt = (await b.textContent()).trim().toUpperCase();
        const box = await b.boundingBox();
        if (txt === 'CONFIRMER' && box && box.width > 80) return b;
      } catch { /* ignore */ }
    }
    for (const b of await page.$$('button.btn-success')) {
      try {
        const txt = (await b.textContent()).trim();
        const box = await b.boundingBox();
        if (txt === 'Confirmer' && box && box.width > 50) return b;
      } catch { /* ignore */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// ── Attendre la fermeture de la modale ────────────────────────
async function waitModalClose(timeoutMs = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    await page.evaluate(() => {
      document.querySelectorAll('.container-preloader').forEach(p => p.style.display = 'none');
    }).catch(() => {});
    let found = false;
    for (const b of await page.$$('button')) {
      try {
        const txt = (await b.textContent()).trim().toUpperCase();
        if (txt === 'CONFIRMER') { found = true; break; }
      } catch { /* ignore */ }
    }
    if (!found) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

// ── Corriger le montant dans la modale ────────────────────────
async function fixModalAmount(montant) {
  await page.waitForTimeout(500);
  const amtLocator = page.locator(
    'input[placeholder="Montant"], input[placeholder="montant"], input[placeholder="Amount"], ' +
    '[role="dialog"] input[type="number"], .modal input[type="number"]'
  ).first();
  if (await amtLocator.count() > 0) {
    await setVueInput(amtLocator, String(montant));
    log(`ALT ✏ Montant modale → ${fmtAmt(montant)}F`);
  }
  // Remplir Commentaire avec le montant (trace)
  const commLocator = page.locator(
    'input[placeholder="Commentaire"], textarea[placeholder="Commentaire"], ' +
    'input[placeholder="commentaire"], textarea[placeholder="commentaire"]'
  ).first();
  if (await commLocator.count() > 0) {
    await setVueInput(commLocator, String(montant));
  }
}

// ── ALT-BOT principal ─────────────────────────────────────────
async function runAlt() {
  log('▶ ALT-BOT — Cycle démarré…');
  await ensureLoggedIn();

  const { confMin, rejMin } = altConfig;
  const now = Date.now();

  // ── 1. Charger le tableau my-managment ───────────────────────
  log('ALT [1/4] Lecture des demandes en attente…');
  await page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });

  try {
    // Désactiver la mise à jour auto
    const toggleEl = await page.$('.toggle--is-checked, input[type="checkbox"].toggle, [class*="toggle"][class*="active"]');
    if (toggleEl) { await toggleEl.dispatchEvent('click'); await page.waitForTimeout(500); }
    // Sélectionner 500 lignes
    const ms = await page.$('.input-group.select-box .multiselect');
    if (ms) {
      const current = await page.$eval('.multiselect__single', el => el.textContent.trim()).catch(() => '');
      if (current !== '500') {
        const selectBtn = await ms.$('.multiselect__select');
        if (selectBtn) { await selectBtn.click(); await page.waitForTimeout(400); }
        const options = await ms.$$('.multiselect__element');
        for (const opt of options) {
          if ((await opt.textContent()).trim() === '500') { await opt.$('span')?.click(); break; }
        }
        await page.waitForTimeout(300);
      }
    }
    const applyBtn = await page.$('button:has-text("Appliquer"), button:has-text("APPLIQUER")');
    if (applyBtn) { await applyBtn.click(); await page.waitForTimeout(3000); }
  } catch(e) { log(`⚠ Setup tableau: ${e.message.substring(0, 60)}`); }

  // ── 2. Lire toutes les lignes et trier par date (plus ancienne en premier) ──
  const rowLocators = page.locator('table tbody tr');
  const rowCount    = await rowLocators.count();
  const rows = [];
  for (let ri = 0; ri < rowCount; ri++) {
    try {
      const rh    = rowLocators.nth(ri);
      const cells = await rh.locator('td').allInnerTexts();
      // Colonnes : DATE DE CRÉATION | INFOS SUR L'UTILISATEUR | MONTANT | NOM DE LA BANQUE | PROCESSING TIME | CONFIRMER | REJETER
      if (cells.length < 5) continue;
      // Extraire le numéro de téléphone
      const phoneMatch = (cells[1] || '').match(/(0\d{9})/);
      if (!phoneMatch) continue;
      // Vérifier qu'il y a un lien "Confirmer"
      const hasConfirm = (await rh.locator('a').allInnerTexts()).some(t => t.trim() === 'Confirmer');
      if (!hasConfirm) continue;

      const dateTs   = parseMgmtDate(cells[0])?.getTime() ?? (now - 60 * 60 * 1000);
      const procTime = parseProcessingTime(cells[4]); // PROCESSING TIME en minutes
      const bank     = cells[3] || '';                // NOM DE LA BANQUE
      const sender   = bankToSender(bank);            // expéditeur YapsonPress cible

      rows.push({
        ri,
        phone:    normPhone(phoneMatch[1]),
        amount:   parseAmount(cells[2]),
        dateTs,
        procTime,
        bank,
        sender,   // null = chercher dans tous les expéditeurs
        handle:   rh,
      });
    } catch(e) { /* ignorer lignes illisibles */ }
  }

  if (rows.length === 0) { log('ALT — Aucune demande en attente. Fin.'); return; }

  // Trier par date de création ASC (plus ancienne en premier)
  rows.sort((a, b) => a.dateTs - b.dateTs);
  log(`ALT — ${rows.length} demande(s) en attente, traitées de la plus ancienne à la plus récente`);
  log(`ALT — Config : traiter >= ${confMin} min | rejeter >= ${rejMin} min`);

  // ── 3. Traiter chaque ligne ───────────────────────────────────
  log('ALT [2/4] Recherche YapsonPress et confirmation…');
  let confirmedCount = 0;
  let rejectedCount  = 0;
  let approvedCount  = 0;
  let skippedCount   = 0;

  for (const row of rows) {
    const ageMin = (now - row.dateTs) / 60000;
    // On utilise PROCESSING TIME de my-managment comme âge de référence
    // (plus fiable car calculé par le serveur)
    const age = row.procTime > 0 ? row.procTime : Math.round(ageMin);

    // ── Ignorer les commandes trop récentes (< confMin) ────────
    if (age < confMin) {
      log(`ALT ⏸ ${row.phone} — âge ${age} min < ${confMin} min → ignoré`);
      skippedCount++;
      continue;
    }

    // ── Chercher le paiement dans YapsonPress ──────────────────
    // Heure de référence : arrondie à la minute basse (YapsonPress sans secondes)
    const fromTs = Math.floor(row.dateTs / 60000) * 60000;
    log(`ALT 🔍 ${row.phone} (${row.bank}) âge ${age} min → recherche dans ${row.sender || 'tous'}…`);

    let payments = [];
    try {
      payments = await yapsonSearch(row.sender, row.phone, fromTs);
    } catch(e) {
      log(`ALT ⚠ YapsonSearch erreur: ${e.message.substring(0, 60)}`);
    }

    if (payments.length > 0) {
      // Choisir le meilleur paiement (montant exact d'abord, sinon le plus récent)
      const exactMatch = payments.find(p => p.amount === row.amount);
      const best       = exactMatch || payments.sort((a, b) => b.ts - a.ts)[0];

      let montantFinal = best.amount;
      if (montantFinal > 200000) {
        log(`ALT ⚠ Montant ${fmtAmt(montantFinal)}F > 200 000 → plafonné`);
        montantFinal = 200000;
      }
      if (row.amount !== montantFinal) {
        log(`ALT ✏ ${row.phone}: my-managment=${fmtAmt(row.amount)}F → YapsonPress=${fmtAmt(montantFinal)}F`);
      }

      // ── Confirmer dans my-managment ───────────────────────────
      try {
        let confirmLink = null;
        for (const a of await row.handle.locator('a').all()) {
          if ((await a.textContent()).trim() === 'Confirmer') { confirmLink = a; break; }
        }
        if (!confirmLink) { log(`ALT ⚠ Lien Confirmer introuvable pour ${row.phone}`); continue; }

        await confirmLink.click();
        await page.waitForTimeout(800);

        const modalBtn = await waitModalConfirmBtn(15000);
        if (!modalBtn) { log(`ALT ⚠ Modale CONFIRMER non trouvée pour ${row.phone}`); continue; }

        // Corriger le montant si nécessaire
        if (row.amount !== montantFinal) {
          await fixModalAmount(montantFinal);
          await page.waitForTimeout(300);
        }

        await modalBtn.click();
        await waitModalClose(15000);
        await page.waitForTimeout(1000);

        confirmedCount++;
        // Approuver dans YapsonPress APRÈS confirmation réussie
        if (!best.approved && best.msgId) {
          const ok = await yapsonApprove(best.msgId);
          if (ok) approvedCount++;
        }
        log(`ALT ✅ Confirmé : ${row.phone} → ${fmtAmt(montantFinal)}F (${best.sender})`);

      } catch(e) { log(`ALT ⚠ Confirmation ${row.phone}: ${e.message.substring(0, 80)}`); }

    } else {
      // ── Paiement introuvable ───────────────────────────────────
      if (age >= rejMin) {
        // Introuvable ET âge >= seuil rejet → rejeter
        log(`ALT ❌ Rejet: ${row.phone} introuvable dans YapsonPress, âge ${age} min >= ${rejMin} min`);
        try {
          let rejectLink = null;
          for (const a of await row.handle.locator('a').all()) {
            if ((await a.textContent()).trim() === 'Rejeter') { rejectLink = a; break; }
          }
          if (!rejectLink) { log(`ALT ⚠ Lien Rejeter introuvable pour ${row.phone}`); continue; }
          await rejectLink.click();

          // Attendre le bouton OK dans la modale de rejet
          let okBtn = null;
          for (let i = 0; i < 40; i++) {
            for (const b of await page.$$('button, a.btn, .btn')) {
              try {
                if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { okBtn = b; break; }
              } catch { /* ignore */ }
            }
            if (okBtn) break;
            await page.waitForTimeout(200);
          }
          if (!okBtn) { log(`ALT ⚠ Bouton OK rejet non trouvé pour ${row.phone}`); continue; }
          await page.waitForTimeout(300);
          // Remplir le commentaire
          const ci = await page.$('input[placeholder="Commentaire"], textarea[placeholder="Commentaire"]');
          if (ci) { await ci.fill('Expiré'); await page.waitForTimeout(200); }
          for (const b of await page.$$('button, a.btn, .btn')) {
            try {
              if ((await b.textContent()).trim() === 'OK' && await b.isVisible()) { await b.click(); break; }
            } catch { /* ignore */ }
          }
          await page.waitForTimeout(2000);
          rejectedCount++;
          log(`ALT ❌ Rejeté : ${row.phone} (âge ${age} min)`);

        } catch(e) { log(`ALT ⚠ Rejet ${row.phone}: ${e.message.substring(0, 80)}`); }

      } else {
        // Introuvable mais pas encore expiré → en attente
        log(`ALT ⏳ En attente: ${row.phone} introuvable — âge ${age} min < ${rejMin} min`);
      }
    }
  }

  // ── 4. Résultat du cycle ──────────────────────────────────────
  log(`ALT [4/4] ✅ Résultat : ${confirmedCount} confirmé(s) | ${rejectedCount} rejeté(s) | ${approvedCount} approuvé(s) YapsonPress | ${skippedCount} ignoré(s)`);
  state.confirmed += confirmedCount;
  state.rejected  += rejectedCount;
  state.approved  += approvedCount;
}

// ── Boucle principale ─────────────────────────────────────────
let paused = false;
async function mainLoop() {
  while (true) {
    if (paused) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    try {
      state.polls++;
      state.lastRun = new Date().toISOString();
      state.status  = 'running';
      await runAlt();
    } catch(e) {
      state.errors++;
      log(`❌ Erreur cycle: ${e.message}`);
      if (!paused) state.status = 'error';
      if (e.message.includes('ookies')) {
        log('🍪 En attente de nouveaux cookies…');
        state.status = 'waiting_cookies';
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

// ── Dashboard HTML ────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ALT-BOT Dashboard</title>
<meta http-equiv="refresh" content="10">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:monospace;padding:20px}
h1{color:#cba6f7;font-size:1.3rem;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.card{background:#1e1e2e;border-radius:10px;padding:14px;text-align:center}
.card .val{font-size:1.6rem;font-weight:bold;color:#a6e3a1}
.card .lbl{font-size:11px;color:#6c7086;margin-top:4px}
.status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:bold;margin-bottom:16px}
.status.running{background:#a6e3a1;color:#1e1e2e}
.status.error{background:#f38ba8;color:#1e1e2e}
.status.starting{background:#89b4fa;color:#1e1e2e}
.status.paused{background:#fab387;color:#1e1e2e}
.status.waiting_cookies{background:#f38ba8;color:#1e1e2e;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.logs{background:#0a0e18;border-radius:10px;padding:14px;max-height:360px;overflow-y:auto}
.logs div{font-size:11.5px;color:#94a3b8;line-height:1.8;border-bottom:1px solid #1e1e2e;padding:2px 0}
.section{background:#1e1e2e;border-radius:10px;padding:16px;margin-bottom:16px}
.section-title{font-size:12px;font-weight:bold;color:#cba6f7;margin-bottom:10px}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
input,textarea{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:8px 12px;font-size:13px}
select{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-size:13px}
.btn{border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:bold;cursor:pointer}
.btn-stop{background:#f38ba8;color:#1e1e2e}
.btn-start{background:#a6e3a1;color:#1e1e2e}
.btn-neutral{background:#89b4fa;color:#1e1e2e}
.btn-purple{background:#cba6f7;color:#1e1e2e}
.hint{font-size:10px;color:#6c7086;margin-top:6px}
</style>
</head>
<body>
<h1>🤖 ALT-BOT Dashboard</h1>
<div style="margin-bottom:12px">
  <span class="status {{STATUS_CLASS}}">{{STATUS_LABEL}}</span>
  <span style="font-size:11px;color:#6c7086;margin-left:10px">Polls: {{POLLS}} | Dernière exécution: {{LAST_RUN}}</span>
</div>

<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
  <form method="POST" action="/stop"  style="display:inline"><button class="btn btn-stop">⏸ Arrêter</button></form>
  <form method="POST" action="/start" style="display:inline"><button class="btn btn-start">▶ Reprendre</button></form>
  <form method="POST" action="/reset-cookies" style="display:inline"><button class="btn btn-neutral">🍪 Réinitialiser cookies</button></form>
  <span style="font-size:12px;color:{{COOKIE_COLOR}};align-self:center">Cookies: {{COOKIE_STATUS}}</span>
</div>

<div class="grid">
  <div class="card"><div class="val">{{CONFIRMED}}</div><div class="lbl">✅ Confirmés</div></div>
  <div class="card"><div class="val" style="color:#89b4fa">{{APPROVED}}</div><div class="lbl">🟢 Approuvés (YapsonPress)</div></div>
  <div class="card"><div class="val" style="color:#f38ba8">{{REJECTED}}</div><div class="lbl">❌ Rejetés</div></div>
  <div class="card"><div class="val" style="color:#f9e2af">{{ERRORS}}</div><div class="lbl">⚠ Erreurs</div></div>
</div>

<!-- Token YapsonPress -->
<div class="section">
  <div class="section-title">🔑 Token YapsonPress</div>
  <form method="POST" action="/token" class="row">
    <input type="password" name="token" value="{{TOKEN_MASKED}}" style="width:320px" placeholder="Token YapsonPress (sans Bearer)">
    <button class="btn btn-purple">💾 Enregistrer</button>
    <span class="{{TOKEN_OK_CLASS}}">{{TOKEN_OK_LABEL}}</span>
  </form>
  <div class="hint">^ Colle le token complet (sans "Bearer"). Actuel : {{TOKEN_PREVIEW}}</div>
</div>

<!-- Config ALT-BOT -->
<div class="section">
  <div class="section-title">⚙ Config ALT-BOT</div>
  <form method="POST" action="/alt-config" class="row">
    <label style="font-size:12px">Traiter les commandes de plus de :</label>
    <select name="confMin">
      <option value="2"  {{CONF2}}>2 min</option>
      <option value="10" {{CONF10}}>10 min</option>
      <option value="30" {{CONF30}}>30 min</option>
    </select>
    <label style="font-size:12px">Rejeter les commandes de plus de :</label>
    <select name="rejMin">
      <option value="45" {{REJ45}}>45 min</option>
      <option value="50" {{REJ50}}>50 min</option>
      <option value="60" {{REJ60}}>60 min</option>
    </select>
    <button class="btn btn-purple">Appliquer</button>
    <span style="font-size:11px;color:#6c7086">Actuel : traiter>={{CONF_MIN}}min | rejeter>={{REJ_MIN}}min</span>
  </form>
</div>

<!-- Cookies -->
<div class="section">
  <div class="section-title">🍪 Cookies my-managment</div>
  <form method="POST" action="/cookies">
    <textarea name="cookies" rows="3" style="width:100%;margin-bottom:8px" placeholder='[{"name":"...","value":"..."}]'></textarea>
    <button class="btn btn-neutral">💉 Injecter les cookies</button>
  </form>
</div>

<!-- Logs -->
<div class="logs">
{{LOGS}}
</div>
</body>
</html>`;

function renderDashboard() {
  const statusMap = { running:'running', error:'error', starting:'starting', paused:'paused', waiting_cookies:'waiting_cookies' };
  const labelMap  = { running:'● Actif', error:'✕ Erreur', starting:'○ Démarrage', paused:'⏸ Pausé', waiting_cookies:'⚠ Cookies requis' };
  const sc        = statusMap[state.status] || 'starting';
  const lastRun   = state.lastRun ? new Date(state.lastRun).toLocaleTimeString('fr-FR') : '—';
  const tokenPreview = state.yapsonToken
    ? state.yapsonToken.substring(0, 8) + '•'.repeat(14) + state.yapsonToken.slice(-4)
    : '(non défini)';
  const tokenOk  = !!state.yapsonToken;
  const logs     = state.logs.slice(0, 80).map(l => `<div>${l}</div>`).join('');

  return DASHBOARD_HTML
    .replace('{{STATUS_CLASS}}',  sc)
    .replace('{{STATUS_LABEL}}',  labelMap[state.status] || '—')
    .replace('{{POLLS}}',         state.polls)
    .replace('{{LAST_RUN}}',      lastRun)
    .replace('{{CONFIRMED}}',     state.confirmed)
    .replace('{{APPROVED}}',      state.approved)
    .replace('{{REJECTED}}',      state.rejected)
    .replace('{{ERRORS}}',        state.errors)
    .replace('{{TOKEN_MASKED}}',  '')
    .replace('{{TOKEN_OK_CLASS}}', tokenOk ? 'hint' : 'hint')
    .replace('{{TOKEN_OK_LABEL}}', tokenOk ? '✅ Token actif' : '⚠ Token manquant')
    .replace('{{TOKEN_PREVIEW}}', tokenPreview)
    .replace('{{COOKIE_COLOR}}',  state.cookiesReady ? '#a6e3a1' : '#f38ba8')
    .replace('{{COOKIE_STATUS}}', state.cookiesReady ? '✅ Actifs' : '⚠ Requis')
    .replace('{{CONF_MIN}}',      altConfig.confMin)
    .replace('{{REJ_MIN}}',       altConfig.rejMin)
    .replace('{{CONF2}}',         altConfig.confMin === 2  ? 'selected' : '')
    .replace('{{CONF10}}',        altConfig.confMin === 10 ? 'selected' : '')
    .replace('{{CONF30}}',        altConfig.confMin === 30 ? 'selected' : '')
    .replace('{{REJ45}}',         altConfig.rejMin === 45  ? 'selected' : '')
    .replace('{{REJ50}}',         altConfig.rejMin === 50  ? 'selected' : '')
    .replace('{{REJ60}}',         altConfig.rejMin === 60  ? 'selected' : '')
    .replace('{{LOGS}}',          logs);
}

// ── Routes Express ────────────────────────────────────────────
app.get('/', (req, res) => res.send(renderDashboard()));

app.post('/stop', (req, res) => {
  paused = true;
  state.status = 'paused';
  log('⏸ Bot mis en pause');
  res.redirect('/');
});

app.post('/start', (req, res) => {
  paused = false;
  state.status = 'running';
  log('▶ Bot repris');
  res.redirect('/');
});

app.post('/token', (req, res) => {
  const t = (req.body.token || '').trim();
  if (t) {
    state.yapsonToken = t;
    log('🔑 Token YapsonPress mis à jour');
  }
  res.redirect('/');
});

app.post('/reset-cookies', (req, res) => {
  state.cookies      = null;
  state.cookiesReady = false;
  state.status       = 'waiting_cookies';
  log('🍪 Cookies réinitialisés');
  res.redirect('/');
});

app.post('/cookies', (req, res) => {
  const raw = (req.body.cookies || '').trim();
  if (!raw) { res.redirect('/'); return; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Doit être un tableau JSON');
    state.cookies      = raw;
    state.cookiesReady = false;
    log(`🍪 ${parsed.length} cookie(s) reçu(s) — injection en cours…`);
    mgmtLogin().catch(e => log(`❌ Injection cookies: ${e.message}`));
  } catch(e) {
    log(`❌ JSON cookies invalide: ${e.message}`);
  }
  res.redirect('/');
});

app.post('/alt-config', (req, res) => {
  const newConf = parseInt(req.body.confMin || '10', 10);
  const newRej  = parseInt(req.body.rejMin  || '50', 10);
  if (CONF_MIN_ALLOWED.includes(newConf)) {
    altConfig.confMin = newConf;
    log(`⚙ ALT confMin mis à jour : ${newConf} min`);
  }
  if (REJ_MIN_ALLOWED.includes(newRej)) {
    altConfig.rejMin = newRej;
    log(`⚙ ALT rejMin mis à jour : ${newRej} min`);
  }
  res.redirect('/');
});

app.get('/status', (req, res) => res.json(state));

app.listen(PORT, () => {
  log(`🌐 ALT-BOT Dashboard sur le port ${PORT}`);
  mainLoop().catch(e => { console.error('Fatal:', e); process.exit(1); });
});
