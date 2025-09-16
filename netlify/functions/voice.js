import {
  addDirective, listDirectives, removeDirectiveContaining, clearDirectives,
  addUpdate, addStatic, removeLast, removeContaining, clearAll,
  searchRelevant, snapshot
} from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const STT_MODEL = "whisper-1";
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "shimmer");
const DEFAULT_TONE = (process.env.DEFAULT_TONE || "neutral").toLowerCase();

const MAX_TURNS = 30;
const memoryStore = new Map();
const sessionState = new Map();

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
    if (event.httpMethod === "GET")     return { statusCode:200, headers:hdrs, body: JSON.stringify({ message:"Nora OK", ts:new Date().toISOString() }) };
    if (event.httpMethod !== "POST")    return { statusCode:405, headers:hdrs, body: JSON.stringify({ error:"Method Not Allowed" }) };
    if (!process.env.OPENAI_API_KEY)    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:"OPENAI_API_KEY not configured" }) };

    const body = JSON.parse(event.body || "{}");
    const { businessId, sessionId, audio } = body;
    if (!businessId) return reply(400, { error:"Missing businessId" });
    if (!audio?.data || !audio?.mime) return reply(400, { error:"Missing audio" });

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    // STT
    const transcript = await transcribe(audio.data, audio.mime).catch(()=> "");
    if (!transcript.trim())
      return speakText(200, sid, businessId, "I heard you, but I couldn’t catch the words—try a touch closer to the mic.", { tone:DEFAULT_TONE, max_speak_ms:5000 });

    logHistory(sid, { role:"user", content:transcript });

    const state = ensureSession(sid);
    const lower = transcript.toLowerCase().trim();

    // === Simple role entry: say "admin" to enter admin mode ===
    if (/^admin$/.test(lower) || /^(?:i'?m|i am)\s+admin$/.test(lower)) {
      state.isAdmin = true;
      return speakText(200, sid, businessId, "Admin mode on. Say update, static, or policy. You can also say forget last or clear all.", { tone:"serious", max_speak_ms:7000 });
    }
    if (/^employee$/.test(lower) || /\bemployee\b/.test(lower)) {
      state.isAdmin = false;
      return speakText(200, sid, businessId, "Got it. I’ll share updates when there are any. Ask about schedules, policies, or files the admin uploaded.", { tone:"neutral", max_speak_ms:7500 });
    }
    if (/^exit\b.*admin\b.*mode\b/.test(lower)) {
      state.isAdmin = false;
      return speakText(200, sid, businessId, "Exiting admin mode.", { tone:"neutral", max_speak_ms:3000 });
    }

    // === Admin CRUD (voice commands) ===
    if (state.isAdmin) {
      const out = handleAdminCRUD(businessId, transcript);
      if (out) return speakText(200, sid, businessId, out, { tone:"serious", max_speak_ms:7000 });
    }

    // === Employee Q&A ===
    const hits = searchRelevant(businessId, transcript, { kUpdates:3, kStatics:3, kDocs:3 });
    const sys = buildSystemPrompt(businessId);
    const context = buildContext(hits);
    const messages = [
      { role:"system", content: sys + `\n\nCONTEXT:\n${context}` },
      ...getHistory(sid).map(m=>({ role:m.role, content:m.content })).slice(-MAX_TURNS*2),
      { role:"user", content: transcript }
    ];

    const out = await chatJSON(messages).catch(()=>({
      say:"I hit a snag. Mind asking that again?",
      tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
      confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0
    }));

    let sayNow = out.say;
    if (out.interrupt_now && out.follow_up) sayNow = out.follow_up;
    else if (out.receipt && out.receipt.trim()) sayNow = `${sayNow.trim()}  ${out.receipt.trim()}`;

    logHistory(sid, { role:"assistant", content:sayNow });
    return speakText(200, sid, businessId, sayNow, out);

  }catch(err){
    console.error("voice handler error:", err);
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:`Internal server error: ${err.message}` }) };
  }
};

// STT
async function transcribe(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if (buf.length < 300) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language","en");
  fd.set("temperature","0.2");
  fd.set("prompt","Team updates; user may say admin or employee.");
  const blob = new Blob([buf],{ type:mime || "application/octet-stream" });
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

// Admin CRUD helpers
function handleAdminCRUD(biz, original){
  const lower = original.toLowerCase().trim();

  const d = lower.match(/^(?:policy|director)\s*[:\-]?\s*(.+)$/i);
  if (d) { addDirective(biz, original.slice(d.index).replace(/^(?:policy|director)\s*[:\-]?\s*/i,"")); return "Policy saved."; }

  const upd = lower.match(/^(?:update|announce|broadcast)\s*[:\-]?\s*(.+)$/i);
  if (upd){ addUpdate(biz, original.slice(upd.index).replace(/^(?:update|announce|broadcast)\s*[:\-]?\s*/i,"")); return "Update saved."; }

  const stat = lower.match(/^(?:static|note|remember)\s*[:\-]?\s*(.+)$/i);
  if (stat){ addStatic(biz, original.slice(stat.index).replace(/^(?:static|note|remember)\s*[:\-]?\s*/i,"")); return "Saved to static information."; }

  const forgetLast = lower.match(/^forget\s+last(?:\s+(update|static|note|directive|policy))?$/i);
  if (forgetLast){ const k=(forgetLast[1]||"").toLowerCase().replace("policy","directive"); const n=removeLast(biz, k); return n? "Removed the last item." : "There wasn’t a last item to remove."; }

  const forgetDir = lower.match(/^forget\s+(?:policy|directive)\s+(.+)$/i);
  if (forgetDir){ const n = removeDirectiveContaining(biz, forgetDir[1]); return n? `Removed ${n} directive${n>1?"s":""}.` : "No matching policies."; }

  const forgetAny = lower.match(/^forget\s+(.+)$/i);
  if (forgetAny){ const n = removeContaining(biz, forgetAny[1]); return n? `Removed ${n} item${n>1?"s":""}.` : "Nothing matched."; }

  const resetDir = lower.match(/^(?:clear|reset)\s+(?:policies|directives)$/i);
  if (resetDir){ clearDirectives(biz); return "Cleared all policies."; }

  const clear = lower.match(/^(?:clear|reset)\s+(?:all|everything)$/i);
  if (clear){ clearAll(biz); return "Cleared all updates, static info, policies, and docs."; }

  return null;
}

function buildContext(hits){
  const ups = hits.updates.map(u => `• UPDATE: ${u.text}`).join("\n");
  const sts = hits.statics.map(s => `• STATIC: ${s.text}`).join("\n");
  const dvs = hits.docs.map(d => `• DOC: ${d.name} — ${d._snippet}`).join("\n");
  return [ups, sts, dvs].filter(Boolean).join("\n") || "No matching items.";
}
function buildSystemPrompt(biz){
  const userPrompt = (process.env.NORA_SYSTEM_PROMPT || "").trim();
  const base = userPrompt || `
You are Nora: a voice-first assistant for teams. Speak briefly (2–4 sentences), clearly, and use ONLY the business’s own data:
1) POLICIES/DIRECTIVES (highest),
2) recent UPDATES,
3) long-term STATIC info,
4) FILE DOCS (snippets).
If info conflicts, obey higher layer. If you lack info, say so and invite the admin to add it or upload files via the plus button.
No personal memory. Interrupt only for unclear intent, missing critical info, safety, or off-topic (one sentence, then pause).
When relying on a Policy/Update/Doc, add a tiny audible receipt like “Policy note” or “From the file”.`.trim();

  const dirBlock = listDirectives(biz).slice(0,12).map(d=>`- ${d.text}`).join("\n") || "none set.";

  const contract = `
Return STRICT JSON ONLY with:
{
  "say": string,
  "tone": "neutral"|"cheerful"|"empathetic"|"serious",
  "can_interrupt": boolean,
  "max_speak_ms": number,
  "confidence": number,
  "receipt": string|null,
  "save_note": string|null,
  "interrupt_now": boolean,
  "interrupt_reason": "unclear_intent"|"missing_info"|"safety"|"off_track"|null,
  "follow_up": string|null,
  "humor_level": number
}`.trim();

  return `${base}\n\nBUSINESS POLICIES:\n${dirBlock}\n\n${contract}`;
}
async function chatJSON(messages){
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`,{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL, temperature:0.35, max_tokens:320,
      response_format:{ type:"json_object" },
      messages
    })
  });
  if(!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const raw = j.choices?.[0]?.message?.content || "{}";
  try{
    const o = JSON.parse(raw);
    return {
      say: String(o.say||"I’m here.").trim(),
      tone: (o.tone||DEFAULT_TONE).toLowerCase(),
      can_interrupt: !!o.can_interrupt,
      max_speak_ms: Math.max(2500, Math.min(12000, Number(o.max_speak_ms||6500))),
      confidence: Math.max(0, Math.min(1, Number(o.confidence||0.6))),
      receipt: o.receipt||null, save_note: o.save_note||null,
      interrupt_now: !!o.interrupt_now, interrupt_reason: o.interrupt_reason||null,
      follow_up: o.follow_up||null, humor_level: Math.max(0, Math.min(1, Number(o.humor_level||0)))
    };
  }catch{
    return { say:"I’m here.", tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:6500, confidence:0.6, receipt:null, save_note:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0 };
  }
}

// TTS
async function ttsOpenAI(text, tone, speed=1.0){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model:"tts-1", voice: OPENAI_TTS_VOICE, input: polish(text), speed: Math.max(0.7, Math.min(1.15, Number(speed)||1.0)), response_format:"mp3" })
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer());
  return `data:audio/mpeg;base64,${b.toString("base64")}`;
}
async function speakText(statusCode, sid, biz, say, meta){
  const dataUrl = await ttsOpenAI(say, meta?.tone || DEFAULT_TONE, 1.0).catch(()=>null);
  return reply(statusCode, {
    sessionId: sid,
    response: say,
    audio: dataUrl || null,
    ttsEngine: "openai-tts-1",
    tone: meta?.tone || DEFAULT_TONE,
    canInterrupt: !!meta?.can_interrupt,
    maxSpeakMs: Number(meta?.max_speak_ms || 6500),
    store: snapshot(biz)
  });
}
function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 3600);
}

// Session/history
function ensureSession(sid){
  if (!sessionState.has(sid)) sessionState.set(sid, { isAdmin:false });
  return sessionState.get(sid);
}
function logHistory(sid, msg){
  const arr = memoryStore.get(sid) || [];
  arr.push({ ...msg, ts:Date.now() });
  memoryStore.set(sid, arr.slice(-MAX_TURNS*2));
}
function getHistory(sid){ return memoryStore.get(sid) || []; }
function reply(statusCode, data){ return { statusCode, headers:hdrs, body: JSON.stringify(data) }; }
