import {
  listRecentForBrief,
  listRecentDirectiveChanges,
  snapshot
} from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "shimmer");
const CHAT_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

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

    const body = JSON.parse(event.body || "{}");
    const businessId = body.businessId;
    if (!businessId) return { statusCode:400, headers:hdrs, body: JSON.stringify({ error:"Missing businessId" }) };

    // First-time onboarding check
    const snap = snapshot(businessId);
    const isFresh = !snap.settings.hasAdminPass &&
                    snap.counts.directives === 0 &&
                    snap.counts.updates === 0 &&
                    snap.counts.statics === 0;

    let say;

    if (isFresh) {
      // Explicit onboarding question
      say = "Welcome to Nora. Are you the admin or an employee? " +
            "If you are the admin, say “activate admin mode” to set a password and add updates. " +
            "If you’re an employee, you’ll hear updates when available and can ask questions about team info.";
    } else {
      const updates = listRecentForBrief(businessId);
      const dirChanges = listRecentDirectiveChanges(businessId);

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
    }

    const audio = await ttsOpenAI(say).catch(()=>null);
    return { statusCode:200, headers:hdrs, body: JSON.stringify({ audio, maxSpeakMs:8000 }) };

  }catch(e){
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:String(e.message||e) }) };
  }
};

async function ttsOpenAI(text){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model:"tts-1", voice: OPENAI_TTS_VOICE, input: polish(text), response_format:"mp3" })
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer());
  return `data:audio/mpeg;base64,${b.toString("base64")}`;
}
function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 1000);
}
