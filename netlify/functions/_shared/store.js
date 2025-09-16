// Multi-tenant in-memory store (per lambda instance).
// For persistence later, swap tenants Map to a DB (same API).

const tenants = globalThis.__NORA_TENANTS__ ||= new Map();

const UPDATES_TTL_HOURS  = Number(process.env.UPDATES_TTL_HOURS  || 48);
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 36);

function now(){ return Date.now(); }
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function tokenize(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

function ensureTenant(biz){
  if (!biz || typeof biz !== "string") throw new Error("businessId required");
  if (!tenants.has(biz)) {
    tenants.set(biz, {
      settings: { adminPass: null, onboardedAt: null },
      directives: [], // business rules, no expiry
      updates: [],    // time-sensitive
      statics: []     // long-term
    });
  }
  return tenants.get(biz);
}

function pruneExpired(biz){
  const t = ensureTenant(biz);
  const nowTs = now();
  t.updates = t.updates.filter(u => !u.expiresAt || u.expiresAt > nowTs);
}

// ---------- Settings ----------
export function getSettings(biz){ return ensureTenant(biz).settings; }
export function setAdminPass(biz, pass){
  const t = ensureTenant(biz);
  t.settings.adminPass = String(pass || "").trim();
  if (!t.settings.onboardedAt) t.settings.onboardedAt = now();
  return true;
}

// ---------- Director rules ----------
export function addDirective(biz, text){
  const t = ensureTenant(biz);
  const row = { id: uid(), type:"directive", text:String(text||"").trim(), createdAt: now() };
  t.directives.push(row);
  return row;
}
export function listDirectives(biz){
  const t = ensureTenant(biz);
  return [...t.directives].sort((a,b)=>b.createdAt - a.createdAt);
}
export function removeLastDirective(biz){
  const t = ensureTenant(biz);
  return t.directives.pop() ? 1 : 0;
}
export function removeDirectiveContaining(biz, needle){
  const t = ensureTenant(biz);
  const n = String(needle||"").toLowerCase();
  const before = t.directives.length;
  t.directives = t.directives.filter(d => !d.text.toLowerCase().includes(n));
  return before - t.directives.length;
}
export function clearDirectives(biz){
  ensureTenant(biz).directives = [];
  return true;
}
export function listRecentDirectiveChanges(biz){
  const t = ensureTenant(biz);
  const cutoff = now() - (BRIEF_WINDOW_HOURS * 60 * 60 * 1000);
  return t.directives.filter(d => d.createdAt >= cutoff).sort((a,b)=>b.createdAt - a.createdAt);
}

// ---------- Updates / Static ----------
export function addUpdate(biz, text){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  const createdAt = now();
  const ttlMs = UPDATES_TTL_HOURS * 60 * 60 * 1000;
  const row = { id: uid(), type:"update", text:String(text||"").trim(), createdAt, expiresAt: createdAt + ttlMs };
  t.updates.push(row);
  return row;
}
export function addStatic(biz, text){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  const row = { id: uid(), type:"static", text:String(text||"").trim(), createdAt: now() };
  t.statics.push(row);
  return row;
}
export function removeLast(biz, kind){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  if (kind === "update")  return t.updates.pop() ? 1 : 0;
  if (kind === "static" || kind === "note") return t.statics.pop() ? 1 : 0;
  if (kind === "directive") return removeLastDirective(biz);
  // generic last across all three
  const a = t.updates[t.updates.length-1]?.createdAt || 0;
  const b = t.statics[t.statics.length-1]?.createdAt || 0;
  const c = t.directives[t.directives.length-1]?.createdAt || 0;
  const max = Math.max(a,b,c);
  if (max === a) return t.updates.pop() ? 1 : 0;
  if (max === b) return t.statics.pop() ? 1 : 0;
  if (max === c) return t.directives.pop() ? 1 : 0;
  return 0;
}
export function removeContaining(biz, needle){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  const n = String(needle||"").toLowerCase();
  const bu = t.updates.length, bs = t.statics.length, bd = t.directives.length;
  t.updates    = t.updates.filter(u => !u.text.toLowerCase().includes(n));
  t.statics    = t.statics.filter(s => !s.text.toLowerCase().includes(n));
  t.directives = t.directives.filter(d => !d.text.toLowerCase().includes(n));
  return (bu - t.updates.length) + (bs - t.statics.length) + (bd - t.directives.length);
}
export function clearAll(biz){
  const t = ensureTenant(biz);
  t.updates = []; t.statics = []; t.directives = [];
  return true;
}
export function listRecentForBrief(biz){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  const cutoff = now() - (BRIEF_WINDOW_HOURS * 60 * 60 * 1000);
  return t.updates.filter(u => u.createdAt >= cutoff).sort((a,b)=>b.createdAt - a.createdAt);
}

// ---------- Search ----------
function scoreText(qTokens, text, createdAt, isUpdate){
  const t = tokenize(text);
  let overlap = 0; for (const tok of qTokens) if (t.includes(tok)) overlap++;
  let score = overlap;
  if (isUpdate) {
    const ageH = (now() - createdAt) / (60*60*1000);
    const recencyBoost = Math.max(0, 4 - Math.log1p(ageH));
    score += recencyBoost;
  }
  return score;
}
export function searchRelevant(biz, query, { kUpdates = 3, kStatics = 3 } = {}){
  pruneExpired(biz);
  const t = ensureTenant(biz);
  const q = tokenize(query);
  const ups = t.updates
    .map(u => ({...u, _s: scoreText(q, u.text, u.createdAt, true)}))
    .filter(x => x._s > 0)
    .sort((a,b)=>b._s - a._s)
    .slice(0, kUpdates);
  const sts = t.statics
    .map(s => ({...s, _s: scoreText(q, s.text, s.createdAt, false)}))
    .filter(x => x._s > 0)
    .sort((a,b)=>b._s - a._s)
    .slice(0, kStatics);
  return { updates: ups, statics: sts };
}

// ---------- Debug ----------
export function snapshot(biz){
  const t = ensureTenant(biz);
  return {
    counts: { directives: t.directives.length, updates: t.updates.length, statics: t.statics.length },
    settings: { hasAdminPass: !!t.settings.adminPass, onboardedAt: t.settings.onboardedAt }
  };
}
