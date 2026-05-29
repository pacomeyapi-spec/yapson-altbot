'use strict';

// ============================================================
// ALT-BOT — Multi-utilisateurs + Firebase Firestore
// + Navigateur intégré pour login manuel (iPad compatible)
// ============================================================

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Firebase Init ─────────────────────────────────────────────
let db;
try {
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
initializeApp({ credential: cert(serviceAccount) });
db = getFirestore();
console.log('✅ Firebase Firestore connecté');
} catch(e) {
console.error('❌ Firebase init failed:', e.message);
process.exit(1);
}

// ── Variables d'environnement ─────────────────────────────────
const YAPSON_URL = (process.env.YAPSON_URL || 'https://sms-mirror-production.up.railway.app').replace(/\/$/, '');
const MGMT_URL = (process.env.MGMT_URL || 'https://my-managment.com').replace(/\/$/, '');
const INTERVAL_SEC = parseInt(process.env.INTERVAL_SEC || '30', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);
let ADMIN_USER = process.env.ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const CONF_MIN_ALLOWED = [2, 10, 30];
const REJ_MIN_ALLOWED = [45, 50, 60];

// ── Persistance Firebase ──────────────────────────────────────
async function saveUser(u) {
try {
await db.collection('altbot_users').doc(u.id).set({
id: u.id, username: u.username, passwordHash: u.passwordHash,
yapsonToken: u.yapsonToken || '', cookies: u.cookies || '',
confMin: u.confMin, rejMin: u.rejMin, paused: u.paused,
updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });
} catch(e) { console.error(`[Firebase] saveUser error: ${e.message}`); }
}

async function deleteUserFromDB(userId) {
try { await db.collection('altbot_users').doc(userId).delete(); }
catch(e) { console.error(`[Firebase] deleteUser error: ${e.message}`); }
}

async function loadUsersFromDB() {
try {
const snap = await db.collection('altbot_users').get();
let count = 0;
for (const doc of snap.docs) {
const data = doc.data();
const u = buildUserObject(data.id, data.username, null, data.passwordHash);
u.yapsonToken = data.yapsonToken || '';
u.cookies = data.cookies || '';
u.confMin = data.confMin || 10;
u.rejMin = data.rejMin || 50;
u.paused = data.paused || false;
u.cookiesReady = false;
users[u.id] = u;
safeUserLoop(u);
count++;
}
console.log(`✅ ${count} utilisateur(s) chargé(s) depuis Firebase`);
} catch(e) { console.error(`[Firebase] loadUsers error: ${e.message}`); }
}

async function saveAdminPass(newPass) {
try { await db.collection('altbot_config').doc('admin').set({ password: newPass }, { merge: true }); }
catch(e) { console.error(`[Firebase] saveAdminPass error: ${e.message}`); }
}

async function loadAdminPass() {
try {
const doc = await db.collection('altbot_config').doc('admin').get();
if (doc.exists && doc.data().password) {
ADMIN_PASS = doc.data().password;
console.log('✅ Mot de passe admin chargé depuis Firebase');
}
} catch(e) { console.error(`[Firebase] loadAdminPass error: ${e.message}`); }
}

// ── Sessions ──────────────────────────────────────────────────
const sessions = {};
function createSession(userId, isAdmin) {
const token = crypto.randomBytes(32).toString('hex');
sessions[token] = { userId, isAdmin, expires: Date.now() + 10 * 365 * 24 * 3600 * 1000 };
return token;
}
function getSession(req) {
const m = (req.headers.cookie || '').match(/session=([a-f0-9]{64})/);
if (!m) return null;
const s = sessions[m[1]];
if (!s || s.expires < Date.now()) return null;
return s;
}
function requireLogin(req, res, next) {
const s = getSession(req); if (!s) return res.redirect('/login');
req.session = s; next();
}
function requireAdmin(req, res, next) {
const s = getSession(req); if (!s || !s.isAdmin) return res.redirect('/login');
req.session = s; next();
}

// ── Stockage utilisateurs ─────────────────────────────────────
const users = {};
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

function buildUserObject(id, username, password, existingHash) {
return {
id, username,
passwordHash: existingHash || hashPass(password),
yapsonToken: '', cookies: null, cookiesReady: false,
confMin: 10, rejMin: 50, paused: false,
browser: null, page: null,
// Navigateur intégré (login manuel)
loginBrowser: null, loginPage: null, loginScreenshot: null,
loginWsClients: new Set(),
state: { status: 'waiting_cookies', polls: 0, confirmed: 0, rejected: 0, approved: 0, errors: 0, logs: [], lastRun: null },
};
}

async function createUser(username, password) {
const id = crypto.randomBytes(8).toString('hex');
const u = buildUserObject(id, username, password);
users[id] = u;
await saveUser(u);
return u;
}

function ulog(u, msg) {
const entry = `[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`;
console.log(`[${u.username}] ${entry}`);
u.state.logs.unshift(entry);
if (u.state.logs.length > 200) u.state.logs.pop();
}

// ── Utilitaires ───────────────────────────────────────────────
function normPhone(s) {
if (!s) return '';
const d = String(s).replace(/[^\d]/g, '');
if (d.length === 13 && d.startsWith('2250')) return d.slice(3);
if (d.length === 12 && d.startsWith('225')) return '0' + d.slice(3);
return d;
}
function parseAmount(s) {
if (!s) return 0;
const n = String(s).trim().match(/^[\d\s\u00a0.,]+/)?.[0] || String(s);
return parseInt(n.replace(/[\s\u00a0]/g,'').replace(/[.,]\d{1,2}$/,'').replace(/[^\d]/g,''),10) || 0;
}
function fmtAmt(n) { return (n||0).toLocaleString('fr-FR'); }
function parseMgmtDate(str) {
if (!str) return null;
let m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`);
m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${m[4].padStart(2,'0')}:${m[5]}:00Z`);
return null;
}
function parseProcessingTime(str) {
if (!str) return 0;
const s = str.toLowerCase();
if (s.includes('less than') || s.includes('moins')) return 0;
let t = 0;
const h = s.match(/(\d+)\s*heure/); const m = s.match(/(\d+)\s*minute/);
if (h) t += parseInt(h[1]) * 60; if (m) t += parseInt(m[1]);
if (!h && !m) { const n = s.match(/(\d+)/); if (n) t = parseInt(n[1]); }
return t;
}
function bankToSender(b) {
const s = (b||'').toLowerCase();
if (s.includes('wave')) return 'Wave Business';
if (s.includes('orange')) return '+454';
if (s.includes('mtn') || s.includes('mobile')) return 'MobileMoney';
if (s.includes('moov')) return 'MoovMoney';
return null;
}
function getMsgSender(msg) { return msg.sender || msg.app_name || msg.sender_name || msg.device_name || ''; }
function normTs(raw) {
if (!raw) return null;
let ts = typeof raw === 'string' ? (()=>{ const d=new Date(raw); return !isNaN(d.getTime())&&d.getTime()>1e12?d.getTime():parseFloat(raw); })() : Number(raw);
if (isNaN(ts) || ts <= 0) return null;
return ts < 1e11 ? ts * 1000 : ts;
}
function parseMsg(sender, content) {
if (sender === 'Wave Business') {
const m = content.match(/\((0\d{9})\)\s+a\s+pay[eé]\s+([\d\s\u00a0.,]+)\s*F/i);
if (m) return { phone: m[1], amount: parseAmount(m[2]) };
}
if (sender === '+454' || sender.includes('MobileMoney') || sender.includes('Orange')) {
const m1 = content.match(/recu\s+([\d\s.,]+)\s*FCFA\s+du\s+\+?225\s*(0\d{9})/i); if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
const m2 = content.match(/transfert de ([\d\s.,]+)\s*FCFA\s+du\s+(0\d{9})/i); if (m2) return { phone: normPhone(m2[2]), amount: parseAmount(m2[1]) };
const m3 = content.match(/([\d\s.,]+)\s*FCFA.*?(0\d{9})/i); if (m3) return { phone: normPhone(m3[2]), amount: parseAmount(m3[1]) };
const m4 = content.match(/(0\d{9}).*?([\d\s.,]+)\s*FCFA/i); if (m4) return { phone: normPhone(m4[1]), amount: parseAmount(m4[2]) };
}
if (sender.includes('MoovMoney')) {
const m1 = content.match(/de\s+([\d\s.,]+)\s*FCFA\s+du\s+(0\d{9})/i); if (m1) return { phone: normPhone(m1[2]), amount: parseAmount(m1[1]) };
const m2 = content.match(/(0\d{9}).*?([\d\s.,]+)\s*FCFA/i); if (m2) return { phone: normPhone(m2[1]), amount: parseAmount(m2[2]) };
}
const g = content.match(/(0\d{9}).*?(\d[\d\s\u00a0]{2,})/);
if (g) return { phone: g[1], amount: parseAmount(g[2]) };
return null;
}

// ── YapsonPress ───────────────────────────────────────────────
async function yapsonSearch(u, senderFilter, phone, fromTs) {
if (!u.yapsonToken) throw new Error('Token YapsonPress manquant');
const res = await fetch(`${YAPSON_URL}/api/messages`, { headers: { 'Authorization': `Bearer ${u.yapsonToken}` } });
if (!res.ok) throw new Error(`YapsonPress ${res.status}`);
const data = await res.json();
const messages = Array.isArray(data) ? data : (data.messages || data.data || Object.values(data));
const results = [];
for (const msg of messages) {
const sender = getMsgSender(msg);
if (senderFilter && !sender.includes(senderFilter)) continue;
const parsed = parseMsg(sender, msg.content || msg.body || '');
if (!parsed) continue;
if (normPhone(String(parsed.phone)) !== phone) continue;
const ts = normTs(msg.timestamp) || normTs(msg.received_at) || normTs(msg.createdAt);
if (ts && ts < fromTs) continue;
results.push({ phone: parsed.phone, amount: parsed.amount, msgId: msg.id || msg._id,
approved: msg.status === 'approuve' || msg.status === 'approved', sender, ts: ts || Date.now() });
}
return results;
}
async function yapsonApprove(u, msgId) {
try {
const res = await fetch(`${YAPSON_URL}/api/messages/${msgId}/status`, {
method: 'PATCH', headers: { 'Authorization': `Bearer ${u.yapsonToken}`, 'Content-Type': 'application/json' },
body: JSON.stringify({ status: 'approuve' }),
});
return res.ok;
} catch { return false; }
}

// ── Playwright ────────────────────────────────────────────────
async function installPlaywright() {
try { require('child_process').execSync('npx playwright install chromium --with-deps', { stdio: 'inherit', timeout: 120000 }); } catch {}
}
async function ensureBrowser(u) {
if (!u.browser || !u.browser.isConnected()) {
ulog(u, '🚀 Lancement Chromium…');
try { u.browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }); }
catch(e) {
if (e.message.includes('Executable') || e.message.includes("doesn't exist")) {
ulog(u, '🔧 Installation Chromium…'); await installPlaywright();
u.browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
} else throw e;
}
}
if (!u.page || u.page.isClosed()) {
u.page = await u.browser.newPage();
await u.page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
}
}
async function mgmtLogin(u) {
if (!u.cookies) {
ulog(u, '🍪 Cookies requis…'); u.state.status = 'waiting_cookies';
for (let i = 0; i < 1800; i++) { if (u.cookies) break; await new Promise(r=>setTimeout(r,1000)); }
if (!u.cookies) throw new Error('Cookies timeout');
}
ulog(u, '🍪 Injection cookies…');
await ensureBrowser(u);
const list = JSON.parse(u.cookies);
await u.page.goto(MGMT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
const ctx = u.page.context(); await ctx.clearCookies();
await ctx.addCookies(list.map(c => ({
name: c.name, value: c.value, domain: c.domain||'.my-managment.com', path: c.path||'/',
httpOnly: c.httpOnly||false, secure: c.secure||false,
sameSite: ['Strict','Lax','None'].includes(c.sameSite)?c.sameSite:'Lax',
})));
await u.page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
if (u.page.url().includes('login') || u.page.url().includes('signin')) {
u.cookiesReady = false; u.state.status = 'waiting_cookies';
throw new Error('Cookies refusés — page de login détectée (cookies conservés)');
}
ulog(u, '✅ Connecté'); u.cookiesReady = true; u.state.status = 'running';
}
async function ensureLoggedIn(u) {
await ensureBrowser(u);
if (!u.cookiesReady || !u.cookies) { await mgmtLogin(u); return; }
try { const url = u.page.url(); if (!url || url.includes('login') || url === 'about:blank') await mgmtLogin(u); }
catch { await mgmtLogin(u); }
}
async function setVueInput(u, loc, val) {
await loc.evaluate((el, v) => {
el.focus(); el.select && el.select();
const p = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
const ns = Object.getOwnPropertyDescriptor(p,'value')?.set;
if (ns) { ns.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); ns.call(el,v); }
else el.value = v;
['input','change'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
}, String(val));
await u.page.waitForTimeout(200);
}
async function waitModalBtn(u, ms=15000) {
const t = Date.now();
while (Date.now()-t < ms) {
await u.page.evaluate(()=>document.querySelectorAll('.container-preloader').forEach(p=>p.style.display='none')).catch(()=>{});
for (const b of await u.page.$$('button')) {
try { const tx=(await b.textContent()).trim().toUpperCase(); const bx=await b.boundingBox(); if(tx==='CONFIRMER'&&bx&&bx.width>80) return b; } catch {}
}
for (const b of await u.page.$$('button.btn-success')) {
try { const tx=(await b.textContent()).trim(); const bx=await b.boundingBox(); if(tx==='Confirmer'&&bx&&bx.width>50) return b; } catch {}
}
await u.page.waitForTimeout(300);
}
return null;
}
async function waitModalClose(u, ms=15000) {
const t = Date.now();
while (Date.now()-t < ms) {
await u.page.evaluate(()=>document.querySelectorAll('.container-preloader').forEach(p=>p.style.display='none')).catch(()=>{});
let found = false;
for (const b of await u.page.$$('button')) { try { if((await b.textContent()).trim().toUpperCase()==='CONFIRMER'){found=true;break;} } catch {} }
if (!found) return true;
await u.page.waitForTimeout(300);
}
return false;
}
async function fixModal(u, montant) {
await u.page.waitForTimeout(500);
const loc = u.page.locator('input[placeholder="Montant"],input[placeholder="montant"],[role="dialog"] input[type="number"],.modal input[type="number"]').first();
if (await loc.count() > 0) { await setVueInput(u, loc, String(montant)); ulog(u, `✏ Montant → ${fmtAmt(montant)}F`); }
const comm = u.page.locator('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]').first();
if (await comm.count() > 0) await setVueInput(u, comm, String(montant));
}

// ── NAVIGATEUR INTÉGRÉ (Login manuel via screenshot) ──────────
// Permet de se connecter à my-managment.com depuis iPad
// sans avoir besoin d'extraire les cookies manuellement

async function ensureLoginBrowser(u) {
if (!u.loginBrowser || !u.loginBrowser.isConnected()) {
ulog(u, '🌐 Lancement navigateur login…');
try {
u.loginBrowser = await chromium.launch({
headless: true,
args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844']
});
} catch(e) {
if (e.message.includes('Executable') || e.message.includes("doesn't exist")) {
await installPlaywright();
u.loginBrowser = await chromium.launch({
headless: true,
args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844']
});
} else throw e;
}
}
if (!u.loginPage || u.loginPage.isClosed()) {
u.loginPage = await u.loginBrowser.newPage();
await u.loginPage.setViewportSize({ width: 390, height: 844 });
await u.loginPage.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
}
}

async function captureLoginScreenshot(u) {
try {
if (!u.loginPage || u.loginPage.isClosed()) return null;
const buf = await u.loginPage.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
u.loginScreenshot = buf.toString('base64');
// Diffuser à tous les clients WebSocket connectés
for (const ws of u.loginWsClients) {
try { ws.send(JSON.stringify({ type: 'screenshot', data: u.loginScreenshot })); } catch {}
}
return u.loginScreenshot;
} catch { return null; }
}

// Boucle de capture screenshot en continu
async function startScreenshotLoop(u) {
while (u.loginBrowser && u.loginBrowser.isConnected() && u.loginPage && !u.loginPage.isClosed()) {
await captureLoginScreenshot(u);
await new Promise(r => setTimeout(r, 500)); // 2 fps
}
}

// Route : ouvrir le navigateur intégré
app.post('/user/browser/open', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.redirect('/login');
try {
await ensureLoginBrowser(u);
await u.loginPage.goto(MGMT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
ulog(u, '🌐 Navigateur login ouvert');
startScreenshotLoop(u).catch(() => {});
res.redirect('/user/browser');
} catch(e) {
ulog(u, `❌ Navigateur login: ${e.message}`);
res.redirect('/dashboard');
}
});

// Route : fermer le navigateur intégré
app.post('/user/browser/close', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.redirect('/login');
try {
if (u.loginBrowser) { await u.loginBrowser.close(); u.loginBrowser = null; u.loginPage = null; }
ulog(u, '🌐 Navigateur login fermé');
} catch {}
res.redirect('/dashboard');
});

// Route : cliquer dans le navigateur intégré
app.post('/user/browser/click', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(400).json({ error: 'user not found' });
const { x, y } = req.body;
try {
if (u.loginPage && !u.loginPage.isClosed()) {
await u.loginPage.mouse.click(parseFloat(x), parseFloat(y));
await new Promise(r => setTimeout(r, 300));
await captureLoginScreenshot(u);
}
res.json({ ok: true });
} catch(e) { res.json({ error: e.message }); }
});

// Route : taper du texte dans le navigateur intégré
app.post('/user/browser/type', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(400).json({ error: 'user not found' });
const { text } = req.body;
try {
if (u.loginPage && !u.loginPage.isClosed()) {
await u.loginPage.keyboard.type(text, { delay: 50 });
await new Promise(r => setTimeout(r, 200));
await captureLoginScreenshot(u);
}
res.json({ ok: true });
} catch(e) { res.json({ error: e.message }); }
});

// Route : naviguer vers une URL dans le navigateur intégré
app.post('/user/browser/goto', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(400).json({ error: 'user not found' });
const { url } = req.body;
try {
if (u.loginPage && !u.loginPage.isClosed()) {
await u.loginPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 500));
await captureLoginScreenshot(u);
}
res.json({ ok: true });
} catch(e) { res.json({ error: e.message }); }
});

// Route : appuyer sur une touche spéciale (Enter, Backspace…)
app.post('/user/browser/key', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(400).json({ error: 'user not found' });
const { key } = req.body;
try {
if (u.loginPage && !u.loginPage.isClosed()) {
await u.loginPage.keyboard.press(key);
await new Promise(r => setTimeout(r, 300));
await captureLoginScreenshot(u);
}
res.json({ ok: true });
} catch(e) { res.json({ error: e.message }); }
});

// Route : extraire les cookies et les injecter dans le bot
app.post('/user/browser/capture-cookies', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(400).json({ error: 'user not found' });
try {
if (!u.loginPage || u.loginPage.isClosed()) return res.json({ error: 'Navigateur fermé' });
const currentUrl = u.loginPage.url();
if (currentUrl.includes('login') || currentUrl.includes('signin')) {
return res.json({ error: 'Pas encore connecté — complète le login puis clique Capturer' });
}
const ctx = u.loginPage.context();
const cookies = await ctx.cookies();
const mgmtCookies = cookies.filter(c => c.domain.includes('my-managment') || c.domain.includes('managment'));
if (mgmtCookies.length === 0) return res.json({ error: 'Aucun cookie my-managment trouvé' });
const cookieStr = JSON.stringify(mgmtCookies);
u.cookies = cookieStr;
u.cookiesReady = false;
ulog(u, `🍪 ${mgmtCookies.length} cookie(s) capturés depuis navigateur intégré`);
await saveUser(u);
mgmtLogin(u).catch(e => ulog(u, `❌ ${e.message}`));
res.json({ ok: true, count: mgmtCookies.length });
} catch(e) { res.json({ error: e.message }); }
});

// Route : screenshot en temps réel (polling)
app.get('/user/browser/screenshot', requireLogin, async (req, res) => {
const u = users[req.session.userId]; if (!u) return res.status(404).end();
try {
await captureLoginScreenshot(u);
if (!u.loginScreenshot) return res.status(204).end();
res.setHeader('Content-Type', 'image/jpeg');
res.send(Buffer.from(u.loginScreenshot, 'base64'));
} catch { res.status(500).end(); }
});

// Page du navigateur intégré (interface iPad-friendly)
app.get('/user/browser', requireLogin, (req, res) => {
const u = users[req.session.userId]; if (!u) return res.redirect('/login');
const hasNav = u.loginBrowser && u.loginBrowser.isConnected() && u.loginPage && !u.loginPage.isClosed();
res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Navigateur — ${u.username}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:monospace;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#topbar{background:#1e1e2e;padding:8px;display:flex;gap:6px;align-items:center;flex-shrink:0}
#urlbar{flex:1;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:5px 8px;font-size:13px}
.tbtn{border:none;border-radius:6px;padding:5px 10px;font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap}
.tbtn-green{background:#a6e3a1;color:#1e1e2e}
.tbtn-blue{background:#89b4fa;color:#1e1e2e}
.tbtn-purple{background:#cba6f7;color:#1e1e2e}
.tbtn-red{background:#f38ba8;color:#1e1e2e}
.tbtn-orange{background:#fab387;color:#1e1e2e}
#screen-wrap{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000;cursor:crosshair}
#screen{max-width:100%;max-height:100%;display:block;touch-action:none}
#keyboard{background:#1e1e2e;padding:6px;flex-shrink:0}
#textinput{width:100%;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px;font-size:14px;margin-bottom:5px}
.keyrow{display:flex;gap:4px;margin-bottom:4px;justify-content:center}
.key{background:#313244;color:#cdd6f4;border:none;border-radius:5px;padding:7px 10px;font-size:13px;cursor:pointer;flex:1;min-width:28px;max-width:40px}
.key-wide{max-width:70px}
.key-wider{max-width:90px}
#status-bar{background:#0a0e18;padding:4px 8px;font-size:10px;color:#6c7086;flex-shrink:0}
#capture-btn{background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:bold;cursor:pointer;width:100%;margin-top:4px}
</style>
</head>
<body>

<div id="topbar">
  <a href="/dashboard" class="tbtn tbtn-red">← Retour</a>
  <input id="urlbar" type="text" placeholder="https://my-managment.com" value="${MGMT_URL}">
  <button class="tbtn tbtn-blue" onclick="gotoUrl()">Aller</button>
  ${hasNav ? '' : `<form method="POST" action="/user/browser/open" style="display:inline"><button class="tbtn tbtn-green" type="submit">▶ Ouvrir</button></form>`}
</div>

${hasNav ? `
<div id="screen-wrap">
  <img id="screen" src="/user/browser/screenshot?t=${Date.now()}" alt="Navigateur">
</div>

<div id="keyboard">
  <input id="textinput" type="text" placeholder="Tape ici puis appuie sur Envoyer…">
  <div class="keyrow">
    <button class="tbtn tbtn-blue key-wider" onclick="sendText()">Envoyer texte</button>
    <button class="tbtn tbtn-orange key-wider" onclick="sendKey('Enter')">Entrée ↵</button>
    <button class="tbtn tbtn-red key-wider" onclick="sendKey('Backspace')">⌫</button>
    <button class="tbtn tbtn-purple key-wider" onclick="sendKey('Tab')">Tab</button>
  </div>
  <button id="capture-btn" onclick="captureCookies()">🍪 Je suis connecté — Capturer les cookies</button>
</div>

<div id="status-bar" id="statusbar">Prêt — Clique sur l'écran pour interagir</div>

<script>
const screen = document.getElementById('screen');
const statusBar = document.getElementById('status-bar');
const textInput = document.getElementById('textinput');
const urlbar = document.getElementById('urlbar');

// Polling screenshot toutes les 500ms
let polling = true;
async function pollScreenshot() {
  while (polling) {
    try {
      const r = await fetch('/user/browser/screenshot?t=' + Date.now());
      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const old = screen.src;
        screen.src = url;
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}
pollScreenshot();

// Clic sur l'écran → clic dans le navigateur
screen.addEventListener('click', async (e) => {
  const rect = screen.getBoundingClientRect();
  const scaleX = 390 / rect.width;
  const scaleY = 844 / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  statusBar.textContent = 'Clic à (' + Math.round(x) + ', ' + Math.round(y) + ')…';
  await fetch('/user/browser/click', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'x=' + x + '&y=' + y
  });
  statusBar.textContent = 'Clic effectué';
});

// Touch sur mobile/iPad
screen.addEventListener('touchend', async (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  const rect = screen.getBoundingClientRect();
  const scaleX = 390 / rect.width;
  const scaleY = 844 / rect.height;
  const x = (touch.clientX - rect.left) * scaleX;
  const y = (touch.clientY - rect.top) * scaleY;
  statusBar.textContent = 'Tap à (' + Math.round(x) + ', ' + Math.round(y) + ')…';
  await fetch('/user/browser/click', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'x=' + x + '&y=' + y
  });
});

async function sendText() {
  const text = textInput.value;
  if (!text) return;
  statusBar.textContent = 'Envoi: ' + text;
  await fetch('/user/browser/type', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'text=' + encodeURIComponent(text)
  });
  textInput.value = '';
  statusBar.textContent = 'Texte envoyé';
}

async function sendKey(key) {
  await fetch('/user/browser/key', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'key=' + encodeURIComponent(key)
  });
  statusBar.textContent = 'Touche: ' + key;
}

async function gotoUrl() {
  const url = urlbar.value || '${MGMT_URL}';
  statusBar.textContent = 'Navigation vers ' + url + '…';
  await fetch('/user/browser/goto', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'url=' + encodeURIComponent(url)
  });
}

async function captureCookies() {
  statusBar.textContent = 'Capture des cookies…';
  document.getElementById('capture-btn').disabled = true;
  const r = await fetch('/user/browser/capture-cookies', { method: 'POST' });
  const data = await r.json();
  if (data.ok) {
    statusBar.textContent = '✅ ' + data.count + ' cookies capturés ! Bot connecté.';
    document.getElementById('capture-btn').textContent = '✅ Cookies capturés !';
    document.getElementById('capture-btn').style.background = '#a6e3a1';
    setTimeout(() => { window.location = '/dashboard'; }, 2000);
  } else {
    statusBar.textContent = '❌ ' + (data.error || 'Erreur');
    document.getElementById('capture-btn').disabled = false;
  }
}

textInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
</script>
` : `
<div style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:20px;text-align:center">
  <div style="font-size:48px">🌐</div>
  <div style="color:#cba6f7;font-size:16px">Navigateur intégré</div>
  <div style="color:#6c7086;font-size:12px;max-width:300px">Ouvre le navigateur, connecte-toi à my-managment.com manuellement, puis clique <strong>Capturer les cookies</strong>.</div>
  <form method="POST" action="/user/browser/open">
    <button type="submit" style="background:#a6e3a1;color:#1e1e2e;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:bold;cursor:pointer">▶ Ouvrir le navigateur</button>
  </form>
</div>
`}

</body>
</html>`);
});

// ── Cycle principal ───────────────────────────────────────────
async function runAlt(u) {
ulog(u, '▶ Cycle démarré…');
await ensureLoggedIn(u);
const now = Date.now();
ulog(u, 'ALT [1/3] Lecture my-managment…');
await u.page.goto(`${MGMT_URL}/fr/admin/report/pendingrequestrefill`, { waitUntil: 'networkidle', timeout: 30000 });
try {
const tog = await u.page.$('.toggle--is-checked,[class*="toggle"][class*="active"]');
if (tog) { await tog.dispatchEvent('click'); await u.page.waitForTimeout(500); }
const ms2 = await u.page.$('.input-group.select-box .multiselect');
if (ms2) {
const cur = await u.page.$eval('.multiselect__single', el=>el.textContent.trim()).catch(()=>'');
if (cur !== '500') {
const sb = await ms2.$('.multiselect__select'); if (sb) { await sb.click(); await u.page.waitForTimeout(400); }
for (const opt of await ms2.$$('.multiselect__element'))
if ((await opt.textContent()).trim()==='500') { await opt.$('span')?.click(); break; }
await u.page.waitForTimeout(300);
}
}
const ab = await u.page.$('button:has-text("Appliquer"),button:has-text("APPLIQUER")');
if (ab) { await ab.click(); await u.page.waitForTimeout(3000); }
} catch(e) { ulog(u, `⚠ Setup: ${e.message.substring(0,60)}`); }

const rowLocs = u.page.locator('table tbody tr');
const rCount = await rowLocs.count();
const rows = [];
for (let ri = 0; ri < rCount; ri++) {
try {
const rh = rowLocs.nth(ri);
const cells = await rh.locator('td').allInnerTexts();
if (cells.length < 5) continue;
const pm = (cells[1]||'').match(/(0\d{9})/); if (!pm) continue;
if (!(await rh.locator('a').allInnerTexts()).some(t=>t.trim()==='Confirmer')) continue;
rows.push({ ri, phone: normPhone(pm[1]), amount: parseAmount(cells[2]),
dateTs: parseMgmtDate(cells[0])?.getTime() ?? (now-3600000),
procTime: parseProcessingTime(cells[4]), bank: cells[3]||'', handle: rh });
} catch {}
}
if (rows.length === 0) { ulog(u, 'ALT — Aucune demande. Fin.'); return; }
rows.sort((a,b) => a.dateTs - b.dateTs);
ulog(u, `ALT — ${rows.length} demande(s) | traiter>=${u.confMin}min | rejeter>=${u.rejMin}min`);

let confirmed=0, rejected=0, approved=0, skipped=0;
for (const row of rows) {
const age = row.procTime > 0 ? row.procTime : Math.round((now-row.dateTs)/60000);
const sender = bankToSender(row.bank);
if (age < u.confMin) { ulog(u, `ALT ⏸ ${row.phone} — ${age}min < ${u.confMin}min`); skipped++; continue; }
const fromTs = Math.floor(row.dateTs/60000)*60000;
ulog(u, `ALT 🔍 ${row.phone} (${row.bank}) ${age}min → ${sender||'tous'}…`);
let payments = [];
try { payments = await yapsonSearch(u, sender, row.phone, fromTs); } catch(e) { ulog(u, `⚠ YP: ${e.message.substring(0,60)}`); }

if (payments.length > 0) {
const best = payments.find(p=>p.amount===row.amount) || payments.sort((a,b)=>b.ts-a.ts)[0];
let montant = best.amount > 200000 ? 200000 : best.amount;
if (row.amount !== montant) ulog(u, `ALT ✏ ${row.phone}: ${fmtAmt(row.amount)}F → ${fmtAmt(montant)}F`);
try {
let lnk = null;
for (const a of await row.handle.locator('a').all()) if ((await a.textContent()).trim()==='Confirmer') { lnk=a; break; }
if (!lnk) { ulog(u, `⚠ Lien Confirmer manquant`); continue; }
await lnk.click(); await u.page.waitForTimeout(800);
const btn = await waitModalBtn(u); if (!btn) { ulog(u, `⚠ Modale non trouvée`); continue; }
if (row.amount !== montant) { await fixModal(u, montant); await u.page.waitForTimeout(300); }
await btn.click(); await waitModalClose(u); await u.page.waitForTimeout(1000);
confirmed++;
if (!best.approved && best.msgId && await yapsonApprove(u, best.msgId)) approved++;
ulog(u, `ALT ✅ ${row.phone} → ${fmtAmt(montant)}F (${best.sender})`);
} catch(e) { ulog(u, `⚠ Confirmation ${row.phone}: ${e.message.substring(0,80)}`); }
} else if (age >= u.rejMin) {
ulog(u, `ALT ❌ Rejet: ${row.phone} introuvable, ${age}min >= ${u.rejMin}min`);
try {
let rlnk = null;
for (const a of await row.handle.locator('a').all()) if ((await a.textContent()).trim()==='Rejeter') { rlnk=a; break; }
if (!rlnk) continue;
await rlnk.click();
let ok = null;
for (let i=0; i<40; i++) {
for (const b of await u.page.$$('button,a.btn,.btn')) { try { if ((await b.textContent()).trim()==='OK' && await b.isVisible()) { ok=b; break; } } catch {} }
if (ok) break; await u.page.waitForTimeout(200);
}
if (!ok) continue;
await u.page.waitForTimeout(300);
const ci = await u.page.$('input[placeholder="Commentaire"],textarea[placeholder="Commentaire"]');
if (ci) { await ci.fill('Expiré'); await u.page.waitForTimeout(200); }
for (const b of await u.page.$$('button,a.btn,.btn')) { try { if ((await b.textContent()).trim()==='OK' && await b.isVisible()) { await b.click(); break; } } catch {} }
await u.page.waitForTimeout(2000); rejected++;
} catch(e) { ulog(u, `⚠ Rejet: ${e.message.substring(0,80)}`); }
} else {
ulog(u, `ALT ⏳ ${row.phone} introuvable — ${age}min < ${u.rejMin}min`);
}
}
ulog(u, `ALT [3/3] ✅ ${confirmed} confirmé(s) | ${rejected} rejeté(s) | ${approved} approuvé(s) | ${skipped} ignoré(s)`);
u.state.confirmed += confirmed; u.state.rejected += rejected; u.state.approved += approved;
}

async function userLoop(u) {
while (true) {
if (u.paused) { await new Promise(r=>setTimeout(r,2000)); continue; }
if (!u.yapsonToken) { await new Promise(r=>setTimeout(r,5000)); continue; }
try {
u.state.polls++; u.state.lastRun = new Date().toISOString(); u.state.status = 'running';
await runAlt(u);
} catch(e) {
u.state.errors++; ulog(u, `❌ ${e.message}`);
const isCookieErr = e.message.includes('ookies') || e.message.includes('login') || e.message.includes('signin');
u.state.status = isCookieErr ? 'waiting_cookies' : 'error';
const delay = isCookieErr ? 10000 : 15000;
await new Promise(r=>setTimeout(r, delay));
}
await new Promise(r=>setTimeout(r, INTERVAL_SEC*1000));
}
}

async function safeUserLoop(u) {
while (true) {
try { await userLoop(u); }
catch(fatal) {
console.error(`[FATAL] ${u.username}: ${fatal.message} — relance dans 30s`);
ulog(u, `💥 Erreur fatale: ${fatal.message} — relance auto dans 30s`);
await new Promise(r=>setTimeout(r, 30000));
}
}
}

// ── CSS ───────────────────────────────────────────────────────
const CSS = `*{box-sizing:border-box;margin:0;padding:0}body{background:#0f1117;color:#e2e8f0;font-family:monospace;padding:20px}h1{color:#cba6f7;font-size:1.2rem;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}.card{background:#1e1e2e;border-radius:10px;padding:12px;text-align:center}.card .val{font-size:1.4rem;font-weight:bold;color:#a6e3a1}.card .lbl{font-size:10px;color:#6c7086;margin-top:3px}.section{background:#1e1e2e;border-radius:10px;padding:14px;margin-bottom:12px}.section-title{font-size:11px;font-weight:bold;color:#cba6f7;margin-bottom:8px}.logs{background:#0a0e18;border-radius:8px;padding:10px;max-height:280px;overflow-y:auto}.logs div{font-size:11px;color:#94a3b8;line-height:1.7;border-bottom:1px solid #1e1e2e}input,textarea,select{background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;padding:6px 10px;font-size:12px}.btn{border:none;border-radius:6px;padding:6px 13px;font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap}.btn-red{background:#f38ba8;color:#1e1e2e}.btn-green{background:#a6e3a1;color:#1e1e2e}.btn-blue{background:#89b4fa;color:#1e1e2e}.btn-purple{background:#cba6f7;color:#1e1e2e}.btn-orange{background:#fab387;color:#1e1e2e}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.status{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold}.status.running{background:#a6e3a1;color:#1e1e2e}.status.error{background:#f38ba8;color:#1e1e2e}.status.starting,.status.waiting_cookies{background:#f38ba8;color:#1e1e2e}.status.paused{background:#fab387;color:#1e1e2e}.badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px}.ok{background:#064e3b;color:#4ade80}.ko{background:#4a1d1d;color:#f87171}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#313244;padding:7px;text-align:left;color:#89b4fa}td{padding:6px 7px;border-bottom:1px solid #1e1e2e}.hint{font-size:10px;color:#6c7086;margin-top:3px}`;

function loginPage(err='') {
return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ALT-BOT</title><style>${CSS}.box{max-width:360px;margin:80px auto;background:#1e1e2e;border-radius:14px;padding:30px}</style></head><body><div class="box"><h1 style="text-align:center;margin-bottom:22px">🤖 ALT-BOT</h1>${err?`<div style="color:#f38ba8;font-size:12px;margin-bottom:10px">❌ ${err}</div>`:''}<form method="POST" action="/login"><div style="margin-bottom:10px"><div class="hint" style="margin-bottom:3px">Utilisateur</div><input type="text" name="username" style="width:100%" required></div><div style="margin-bottom:18px"><div class="hint" style="margin-bottom:3px">Mot de passe</div><input type="password" name="password" style="width:100%" required></div><button class="btn btn-purple" style="width:100%;padding:9px">Connexion</button></form></div></body></html>`;
}

function userDash(u) {
const labels = {running:'● Actif',error:'✕ Erreur',starting:'○ Démarrage',paused:'⏸ Pausé',waiting_cookies:'⚠ Cookies requis'};
const sc = u.state.status||'starting';
const lr = u.state.lastRun ? new Date(u.state.lastRun).toLocaleTimeString('fr-FR') : '—';
const tp = u.yapsonToken ? u.yapsonToken.substring(0,8)+'•'.repeat(12)+u.yapsonToken.slice(-4) : '(non défini)';
const logs = u.state.logs.slice(0,80).map(l=>`<div>${l}</div>`).join('');
const hasNav = u.loginBrowser && u.loginBrowser.isConnected() && u.loginPage && !u.loginPage.isClosed();
return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ALT-BOT — ${u.username}</title><style>${CSS}</style></head><body>
<div class="row" style="justify-content:space-between;margin-bottom:14px"><h1>🤖 ${u.username}</h1><a href="/logout" class="btn btn-red">Déconnexion</a></div>
<div style="margin-bottom:12px"><span class="status ${sc}">${labels[sc]||sc}</span><span style="font-size:11px;color:#6c7086;margin-left:8px">Polls: ${u.state.polls} | ${lr}</span></div>
<div class="grid">
<div class="card"><div class="val">${u.state.confirmed}</div><div class="lbl">✅ Confirmés</div></div>
<div class="card"><div class="val" style="color:#89b4fa">${u.state.approved}</div><div class="lbl">🟢 Approuvés YP</div></div>
<div class="card"><div class="val" style="color:#f38ba8">${u.state.rejected}</div><div class="lbl">❌ Rejetés</div></div>
<div class="card"><div class="val" style="color:#f9e2af">${u.state.errors}</div><div class="lbl">⚠ Erreurs</div></div>
</div>
<div class="row" style="margin-bottom:12px">
<form method="POST" action="/user/stop"><button class="btn btn-red">⏸ Arrêter</button></form>
<form method="POST" action="/user/start"><button class="btn btn-green">▶ Reprendre</button></form>
<form method="POST" action="/user/reset-cookies"><button class="btn btn-blue">🍪 Reset cookies</button></form>
<span style="font-size:11px;color:${u.cookiesReady?'#a6e3a1':'#f38ba8'}">${u.cookiesReady?'✅ Cookies actifs':'⚠ Cookies requis'}</span>
</div>

<div class="section" style="border:2px solid #a6e3a1">
<div class="section-title" style="color:#a6e3a1;font-size:13px">🌐 Connexion via navigateur intégré (iPad / mobile)</div>
<div style="font-size:11px;color:#6c7086;margin-bottom:10px">Connecte-toi à my-managment.com sans avoir besoin d'extraire des cookies manuellement.</div>
<div class="row">
  <a href="/user/browser" class="btn btn-green">🌐 Ouvrir navigateur</a>
  ${hasNav ? `<form method="POST" action="/user/browser/close"><button class="btn btn-red">✕ Fermer navigateur</button></form><span style="font-size:11px;color:#a6e3a1">● Navigateur actif</span>` : `<span style="font-size:11px;color:#6c7086">● Navigateur fermé</span>`}
</div>
</div>

<div class="section"><div class="section-title">🔑 Token YapsonPress</div>
<form method="POST" action="/user/token" class="row">
<input type="password" name="token" style="width:280px" placeholder="Token YapsonPress (sans Bearer)">
<button class="btn btn-purple">💾 Enregistrer</button>
<span style="font-size:11px;color:${u.yapsonToken?'#a6e3a1':'#f38ba8'}">${u.yapsonToken?'✅ Actif':'⚠ Manquant'}</span>
</form><div class="hint">Actuel : ${tp}</div></div>
<div class="section"><div class="section-title">⚙ Configuration</div>
<form method="POST" action="/user/config" class="row">
<label style="font-size:11px">Traiter ≥</label>
<select name="confMin"><option value="2" ${u.confMin===2?'selected':''}>2 min</option><option value="10" ${u.confMin===10?'selected':''}>10 min</option><option value="30" ${u.confMin===30?'selected':''}>30 min</option></select>
<label style="font-size:11px">Rejeter ≥</label>
<select name="rejMin"><option value="45" ${u.rejMin===45?'selected':''}>45 min</option><option value="50" ${u.rejMin===50?'selected':''}>50 min</option><option value="60" ${u.rejMin===60?'selected':''}>60 min</option></select>
<button class="btn btn-purple">Appliquer</button>
</form></div>
<div class="section"><div class="section-title">🍪 Cookies manuels (optionnel)</div>
<form method="POST" action="/user/cookies"><textarea name="cookies" rows="3" style="width:100%;margin-bottom:8px" placeholder='[{"name":"...","value":"..."}]'></textarea><br><button class="btn btn-blue">💉 Injecter</button></form></div>
<div class="section"><div class="section-title">📋 Logs</div><div class="logs">${logs}</div></div>
<script>if (${JSON.stringify(u.state.status)} === 'running') { setTimeout(() => location.reload(), 10000); }</script>
</body></html>`;
}

function adminDash(err='', ok='') {
const list = Object.values(users);
const lbls = {running:'Actif',error:'Erreur',starting:'Démarrage',paused:'Pausé',waiting_cookies:'Cookies requis'};
const rows = list.map(u=>`<tr>
<td>${u.username}</td>
<td><span class="badge ${u.state.status==='running'?'ok':'ko'}">${lbls[u.state.status]||u.state.status}</span></td>
<td>${u.state.confirmed}</td><td>${u.state.rejected}</td>
<td>${u.cookiesReady?'<span class="badge ok">✅</span>':'<span class="badge ko">⚠</span>'}</td>
<td>${u.yapsonToken?'<span class="badge ok">✅</span>':'<span class="badge ko">⚠</span>'}</td>
<td><form method="POST" action="/admin/delete-user" style="display:inline"><input type="hidden" name="userId" value="${u.id}"><button class="btn btn-red" style="font-size:10px;padding:3px 7px" onclick="return confirm('Supprimer ${u.username} ?')">Supprimer</button></form></td>
</tr>`).join('');
return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ALT-BOT Admin</title><style>${CSS}</style></head><body>
<div class="row" style="justify-content:space-between;margin-bottom:14px"><h1>🛡 Administration</h1><a href="/logout" class="btn btn-red">Déconnexion</a></div>
${err?`<div style="color:#f38ba8;font-size:12px;margin-bottom:10px">❌ ${err}</div>`:''}
${ok?`<div style="color:#a6e3a1;font-size:12px;margin-bottom:10px">✅ ${ok}</div>`:''}
<div class="grid">
<div class="card"><div class="val">${list.length}</div><div class="lbl">👥 Utilisateurs</div></div>
<div class="card"><div class="val" style="color:#a6e3a1">${list.filter(u=>u.state.status==='running').length}</div><div class="lbl">● Actifs</div></div>
<div class="card"><div class="val" style="color:#4ade80">${list.reduce((s,u)=>s+u.state.confirmed,0)}</div><div class="lbl">✅ Confirmés total</div></div>
<div class="card"><div class="val" style="color:#f38ba8">${list.reduce((s,u)=>s+u.state.rejected,0)}</div><div class="lbl">❌ Rejetés total</div></div>
</div>
<div class="section"><div class="section-title">➕ Créer un utilisateur</div>
<form method="POST" action="/admin/create-user" class="row">
<input type="text" name="username" placeholder="Nom d'utilisateur" required style="width:170px">
<input type="password" name="password" placeholder="Mot de passe" required style="width:170px">
<button class="btn btn-purple">Créer</button>
</form></div>
<div class="section"><div class="section-title">👥 Utilisateurs (${list.length})</div>
${list.length===0?'<div style="color:#6c7086;font-size:12px">Aucun utilisateur.</div>':`<table><tr><th>Utilisateur</th><th>Statut</th><th>Confirmés</th><th>Rejetés</th><th>Cookies</th><th>Token YP</th><th>Action</th></tr>${rows}</table>`}
</div>
<div class="section"><div class="section-title">🔑 Mot de passe admin</div>
<form method="POST" action="/admin/change-password" class="row">
<input type="password" name="oldPass" placeholder="Ancien mot de passe" style="width:180px">
<input type="password" name="newPass" placeholder="Nouveau mot de passe" style="width:180px">
<button class="btn btn-orange">Changer</button>
</form></div>
</body></html>`;
}

// ── Routes principales ────────────────────────────────────────
app.get('/login', (req,res) => res.send(loginPage()));
app.post('/login', (req,res) => {
const { username, password } = req.body;
if (username === ADMIN_USER && password === ADMIN_PASS) {
const tok = createSession('admin', true);
res.setHeader('Set-Cookie', `session=${tok}; HttpOnly; Path=/; Max-Age=315360000`);
return res.redirect('/admin');
}
const u = Object.values(users).find(u => u.username === username && u.passwordHash === hashPass(password));
if (u) {
const tok = createSession(u.id, false);
res.setHeader('Set-Cookie', `session=${tok}; HttpOnly; Path=/; Max-Age=315360000`);
return res.redirect('/dashboard');
}
res.send(loginPage('Identifiants incorrects'));
});
app.get('/logout', (req,res) => { res.setHeader('Set-Cookie','session=; HttpOnly; Path=/; Max-Age=0'); res.redirect('/login'); });
app.get('/', (req,res) => { const s=getSession(req); if(!s) return res.redirect('/login'); return s.isAdmin ? res.redirect('/admin') : res.redirect('/dashboard'); });

app.get('/dashboard', requireLogin, (req,res) => { const u=users[req.session.userId]; if(!u) return res.redirect('/login'); res.send(userDash(u)); });
app.post('/user/stop', requireLogin, (req,res) => { const u=users[req.session.userId]; if(u){u.paused=true;u.state.status='paused';ulog(u,'⏸ Pausé');saveUser(u);} res.redirect('/dashboard'); });
app.post('/user/start', requireLogin, (req,res) => { const u=users[req.session.userId]; if(u){u.paused=false;u.state.status='running';ulog(u,'▶ Repris');saveUser(u);} res.redirect('/dashboard'); });
app.post('/user/reset-cookies', requireLogin, (req,res) => { const u=users[req.session.userId]; if(u){u.cookies=null;u.cookiesReady=false;u.state.status='waiting_cookies';ulog(u,'🍪 Cookies reset');saveUser(u);} res.redirect('/dashboard'); });
app.post('/user/token', requireLogin, async (req,res) => {
const u=users[req.session.userId];
if(u){const t=(req.body.token||'').trim();if(t){u.yapsonToken=t;ulog(u,'🔑 Token mis à jour');await saveUser(u);}}
res.redirect('/dashboard');
});
app.post('/user/config', requireLogin, async (req,res) => {
const u=users[req.session.userId]; if(!u) return res.redirect('/login');
const nc=parseInt(req.body.confMin||'10',10); const nr=parseInt(req.body.rejMin||'50',10);
if(CONF_MIN_ALLOWED.includes(nc)){u.confMin=nc;ulog(u,`⚙ confMin → ${nc}min`);}
if(REJ_MIN_ALLOWED.includes(nr)){u.rejMin=nr;ulog(u,`⚙ rejMin → ${nr}min`);}
await saveUser(u);
res.redirect('/dashboard');
});
app.post('/user/cookies', requireLogin, (req,res) => {
const u=users[req.session.userId]; if(!u) return res.redirect('/login');
const raw=(req.body.cookies||'').trim(); if(!raw) return res.redirect('/dashboard');
try {
const p=JSON.parse(raw);
if(!Array.isArray(p)) throw new Error('Tableau JSON requis');
u.cookies=raw; u.cookiesReady=false;
ulog(u,`🍪 ${p.length} cookie(s)`);
saveUser(u);
mgmtLogin(u).catch(e=>ulog(u,`❌ ${e.message}`));
}
catch(e) { ulog(u,`❌ Cookies invalides: ${e.message}`); }
res.redirect('/dashboard');
});

app.get('/admin', requireAdmin, (req,res) => res.send(adminDash()));
app.post('/admin/create-user', requireAdmin, async (req,res) => {
const { username, password } = req.body;
if (!username || !password) return res.send(adminDash('Nom et mot de passe requis'));
if (Object.values(users).find(u=>u.username===username.trim())) return res.send(adminDash(`"${username}" existe déjà`));
const u = await createUser(username.trim(), password.trim());
ulog(u, '👤 Compte créé');
safeUserLoop(u);
res.send(adminDash('', `Utilisateur "${username}" créé ✅`));
});
app.post('/admin/delete-user', requireAdmin, async (req,res) => {
const u = users[req.body.userId];
if (!u) return res.send(adminDash('Utilisateur introuvable'));
const name = u.username; u.paused = true;
if (u.browser) u.browser.close().catch(()=>{});
if (u.loginBrowser) u.loginBrowser.close().catch(()=>{});
delete users[req.body.userId];
await deleteUserFromDB(req.body.userId);
res.send(adminDash('', `"${name}" supprimé ✅`));
});
app.post('/admin/change-password', requireAdmin, async (req,res) => {
const { oldPass, newPass } = req.body;
if (oldPass !== ADMIN_PASS) return res.send(adminDash('Ancien mot de passe incorrect'));
if (!newPass || newPass.length < 4) return res.send(adminDash('Nouveau mot de passe trop court'));
ADMIN_PASS = newPass;
await saveAdminPass(newPass);
res.send(adminDash('', 'Mot de passe admin changé ✅'));
});
app.get('/status', (req,res) => {
const s = getSession(req); if(!s) return res.status(401).json({error:'Non autorisé'});
if(s.isAdmin) return res.json({users:Object.values(users).map(u=>({username:u.username,status:u.state.status,confirmed:u.state.confirmed,rejected:u.state.rejected}))});
const u=users[s.userId]; return u ? res.json(u.state) : res.status(404).json({error:'Introuvable'});
});

// ── Démarrage ─────────────────────────────────────────────────
async function start() {
await loadAdminPass();
await loadUsersFromDB();
app.listen(PORT, () => {
console.log(`🌐 ALT-BOT multi-users port ${PORT} | Admin: ${ADMIN_USER}`);
});
}

start().catch(e => {
console.error('❌ Démarrage échoué:', e.message);
process.exit(1);
});
