import { listRecentForBrief, listRecentDirectiveChanges } from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  const banned = ["gpt-5-thinking","gpt5","thinking","demo"];
  return !m || banned.includes(m.toLowerCase()) ? fallback : m;
})();
const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};

export const handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:hdrs, body: JSON.stringify({ ok:true }) };
    if (event.httpMethod !== "POST")    return { statusCode:405, headers:hdrs, body: JSON.stringify({ error:"Method Not Allowed" }) };

    const updates = listRecentForBrief();
    const dirChanges = listRecentDirectiveChanges();

    let say;
    if (!updates.length && !dirChanges.length) {
      say = "No new updates or policy changes. Ask me anything you need.";
    } else {
      const lines = [
        ...(dirChanges.slice(0, 4).map(d => `Policy: ${d.text}`)),
        ...(updates.slice(0, 6).map(u => `Update: ${u.text}`))
      ];
      const sys = `You write a spoken brief for a team. 2–4 compact sentences. Mention policy changes first if any. End with: "Ask me anything."`;
      const user = `Summarize these:\n${lines.map(l=>`- ${l}`).join("\n")}`;

      const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({ model: CHAT_MODEL, temperature:0.3, max_tokens:160, messages:[{role:"system",content:sys},{role:"user",content:user}] })
      });
      if (!r.ok) throw new Error(`Brief chat ${r.status}: ${await r.text()}`);
      const j = await r.json();
      say = j.choices?.[0]?.message?.content?.trim() || "Here’s what’s new. Ask me anything.";
    }

    // OpenAI TTS (shimmer, slightly lively)
    const b64 = await ttsOpenAI(say, "shimmer", 1.05);
    return { statusCode:200, headers:hdrs, body: JSON.stringify({ audio:`data:audio/mp3;base64,${b64}`, maxSpeakMs:8000 }) };

  }catch(e){
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:String(e.message||e) }) };
  }
};

async function ttsOpenAI(text, voice="shimmer", speed=1.05){
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model:"tts-1", voice, input:polish(text), response_format:"mp3", speed })
  });
  if(!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if(buf.length<1000) throw new Error("tiny TTS buffer");
  return buf.toString("base64");
}
function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 1200);
}
