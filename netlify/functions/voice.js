import {
  addDirective, listDirectives, removeLastDirective, removeDirectiveContaining, clearDirectives,
  addUpdate, addStatic, removeLast, removeContaining, clearAll,
  searchRelevant, snapshot, getSettings, setAdminPass
} from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  return m || fallback;
})();
const STT_MODEL = "whisper-1";
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "shimmer"); // high-pitched/funky
const DEFAULT_TONE     = (process.env.DEFAULT_TONE || "neutral").toLowerCase();

const MAX_TURNS = 30;
const memoryStore = new Map();  // transcript history (optional)
const sessionState = new Map(); // admin mode per session

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

    // 1) STT
    const transcript = await transcribe(audio.data, audio.mime).catch(()=> "");
    if (!transcript.trim()) return speakText(200, sid, businessId, "I heard you, but the words were unclear—try again a touch closer to the mic.", { tone:DEFAULT_TONE, max_speak_ms:5000 });

    logHistory(sid, { role:"user", content:transcript });

    // 2) Route: admin mode vs employee
    const state = ensureSession(sid);
    let response;

    // a) Activation + password handling
    const lower = transcript.toLowerCase().trim();

    if (/^activate\b.*admin\b.*mode\b/.test(lower)) {
      const settings = getSettings(businessId);
      if (settings.adminPass) {
        state.awaitingPassword = true;
        return speakText(200, sid, businessId, "Speak the admin password.", { tone:"serious", max_speak_ms:4000 });
      } else {
        state.awaitingNewPass = true;
        return speakText(200, sid, businessId, "No admin password set. Say: “new password is …”.", { tone:"serious", max_speak_ms:5000 });
      }
    }

    if (state.awaitingPassword) {
      const ok = checkPasswordMatch(getSettings(businessId).adminPass, transcript);
      state.awaitingPassword = false;
      if (!ok) return speakText(200, sid, businessId, "That password didn’t match. Try “activate admin mode” again.", { tone:"serious", max_speak_ms:5000 });
      state.isAdmin = true;
      return speakText(200, sid, businessId, "Admin mode activated. You can say update, static, forget, or change admin password.", { tone:"serious", max_speak_ms:6000 });
    }

    if (/^change\b.*admin\b.*password\b/.test(lower)) {
      if (!state.isAdmin) return speakText(200, sid, businessId, "You need admin mode to change the password. Say “activate admin mode”.", { tone:"serious", max_speak_ms:6000 });
      state.awaitingNewPass = true;
      return speakText(200, sid, businessId, "Ready. Say: “new password is …”.", { tone:"serious", max_speak_ms:5000 });
    }

    if (state.awaitingNewPass) {
      const m = transcript.match(/new\s+password\s+is\s+(.+)/i);
      const pass = (m ? m[1] : transcript).trim();
      if (!pass || pass.length < 3) return speakText(200, sid, businessId, "Please say a longer password.", { tone:"serious", max_speak_ms:4000 });
      setAdminPass(businessId, pass);
      state.awaitingNewPass = false;
      state.isAdmin = true;
      return speakText(200, sid, businessId, "Admin password saved. You’re in admin mode.", { tone:"serious", max_speak_ms:5000 });
    }

    if (/^exit\b.*admin\b.*mode\b/.test(lower)) {
      state.isAdmin = false;
      return speakText(200, sid, businessId, "Exiting admin mode.", { tone:"neutral", max_speak_ms:3000 });
    }

    // b) Admin CRUD (only if admin)
    if (state.isAdmin) {
      const out = handleAdminCRUD(businessId, transcript);
      if (out) return speakText(200, sid, businessId, out, { tone:"serious", max_speak_ms:7000 });
      // fallthrough to normal Q&A if nothing matched
    }

    // c) Employee Q&A (or admin asking a question): director > updates > static > general
    const hits = searchRelevant(businessId, transcript, { kUpdates:3, kStatics:3 });
    const sys = buildSystemPrompt(businessId);
    const context = buildContext(hits);
    const messages = [
      { role:"system", content: sys + `\n\nCONTEXT (from business data):\n${context}` },
      ...getHistory(sid).map(m=>({ role:m.role, content:m.content })).slice(-MAX_TURNS*2),
      { role:"user", content: transcript }
    ];

    const out = await chatJSON(messages).catch(()=>({
      say:"I hit a snag. Mind asking that again?",
      tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
      confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0.0, save_note:null
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

// ---------- Speech-to-Text ----------
async function transcribe(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if (buf.length < 300) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language","en");
  fd.set("temperature","0.2");
  fd.set("prompt","Conversational business updates; user may pause or self-correct.");
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

// ---------- Admin CRUD ----------
function handleAdminCRUD(biz, original){
  const lower = original.toLowerCase().trim();

  const d = lower.match(/^(?:director|policy)\s*[:\-]?\s*(.+)$/i);
  if (d) { addDirective(biz, d[1]); return `Director rule added: ${d[1]}`; }

  const upd = lower.match(/^(?:update|announce|broadcast)\s*[:\-]?\s*(.+)$/i);
  if (upd){ addUpdate(biz, original.slice(upd.index).replace(/^(?:update|announce|broadcast)\s*[:\-]?\s*/i,"")); return "Update saved."; }

  const stat = lower.match(/^(?:static|note|remember)\s*[:\-]?\s*(.+)$/i);
  if (stat){ addStatic(biz, original.slice(stat.index).replace(/^(?:static|note|remember)\s*[:\-]?\s*/i,"")); return "Saved to static information."; }

  const forgetLast = lower.match(/^forget\s+last(?:\s+(update|static|note|directive))?$/i);
  if (forgetLast){ const k=(forgetLast[1]||"").toLowerCase(); const n=removeLast(biz, k); return n? "Removed the last item." : "There wasn’t a last item to remove."; }

  const forgetDir = lower.match(/^forget\s+directive\s+(.+)$/i);
  if (forgetDir){ const n = removeDirectiveContaining(biz, forgetDir[1]); return n? `Removed ${n} directive${n>1?"s":""}.` : "No matching directives."; }

  const forgetAny = lower.match(/^forget\s+(.+)$/i);
  if (forgetAny){ const n = removeContaining(biz, forgetAny[1]); return n? `Removed ${n} item${n>1?"s":""}.` : "Nothing matched."; }

  const resetDir = lower.match(/^(?:clear|reset)\s+directives$/i);
  if (resetDir){ clearDirectives(biz); return "Cleared all directives."; }

  const clear = lower.match(/^(?:clear|reset)\s+(?:all|everything)$/i);
  if (clear){ clearAll(biz); return "Cleared all updates, static info, and directives."; }

  return null;
}

// ---------- Q&A prompt ----------
function buildContext(hits){
  const ups = hits.updates.map(u => `• UPDATE: ${u.text}`).join("\n");
  const sts = hits.statics.map(s => `• STATIC: ${s.text}`).join("\n");
  return (ups || sts) ? [ups, sts].filter(Boolean).join("\n") : "No matching items.";
}

function buildSystemPrompt(biz){
  const userPrompt = (process.env.NORA_SYSTEM_PROMPT || "").trim();
  const base = userPrompt || `
You are Nora: a voice-first assistant for teams. You speak briefly, clearly, and stay strictly within the business’s own info.
Never remember personal details; do not build user profiles. You only use:
1) DIRECTOR rules (highest priority),
2) recent UPDATES,
3) long-term STATIC information.
If information conflicts, obey the higher layer. If you lack info, say so and invite the admin to add it via admin mode.
You may interrupt only for: unclear intent, missing critical info, safety concerns, or the user going off-topic. Keep interruptions to one crisp sentence.
End answers in 2–4 sentences. Provide tiny audible receipts when using Director/Update content (e.g., “Policy note” or “Today’s update”).
`.trim();

  const directives = listDirectives(biz);
  const dirBlock = directives.length
    ? "BUSINESS DIRECTOR RULES (override everything else):\n" + directives.slice(0, 12).map(d => `- ${d.text}`).join("\n")
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
  "save_note": string|null,
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
      model: CHAT_MODEL, temperature:0.35, max_tokens:320,
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
      save_note: out.save_note || null,
      interrupt_now: !!out.interrupt_now,
      interrupt_reason: out.interrupt_reason || null,
      follow_up: out.follow_up || null,
      humor_level: Math.max(0, Math.min(1, Number(out.humor_level || 0)))
    };
  }catch{
    return { say:"I’m here.", tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:6500, confidence:0.6, receipt:null, save_note:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0 };
  }
}

// ---------- TTS (OpenAI only) ----------
async function ttsOpenAI(text, tone, speed=1.0){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "tts-1",          // you can switch to "tts-1-hd" if you want
      voice: OPENAI_TTS_VOICE, // shimmer by default
      input: polish(text),
      speed: Math.max(0.7, Math.min(1.15, Number(speed) || 1.0)),
      response_format: "mp3"
    })
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

// ---------- Session/history ----------
function ensureSession(sid){
  if (!sessionState.has(sid)) sessionState.set(sid, { isAdmin:false, awaitingPassword:false, awaitingNewPass:false });
  return sessionState.get(sid);
}
function logHistory(sid, msg){
  const arr = memoryStore.get(sid) || [];
  arr.push({ ...msg, ts:Date.now() });
  memoryStore.set(sid, arr.slice(-MAX_TURNS*2));
}
function getHistory(sid){ return memoryStore.get(sid) || []; }

function checkPasswordMatch(saved, utterance){
  if (!saved) return false;
  const norm = s => String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  return norm(saved) === norm(utterance);
}

function reply(statusCode, data){ return { statusCode, headers:hdrs, body: JSON.stringify(data) }; }
