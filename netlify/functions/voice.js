import {
  adminState, isAdmin, setAwait, getAwait, enterAdmin, exitAdmin, setPass, hasPass, checkPass,
  addDirective, listDirectives, removeLastDirective, removeDirectiveContaining, clearDirectives,
  addUpdate, addStatic, removeLast, removeContaining, clearAll, searchRelevant, snapshot
} from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  const banned = ["gpt-5-thinking","gpt5","thinking","demo"];
  return !m || banned.includes(m.toLowerCase()) ? fallback : m;
})();
const STT_MODEL = "whisper-1";
const DEFAULT_TONE = (process.env.DEFAULT_TONE || "neutral").toLowerCase();

const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST, OPTIONS, GET",
  "Cache-Control":"no-cache"
};

export const handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:hdrs, body: JSON.stringify({ ok:true }) };
    if (event.httpMethod === "GET")     return { statusCode:200, headers:hdrs, body: JSON.stringify({ message:"Nora OK", ts:new Date().toISOString(), store:snapshot() }) };
    if (event.httpMethod !== "POST")    return { statusCode:405, headers:hdrs, body: JSON.stringify({ error:"Method Not Allowed" }) };
    if (!process.env.OPENAI_API_KEY)    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:"OPENAI_API_KEY not configured" }) };

    const body = JSON.parse(event.body || "{}");
    const { businessId, sessionId, audio, memoryShadow } = body;
    if (!businessId || !sessionId || !audio?.data || !audio?.mime)
      return { statusCode:400, headers:hdrs, body: JSON.stringify({ error:"Missing required information" }) };

    // 1) STT
    const transcript = await transcribe(audio.data, audio.mime).catch(()=>"");
    if (!transcript.trim()) {
      const audioUrl = await ttsSafe("I heard you, but the words were unclear—try again a touch closer to the mic.", "shimmer", 1.05).catch(()=>null);
      return reply(200, { sessionId, response:"unclear", audio:audioUrl, maxSpeakMs:4500, memoryShadow:{} });
    }
    const lower = transcript.toLowerCase();

    // 2) Admin mode activation & password flow
    const awaitState = getAwait(sessionId);
    if (awaitState === "await_password") {
      const pass = extractAfter(lower, /^(?:admin\s+password\s+is|password\s+is|password)\s*/i);
      if (pass) {
        if (checkPass(pass)) {
          setAwait(sessionId, null); enterAdmin(sessionId);
          const audioUrl = await ttsSafe("Admin mode activated.", "shimmer", 1.05);
          return reply(200, { sessionId, response:"admin_on", audio:audioUrl, maxSpeakMs:3000, memoryShadow:{} });
        } else {
          const audioUrl = await ttsSafe("That password didn’t match. Say it again, or say exit admin mode.", "shimmer", 1.05);
          return reply(200, { sessionId, response:"bad_pass", audio:audioUrl, maxSpeakMs:5000, memoryShadow:{} });
        }
      }
      const audioUrl = await ttsSafe("Please say your admin password, for example: admin password is …", "shimmer", 1.05);
      return reply(200, { sessionId, response:"ask_pass", audio:audioUrl, maxSpeakMs:5000, memoryShadow:{} });
    }
    if (awaitState === "await_new_password") {
      const newPass = extractAfter(lower, /^(?:new\s+password\s+is|password\s+is)\s*/i);
      if (newPass) {
        setPass(newPass); setAwait(sessionId, null); enterAdmin(sessionId);
        const audioUrl = await ttsSafe("New admin password saved. Admin mode activated.", "shimmer", 1.05);
        return reply(200, { sessionId, response:"new_pass_saved", audio:audioUrl, maxSpeakMs:4500, memoryShadow:{} });
      }
      const audioUrl = await ttsSafe("Say: new password is …", "shimmer", 1.05);
      return reply(200, { sessionId, response:"ask_new_pass", audio:audioUrl, maxSpeakMs:4000, memoryShadow:{} });
    }

    // Commands to enter/exit admin mode
    if (/^activate\s+admin\s+mode\b/i.test(lower)) {
      if (hasPass()) {
        setAwait(sessionId, "await_password");
        const audioUrl = await ttsSafe("Say your admin password to continue.", "shimmer", 1.05);
        return reply(200, { sessionId, response:"need_pass", audio:audioUrl, maxSpeakMs:4000, memoryShadow:{} });
      } else {
        setAwait(sessionId, "await_new_password");
        const audioUrl = await ttsSafe("No admin password set. Say: new password is …", "shimmer", 1.05);
        return reply(200, { sessionId, response:"set_pass", audio:audioUrl, maxSpeakMs:4500, memoryShadow:{} });
      }
    }
    if (/^exit\s+admin\s+mode\b/i.test(lower)) {
      if (isAdmin(sessionId)) {
        exitAdmin(sessionId);
        const audioUrl = await ttsSafe("Admin mode off.", "shimmer", 1.05);
        return reply(200, { sessionId, response:"admin_off", audio:audioUrl, maxSpeakMs:3000, memoryShadow:{} });
      }
    }
    if (/^change\s+admin\s+password\b/i.test(lower)) {
      if (!isAdmin(sessionId)) {
        const audioUrl = await ttsSafe("Activate admin mode first.", "shimmer", 1.05);
        return reply(200, { sessionId, response:"need_admin", audio:audioUrl, maxSpeakMs:3500, memoryShadow:{} });
      }
      setAwait(sessionId, "await_new_password");
      const audioUrl = await ttsSafe("Ready. Say: new password is …", "shimmer", 1.05);
      return reply(200, { sessionId, response:"await_new", audio:audioUrl, maxSpeakMs:3500, memoryShadow:{} });
    }

    // 3) Admin commands (when in admin mode)
    if (isAdmin(sessionId)) {
      const out = handleAdminCommands(lower, transcript);
      const audioUrl = await ttsSafe(out.say, "shimmer", 1.05);
      return reply(200, { sessionId, response:out.say, audio:audioUrl, maxSpeakMs:5500, memoryShadow:{} });
    }

    // 4) Employee Q&A against Director + Updates + Static + Docs
    const sys = buildSystem();
    const hits = searchRelevant(transcript, { kUpdates:3, kStatics:3, kDocs:2 });
    const ctx = buildContext(hits);
    const messages = [
      { role:"system", content: sys + `\n\nCONTEXT (Director/Updates/Static/Docs):\n${ctx}` },
      { role:"user", content: transcript }
    ];
    const out = await chatJSON(messages).catch(()=>({
      say:"I hit a snag. Mind asking that again?",
      tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
      confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0.0
    }));
    const sayNow = out.interrupt_now && out.follow_up ? out.follow_up : out.say;
    const audioUrl = await ttsSafe(sayNow, "shimmer", 1.05).catch(()=>null);
    return reply(200, {
      sessionId, response:sayNow, audio:audioUrl, maxSpeakMs:Number(out.max_speak_ms||6500),
      memoryShadow:{}
    });

  }catch(err){
    console.error("voice error:", err);
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:`Internal server error: ${err.message}` }) };
  }
};

// ---------- Helpers ----------
async function transcribe(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if(buf.length<300) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language","en");
  fd.set("temperature","0.2");
  fd.set("prompt","Business voice interface; user may pause or self-correct.");
  const blob = new Blob([buf],{ type:mime||"application/octet-stream" });
  fd.set("file", blob, "audio.webm");
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}` },
    body:fd
  });
  if(!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text||"").trim();
}

function extractAfter(text, regex){
  const m = text.match(regex);
  if(!m) return null;
  const after = text.slice(m[0].length).trim();
  return after.replace(/[.?!]+$/, "").slice(0, 120);
}

function handleAdminCommands(lower, original){
  // Director / Policy
  const dir = original.match(/^(?:director|policy)\s*[:\-]?\s*(.+)$/i);
  if (dir) { const content = dir[1].trim(); addDirective(content); return { say:`Director rule added: ${content}` }; }

  const forgetLastDir = lower.match(/^forget\s+last\s+directive$/i);
  if (forgetLastDir) { const n = removeLastDirective(); return { say: n ? "Removed the last directive." : "No directive to remove." }; }

  const forgetDir = original.match(/^forget\s+directive\s+(.+)$/i);
  if (forgetDir) { const n = removeDirectiveContaining(forgetDir[1].trim()); return { say: n ? `Removed ${n} directive${n>1?"s":""}.` : "No matching directives." }; }

  const resetDir = lower.match(/^(clear|reset)\s+directives$/i);
  if (resetDir) { clearDirectives(); return { say: "Cleared all directives." }; }

  // Updates / Static
  const upd = original.match(/^(?:update|announce|broadcast)\s*[:\-]?\s*(.+)$/i);
  if (upd) { const c = upd[1].trim(); addUpdate(c); return { say:`Update saved: ${c}` }; }

  const stat = original.match(/^(?:static|note|remember|long[-\s]*term)\s*[:\-]?\s*(.+)$/i);
  if (stat) { const c = stat[1].trim(); addStatic(c); return { say:`Saved to static info: ${c}` }; }

  const forgetLast = lower.match(/^forget\s+last(?:\s+(update|static|note))?$/i);
  if (forgetLast) { const kind = (forgetLast[1]||"").toLowerCase(); const removed = removeLast(kind); return { say: removed ? "Removed the last item." : "There wasn’t a last item to remove." }; }

  const forgetPhrase = original.match(/^forget\s+(.+)$/i);
  if (forgetPhrase) { const n = removeContaining(forgetPhrase[1].trim()); return { say: n ? `Removed ${n} item${n>1?"s":""}.` : "Nothing matched." }; }

  const clear = lower.match(/^(clear|reset)\s+(all|everything)$/i);
  if (clear) { clearAll(); return { say: "Cleared all updates, static info, directives, and docs." }; }

  return { say:"Admin ready. Say: “update: …”, “static: …”, or “director: …”. You can also say “forget …” or “clear all.”" };
}

function buildContext(hits){
  const ups = hits.updates.map(u => `• UPDATE: ${u.text}`).join("\n");
  const sts = hits.statics.map(s => `• STATIC: ${s.text}`).join("\n");
  const dcs = hits.docs.map(d => `• DOC (${d.name}): ${d.text.slice(0, 1000)}…`).join("\n");
  return [ups, sts, dcs].filter(Boolean).join("\n");
}

function buildSystem(){
  const base = (process.env.NORA_SYSTEM_PROMPT || `
You are Nora — a voice-first business assistant. Keep answers short. Priority:
DIRECTOR > UPDATES > STATIC > general. Add tiny audible receipts when using 1–3.
Interrupt only for unclear intent, missing info, safety, or off-track. Refuse med/legal/financial.
`).trim();

  const directives = listDirectives();
  const dirBlock = directives.length
    ? "BUSINESS DIRECTOR RULES:\n" + directives.slice(0, 20).map(d => `- ${d.text}`).join("\n")
    : "BUSINESS DIRECTOR RULES: none set.";

  const contract = `
Return STRICT JSON ONLY with this exact shape:
{
  "say": string,
  "tone": "neutral"|"cheerful"|"empathetic"|"serious",
  "can_interrupt": boolean,
  "max_speak_ms": number,
  "confidence": number,
  "receipt": string|null,
  "interrupt_now": boolean,
  "interrupt_reason": "unclear_intent"|"missing_info"|"safety"|"off_track"|null,
  "follow_up": string|null,
  "humor_level": number
}`.trim();

  return `${base}\n\n${dirBlock}\n\n${contract}`;
}

async function chatJSON(messages){
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`,{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL, temperature:0.35, max_tokens:360,
      response_format:{ type:"json_object" },
      messages
    })
  });
  if(!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || "{}";
  try{
    const out = JSON.parse(raw);
    return {
      say: String(out.say || "I’m here.").trim(),
      tone: (out.tone || DEFAULT_TONE).toLowerCase(),
      can_interrupt: !!out.can_interrupt,
      max_speak_ms: Math.max(2500, Math.min(12000, Number(out.max_speak_ms || 6500))),
      confidence: Math.max(0, Math.min(1, Number(out.confidence || 0.6))),
      receipt: out.receipt || null,
      interrupt_now: !!out.interrupt_now,
      interrupt_reason: out.interrupt_reason || null,
      follow_up: out.follow_up || null,
      humor_level: Math.max(0, Math.min(1, Number(out.humor_level || 0)))
    };
  }catch{
    return { say:"I’m here.", tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:6500, confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0 };
  }
}

async function ttsSafe(text, voice="shimmer", speed=1.05){
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model:"tts-1", voice, input:polish(text), response_format:"mp3", speed })
  });
  if(!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:audio/mp3;base64,${buf.toString("base64")}`;
}

function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 3600);
}

function reply(statusCode, data){ return { statusCode, headers:hdrs, body: JSON.stringify(data) }; }
