// Minimal in-memory file/text store per team (demo-grade).
// Accepts: POST { businessId, name, size, text }
// GET ?businessId=####-####
// DELETE ?businessId=####-####&id=...

const db = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());

const ok = (body) => ({
  statusCode: 200,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  },
  body: JSON.stringify(body),
});

const bad = (msg, code = 400) => ({
  statusCode: code,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  },
  body: JSON.stringify({ error: msg }),
});

function isCode(code) { return /^[0-9]{4}-[0-9]{4}$/.test(String(code || "")); }
function team(biz) {
  if (!db.has(biz)) db.set(biz, { updates: [], longterm: [], docs: [] });
  return db.get(biz);
}
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });

  if (event.httpMethod === "GET") {
    const businessId = (event.queryStringParameters || {}).businessId || "";
    if (!isCode(businessId)) return bad("missing_or_bad_team_code");
    const t = team(businessId);
    return ok({ docs: t.docs.map(({ id, name, size, ts }) => ({ id, name, size, ts })) });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return bad("bad_json"); }
    const { businessId, name, size, text } = body || {};
    if (!isCode(businessId)) return bad("missing_or_bad_team_code");
    if (!name || typeof text !== "string") return bad("missing_name_or_text");

    const t = team(businessId);
    const id = uid();
    t.docs.push({ id, name: String(name).slice(0, 140), size: Number(size || 0), text: String(text || ""), ts: Date.now() });
    // cap
    t.docs = t.docs.slice(-200);
    return ok({ id });
  }

  if (event.httpMethod === "DELETE") {
    const qs = event.queryStringParameters || {};
    const businessId = qs.businessId || "";
    const id = qs.id || "";
    if (!isCode(businessId)) return bad("missing_or_bad_team_code");
    const t = team(businessId);
    const i = t.docs.findIndex(d => d.id === id);
    if (i >= 0) t.docs.splice(i, 1);
    return ok({ ok: true });
  }

  return bad("method_not_allowed", 405);
};
