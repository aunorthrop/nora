// Global in-memory store (per Lambda instance). For persistence, swap to DB later.
const GLOBAL = globalThis.__NORA_STORE__ ||= {
  admin: {
    pass: null,                 // string|null
    sessions: new Set(),        // sessionIds in admin mode
    awaiting: new Map()         // sessionId -> "await_password" | "await_new_password" | null
  },
  directives: [],               // {id, text, createdAt}
  updates: [],                  // {id, text, createdAt, expiresAt}
  statics: [],                  // {id, text, createdAt}
  docs: []                      // {id, name, text, createdAt}
};

function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function tokenize(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

const UPDATES_TTL_HOURS  = Number(process.env.UPDATES_TTL_HOURS  || 48);
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 36);

function pruneExpired(){
  const now = Date.now();
  GLOBAL.updates = GLOBAL.updates.filter(u => !u.expiresAt || u.expiresAt > now);
}

// ---------- Admin mode ----------
export function adminState(){ return GLOBAL.admin; }
export function isAdmin(sessionId){ return GLOBAL.admin.sessions.has(sessionId); }
export function setAwait(sessionId, val){ if(val) GLOBAL.admin.awaiting.set(sessionId, val); else GLOBAL.admin.awaiting.delete(sessionId); }
export function getAwait(sessionId){ return GLOBAL.admin.awaiting.get(sessionId) || null; }
export function enterAdmin(sessionId){ GLOBAL.admin.sessions.add(sessionId); }
export function exitAdmin(sessionId){ GLOBAL.admin.sessions.delete(sessionId); setAwait(sessionId, null); }
export function setPass(newPass){ GLOBAL.admin.pass = String(newPass||"").trim(); }
export function hasPass(){ return !!GLOBAL.admin.pass; }
export function checkPass(p){ return (String(p||"").trim() === (GLOBAL.admin.pass||"")); }

// ---------- Director (business rules) ----------
export function addDirective(text){
  const id = uid();
  const row = { id, type:"directive", text:String(text||"").trim(), createdAt: Date.now() };
  GLOBAL.directives.push(row);
  return row;
}
export function listDirectives(){
  return [...GLOBAL.directives].sort((a,b)=>b.createdAt - a.createdAt);
}
export function removeLastDirective(){
  return GLOBAL.directives.pop() ? 1 : 0;
}
export function removeDirectiveContaining(needle){
  const n = String(needle||"").toLowerCase();
  const before = GLOBAL.directives.length;
  GLOBAL.directives = GLOBAL.directives.filter(d => !d.text.toLowerCase().includes(n));
  return (before - GLOBAL.directives.length);
}
export function clearDirectives(){ GLOBAL.directives = []; return true; }
export function listRecentDirectiveChanges(){
  const cutoff = Date.now() - (BRIEF_WINDOW_HOURS * 60 * 60 * 1000);
  return GLOBAL.directives.filter(d => d.createdAt >= cutoff).sort((a,b)=>b.createdAt - a.createdAt);
}

// ---------- Updates / Static ----------
export function addUpdate(text){
  pruneExpired();
  const id = uid();
  const createdAt = Date.now();
  const ttlMs = UPDATES_TTL_HOURS * 60 * 60 * 1000;
  const row = { id, type:"update", text:String(text||"").trim(), createdAt, expiresAt: createdAt + ttlMs };
  GLOBAL.updates.push(row);
  return row;
}
export function addStatic(text){
  pruneExpired();
  const id = uid();
  const row = { id, type:"static", text:String(text||"").trim(), createdAt: Date.now() };
  GLOBAL.statics.push(row);
  return row;
}
export function removeLast(kind){
  pruneExpired();
  if (kind === "update")  return GLOBAL.updates.pop()  ? 1 : 0;
  if (kind === "static" || kind === "note") return GLOBAL.statics.pop() ? 1 : 0;
  if (kind === "directive") return removeLastDirective();
  const lastTimes = [
    GLOBAL.updates[GLOBAL.updates.length-1]?.createdAt || 0,
    GLOBAL.statics[GLOBAL.statics.length-1]?.createdAt || 0,
    GLOBAL.directives[GLOBAL.directives.length-1]?.createdAt || 0
  ];
  const maxIdx = lastTimes.indexOf(Math.max(...lastTimes));
  if (maxIdx === 0) return GLOBAL.updates.pop() ? 1 : 0;
  if (maxIdx === 1) return GLOBAL.statics.pop() ? 1 : 0;
  if (maxIdx === 2) return GLOBAL.directives.pop() ? 1 : 0;
  return 0;
}
export function removeContaining(needle){
  pruneExpired();
  const n = String(needle||"").toLowerCase();
  const beforeU = GLOBAL.updates.length;
  const beforeS = GLOBAL.statics.length;
  const beforeD = GLOBAL.directives.length;
  GLOBAL.updates     = GLOBAL.updates.filter(u => !u.text.toLowerCase().includes(n));
  GLOBAL.statics     = GLOBAL.statics.filter(s => !s.text.toLowerCase().includes(n));
  GLOBAL.directives  = GLOBAL.directives.filter(d => !d.text.toLowerCase().includes(n));
  return (beforeU - GLOBAL.updates.length) + (beforeS - GLOBAL.statics.length) + (beforeD - GLOBAL.directives.length);
}
export function clearAll(){ GLOBAL.updates=[]; GLOBAL.statics=[]; GLOBAL.directives=[]; GLOBAL.docs=[]; return true; }
export function listRecentForBrief(){
  pruneExpired();
  const cutoff = Date.now() - (BRIEF_WINDOW_HOURS * 60 * 60 * 1000);
  return GLOBAL.updates.filter(u => u.createdAt >= cutoff).sort((a,b)=>b.createdAt - a.createdAt);
}

// ---------- Docs (PDF text already extracted) ----------
export function addDoc(name, text){
  const id = uid();
  const row = { id, name: String(name||"").slice(0,160), text: String(text||""), createdAt: Date.now() };
  GLOBAL.docs.push(row);
  return row;
}

// ---------- Search (naive keywords + recency boost for updates) ----------
function scoreText(qTokens, text, createdAt, isUpdate){
  const t = tokenize(text);
  let overlap = 0; for (const tok of qTokens) if (t.includes(tok)) overlap++;
  let score = overlap;
  if (isUpdate) {
    const ageH = (Date.now() - createdAt) / (60*60*1000);
    const recencyBoost = Math.max(0, 4 - Math.log1p(ageH)); // fades with age
    score += recencyBoost;
  }
  return score;
}

export function searchRelevant(query, { kUpdates = 3, kStatics = 3, kDocs = 2 } = {}){
  pruneExpired();
  const q = tokenize(query);

  const ups = GLOBAL.updates
    .map(u => ({...u, _s: scoreText(q, u.text, u.createdAt, true)}))
    .filter(x => x._s > 0)
    .sort((a,b)=>b._s - a._s)
    .slice(0, kUpdates);

  const sts = GLOBAL.statics
    .map(s => ({...s, _s: scoreText(q, s.text, s.createdAt, false)}))
    .filter(x => x._s > 0)
    .sort((a,b)=>b._s - a._s)
    .slice(0, kStatics);

  const dcs = GLOBAL.docs
    .map(d => ({...d, _s: scoreText(q, d.text.slice(0, 120000), d.createdAt, false)}))
    .filter(x => x._s > 0)
    .sort((a,b)=>b._s - a._s)
    .slice(0, kDocs);

  return { updates: ups, statics: sts, docs: dcs };
}

export function snapshot(){
  pruneExpired();
  return {
    admin: { hasPass: !!GLOBAL.admin.pass, sessions: GLOBAL.admin.sessions.size },
    counts: { directives: GLOBAL.directives.length, updates: GLOBAL.updates.length, statics: GLOBAL.statics.length, docs: GLOBAL.docs.length }
  };
}
