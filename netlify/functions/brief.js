import { listRecentForBrief } from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
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

    const recent = listRecentForBrief();
    let say;
    if (!recent.length) {
      say = "No new updates. Ask me anything you need.";
    } else {
      // Build bullet lines from raw update texts
      const bullets = recent.slice(0, 8).map(u => `- ${u.text}`).join("\n");
      const sys = `You write a spoken daily brief. 2–4 short sentences. Be crisp and concrete. End with: "Ask me anything."`;
      const user = `Summarize these fresh updates:\n${bullets}\n\nMake it factual, no fluff.`;

      const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({ model: CHAT_MODEL, temperature:0.3, max_tokens:160, messages:[{role:"system",content:sys},{role:"user",content:user}] })
      });
      if (!r.ok) throw new Error(`Brief chat ${r.status}: ${await r.text()}`);
      const j = await r.json();
      say = j.choices?.[0]?.message?.content?.trim() || "Here’s what’s new. Ask me anything.";
    }

    // ElevenLabs TTS
    if (ELEVEN_API_KEY && ELEVEN_VOICE_ID) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,{
        method:"POST",
        headers:{ "xi-api-key":ELEVEN_API_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
        body: JSON.stringify({
          text: polish(say),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability:0.7, similarity_boost:0.8, style:0.2, use_speaker_boost:true },
          output_format: "mp3_44100_128"
        })
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text().catch(()=>"(no body)")}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("tiny buffer");
      return { statusCode:200, headers:hdrs, body: JSON.stringify({ audio:`data:audio/mpeg;base64,${buf.toString("base64")}`, maxSpeakMs:8000 }) };
    }

    // Fallback: client TTS
    return { statusCode:200, headers:hdrs, body: JSON.stringify({ clientTTS:true, sayText:say, tone:"neutral", maxSpeakMs:8000 }) };
  }catch(e){
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:String(e.message||e) }) };
  }
};

function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 1000);
}
