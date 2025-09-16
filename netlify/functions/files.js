// Per-team lightweight document store (text only, uploaded from the client)
// Accepts .pdf (text extracted client-side), .txt, .md
const MAX_TEXT_CHARS = 200_000; // ~200 KB text cap

export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "{}" };

  try {
    const url = new URL(event.rawUrl || ("https://x" + (event.path || "") + (event.queryStringParameters ? ("?" + new URLSearchParams(event.queryStringParameters).toString()) : "")));
    const businessId = (url.searchParams.get("businessId") || "").trim();
    if (!/^[0-9]{4}-[0-9]{4}$/.test(businessId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_business_id" }) };
    }

    const store = globalThis.__NORA_DOCS__ || (globalThis.__NORA_DOCS__ = new Map());

    if (event.httpMethod === "GET") {
      const docs = store.get(businessId) || [];
      return { statusCode: 200, headers, body: JSON.stringify({ docs }) };
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid_json" }) }; }

      const name = String(body.name || "").slice(0, 180);
      const size = Number(body.size || 0);
      const text = String(body.text || "");
      if (!name || !text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "name_and_text_required" }) };
      }
      if (text.length > MAX_TEXT_CHARS) {
        return { statusCode: 413, headers, body: JSON.stringify({ error: "text_too_large", max: MAX_TEXT_CHARS }) };
      }

      const docs = store.get(businessId) || [];
      const id = Math.random().toString(36).slice(2, 10);
      docs.push({ id, name, size, text, ts: Date.now() });
      while (docs.length > 50) docs.shift();
      store.set(businessId, docs);

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
    }

    if (event.httpMethod === "DELETE") {
      const id = (new URL(event.rawUrl)).searchParams.get("id");
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id_required" }) };
      const docs = store.get(businessId) || [];
      const next = docs.filter(d => d.id !== id);
      store.set(businessId, next);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed" }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || "server_error" }) };
  }
};
