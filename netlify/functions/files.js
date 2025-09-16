import { addDoc, listDocs, deleteDoc } from "./_shared/store.js";

const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS"
};

export const handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:hdrs, body: JSON.stringify({ ok:true }) };

    if (event.httpMethod === "GET") {
      const businessId = event.queryStringParameters?.businessId || "";
      if (!businessId) return reply(400, { error:"Missing businessId" });
      return reply(200, { docs: listDocs(businessId) });
    }

    if (event.httpMethod === "DELETE") {
      const businessId = event.queryStringParameters?.businessId || "";
      const id = event.queryStringParameters?.id || "";
      if (!businessId || !id) return reply(400, { error:"Missing businessId or id" });
      const ok = deleteDoc(businessId, id);
      return reply(200, { ok });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { businessId, name, size, text } = body;
      if (!businessId || !name || typeof size !== "number" || !text) return reply(400, { error:"Missing fields" });
      const row = addDoc(businessId, { name, size, text });
      return reply(200, { doc: row });
    }

    return reply(405, { error:"Method Not Allowed" });
  }catch(e){
    return reply(500, { error: String(e.message||e) });
  }
};

function reply(statusCode, data){ return { statusCode, headers:hdrs, body: JSON.stringify(data) }; }
