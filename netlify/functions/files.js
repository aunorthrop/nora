// Simple in-memory file store per businessId
export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "{}" };

  const store = globalThis.__NORA_DOCS__ || (globalThis.__NORA_DOCS__ = new Map());

  try {
    const url = new URL(event.rawUrl || `https://x${event.path}${event.queryStringParameters ? "?" + new URLSearchParams(event.queryStringParameters).toString() : ""}`);
    const businessId = (url.searchParams.get("businessId") || "").trim();
    if (!businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: "businessId required" }) };

    if (event.httpMethod === "GET") {
      const docs = Array.from(store.get(businessId) || []);
      return { statusCode: 200, headers, body: JSON.stringify({ docs }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const name = String(body.name || "").slice(0, 180);
      const size = Number(body.size || 0);
      const text = String(body.text || "");
      if (!name || !text) return { statusCode: 400, headers, body: JSON.stringify({ error: "name and text required" }) };

      const docs = store.get(businessId) || [];
      const id = Math.random().toString(36).slice(2, 10);
      docs.push({ id, name, size, text, ts: Date.now() });
      // prune to last 50
      while (docs.length > 50) docs.shift();
      store.set(businessId, docs);

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
    }

    if (event.httpMethod === "DELETE") {
      const id = (new URL(event.rawUrl)).searchParams.get("id");
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "id required" }) };
      const docs = store.get(businessId) || [];
      const next = docs.filter(d => d.id !== id);
      store.set(businessId, next);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
