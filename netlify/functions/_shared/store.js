// In-memory store (per lambda instance). For persistence, swap to a DB later.
const GLOBAL = globalThis.__NORA_VOICE_STORE__ ||= {
  updates: [],   // time-sensitive items
  statics: []    // long-term info
};

function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function tokenize(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

const UPDATES_TTL_HOURS = Number(process.env.UPDATES_TTL_HOURS || 48);
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 36);

function pruneExpired(){
  const now = Date.now();
  GLOBAL.updates = GLOBAL.updates.filter(u => {
    if (!u.expiresAt) return true;
    return u.expiresAt > now;
  });
}

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
  const row = { id, type:"static", text:String(text||"").trim(), createdAt: Date.now() }; // no expiry
  GLOBAL.statics.push(row);
  return row;
}

export function removeLast(kind){
  pruneExpired();
  if (kind === "update") {
    const last = GLOBAL.updates.pop();
    return last ? 1 : 0;
  }
  if (kind === "static" || kind === "note") {
    const last = GLOBAL.statics.pop();
    return last ? 1 : 0;
  }
  // generic last
  const a = GLOBAL.updates[GLOBAL.updates.length-1]?.createdAt || 0;
  const b = GLOBAL.statics[GLOBAL.statics.length-1]?.createdAt || 0;
  if (a >= b) return GLOBAL.updates.pop() ? 1 : 0;
  return GLOBAL.statics.pop() ? 1 : 0;
}

export function removeContaining(needle){
  pruneExpired();
  const n = String(needle||"").toLowerCase();
  const beforeU = GLOBAL.updates.length;
  const beforeS = GLOBAL.statics.length;
  GLOBAL.updates = GLOBAL.updates.filter(u => !u.text.toLowerCase().includes(n));
  GLOBAL.statics = GLOBAL.statics.filter(s => !s.text.toLowerCase().includes(n));
  return (beforeU - GLOBAL.updates.length) + (beforeS - GLOBAL.statics.length);
}

export function clearAll(){
  GLOBAL.updates = [];
  GLOBAL.statics = [];
  return true;
}

export function listRecentForBrief(){
  pruneExpired();
  const cutoff = Date.now() - (BRIEF_WINDOW_HOURS * 60 * 60 * 1000);
  return GLOBAL.updates
    .filter(u => u.createdAt >= cutoff)
    .sort((a,b) => b.createdAt - a.createdAt);
}

// naive keyword similarity + recency boost on updates
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

export function searchRelevant(query, { kUpdates = 3, kStatics = 3 } = {}){
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

  return { updates: ups, statics: sts };
}

export function snapshot(){
  pruneExpired();
  return {
    counts: { updates: GLOBAL.updates.length, statics: GLOBAL.statics.length }
  };
}
