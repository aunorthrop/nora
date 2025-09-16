// Generates a fresh 8-digit team code (####-####). No Stripe validation here.
// If you later add webhooks/session verification, plug it in before returning the code.

export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "{}" };

  function genCode(){
    const n = Math.floor(Math.random() * 1e8); // 0..99,999,999
    const s = String(n).padStart(8, "0");
    return s.slice(0,4) + "-" + s.slice(4);
  }

  // Optional: keep a list of issued codes in-memory (ephemeral)
  const issued = globalThis.__NORA_CODES__ || (globalThis.__NORA_CODES__ = new Set());

  let code = genCode();
  while (issued.has(code)) code = genCode();
  issued.add(code);

  return { statusCode: 200, headers, body: JSON.stringify({ code }) };
};
