import { addUpdate, addStatic, removeLast, removeContaining, clearAll, searchRelevant, snapshot } from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  const banned = ["gpt-5-thinking","gpt5","thinking","demo"];
  return !m || banned.includes(m.toLowerCase()) ? fallback : m;
})();
const STT_MODEL = "whisper-1";

const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const DEFAULT_TONE    = (process.env.DEFAULT_TONE || "neutral").toLowerCase();
const ADMIN_CODE      = (process.env.ADMIN_VOICE_CODE || "").toLowerCase();

const MAX_TURNS = 30;
const memoryStore = new Map();
const deviceBrain = new Map();

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
    if (!businessId || !audio?.data || !audio?.mime) return { statusCode:400, headers:hdrs, body: JSON.stringify({ error:"Missing required information" }) };

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    if (memoryShadow && typeof memoryShadow === "object") mergeShadow(businessId, memoryShadow);

    // 1) STT
    const transcript = await transcribe(audio.data, audio.mime).catch(()=> "");
    if (!transcript.trim()) {
      return speakOrText(200, sid, ensureBrain(businessId), "I heard you, but the words were unclear—try again a touch closer to the mic.", meta(), true);
    }
    logTurn(businessId, sid, transcript, "user");

    // 2) Admin route (passphrase anywhere in the utterance)
    const lower = transcript.toLowerCase();
    if (ADMIN_CODE && lower.includes(ADMIN_CODE)) {
      const out = handleAdmin(lower, transcript);
      logTurn(businessId, sid, out.say, "assistant");
      return await speakOrText(200, sid, ensureBrain(businessId), out.say, { ...meta(), tone:"serious" }, false);
    }

    // 3) Employee Q&A: search voice-stored info (updates + statics)
    const hits = searchRelevant(transcript, { kUpdates:3, kStatics:3 });
    const context = buildContext(hits);
    const sys = buildSystemPrompt();
    const messages = [
      { role:"system", content: sys + `\n\nCONTEXT (from admin voice updates):\n${context}` },
      ...getHistory(sid).map(m=>({ role:m.role, content:m.content })),
      { role:"user", content: transcript }
    ];

    const out = await chatJSON(messages).catch(()=>({
      say:"I hit a snag. Mind asking that again?",
      tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
      confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0.0, save_note:null
    }));

    let sayNow = out.say;
    if (out.interrupt_now && out.follow_up){ sayNow = out.follow_up; }
    else if (out.receipt && out.receipt.trim()){ sayNow = `${sayNow.trim()}  ${out.receipt.trim()}`; }
    if (Number(out.humor_level||0) > 0.4) sayNow = injectTinyHumor(sayNow);

    logTurn(businessId, sid, sayNow, "assistant");
    return await speakOrText(200, sid, ensureBrain(businessId), sayNow, out, false);

  }catch(err){
    console.error("Handler error:", err);
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:`Internal server error: ${err.message}` }) };
  }
};

// ---------- STT ----------
async function transcribe(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if(buf.length<300) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language","en");
  fd.set("temperature","0.2");
  fd.set("prompt","Conversational voice; user may pause or self-correct.");
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

// ---------- Admin voice commands ----------
function handleAdmin(lower, original){
  // patterns:
  // "<PASS> update: ..." => addUpdate
  // "<PASS> static: ..." or "remember: ..." => addStatic
  // "<PASS> forget last (update|static|note)" => removeLast
  // "<PASS> forget ...<phrase>..." => removeContaining
  // "<PASS> clear all" => clearAll
  const PASS = ADMIN_CODE;

  const after = original.split(new RegExp(PASS, "i"))[1] || "";
  const text = after.replace(/^[:\-\s]+/, "");

  const upd = text.match(/^(update|announce|broadcast)\s*[:\-]?\s*(.+)$/i);
  if (upd) {
    const content = upd[2].trim();
    addUpdate(content);
    return { say: `Update saved: ${content}` };
  }

  const stat = text.match(/^(static|note|remember)\s*[:\-]?\s*(.+)$/i);
  if (stat) {
    const content = stat[2].trim();
    addStatic(content);
    return { say: `Saved to static info: ${content}` };
  }

  const forgetLast = text.match(/^forget\s+last(?:\s+(update|static|note))?$/i);
  if (forgetLast) {
    const kind = (forgetLast[1]||"").toLowerCase();
    const removed = removeLast(kind);
    return { say: removed ? "Removed the last item." : "There wasn’t a last item to remove." };
  }

  const forgetPhrase = text.match(/^forget\s+(.+)$/i);
  if (forgetPhrase) {
    const needle = forgetPhrase[1].trim();
    const n = removeContaining(needle);
    return { say: n ? `Removed ${n} item${n>1?"s":""} containing “${needle}”.` : `Nothing matched “${needle}”.` };
  }

  const clear = text.match(/^(clear|reset)\s+(all|everything)$/i);
  if (clear) {
    clearAll();
    return { say: "Cleared all updates and static info." };
  }

  // default: treat whatever follows as an update
  const fallback = text.trim();
  if (fallback) {
    addUpdate(fallback);
    return { say: `Update saved: ${fallback}` };
  }
  return { say: "Passphrase heard. Say “update: …” or “static: …”, or “forget …”." };
}

// ---------- Q&A helpers ----------
function buildContext(hits){
  const ups = hits.updates.map(u => `• UPDATE: ${u.text}`).join("\n");
  const sts = hits.statics.map(s => `• STATIC: ${s.text}`).join("\n");
  return (ups || sts) ? [ups, sts].filter(Boolean).join("\n") : "No matching items.";
}

function buildSystemPrompt(){
  const userPrompt = (process.env.NORA_SYSTEM_PROMPT || "").trim();
  const base = userPrompt || `
You are Nora, a voice-first assistant: clear, curious, lightly humorous (never snarky), and helpful.
Keep answers short (2–4 sentences). Start with the gist. No medical, legal, or financial advice—refuse briefly and suggest safe steps.
Interrupt only when helpful: unclear intent, missing info, safety, or off-track. One crisp follow-up, then pause.
Prioritize NEW updates over older static info when the two conflict. Cite the source as a tiny audible receipt when useful.
`;
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
}`;
  return `${base.trim()}\n\n${contract.trim()}`;
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

// ---------- TTS ----------
async function speakOrText(statusCode, sid, brain, say, meta, clientFallback){
  if (ELEVEN_API_KEY && ELEVEN_VOICE_ID) {
    try{
      const styleMap = { neutral:0.15, cheerful:0.4, empathetic:0.35, serious:0.2 };
      const style = styleMap[(meta?.tone||DEFAULT_TONE)] ?? 0.2;
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,{
        method:"POST",
        headers:{ "xi-api-key":ELEVEN_API_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
        body: JSON.stringify({
          text: polish(say),
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability:0.7, similarity_boost:0.8, style, use_speaker_boost:true },
          output_format: "mp3_44100_128"
        })
      });
      if(!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text().catch(()=>"(no body)")}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("tiny buffer");
      return reply(statusCode, {
        sessionId: sid, response: say, audio:`data:audio/mpeg;base64,${buf.toString("base64")}`,
        ttsEngine:"elevenlabs", tone:meta?.tone||DEFAULT_TONE,
        canInterrupt: !!meta?.can_interrupt, maxSpeakMs: Number(meta?.max_speak_ms || 6500),
        memoryShadow: brainSnapshot(brain)
      });
    }catch(e){
      // fall through to client TTS
    }
  }
  if (clientFallback) {
    return reply(statusCode, {
      sessionId: sid, response: say, sayText:say, clientTTS:true,
      ttsEngine:"client-speechSynthesis", tone:meta?.tone||DEFAULT_TONE,
      canInterrupt: !!meta?.can_interrupt, maxSpeakMs: Number(meta?.max_speak_ms || 6500),
      memoryShadow: brainSnapshot(brain)
    });
  }
  // final fallback
  return reply(statusCode, { sessionId:sid, response:say, memoryShadow: brainSnapshot(brain) });
}

function polish(t){
  t = String(t||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ");
  if (!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0, 3600);
}

// ---------- Brain (per-user convo) ----------
function ensureBrain(businessId){
  if(!deviceBrain.has(businessId)){
    deviceBrain.set(businessId,{ speed:0.95, items:[], conversations:[] });
  }
  const b = deviceBrain.get(businessId);
  if(!b.conversations) b.conversations=[];
  return b;
}
function logTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  brain.conversations.push({ role, content, ts:Date.now(), sessionId });
  if (brain.conversations.length > 1000) brain.conversations = brain.conversations.slice(-1000);
}
function getHistory(sessionId){
  const hist = memoryStore.get(sessionId) || [];
  return hist.slice(-MAX_TURNS*2);
}
function mergeShadow(businessId, shadow){
  const brain = ensureBrain(businessId);
  if(typeof shadow.pace === "number") brain.speed = Math.max(0.6, Math.min(1.1, shadow.pace));
}
function brainSnapshot(brain){ return { pace: brain.speed }; }
function meta(){ return { tone:DEFAULT_TONE, max_speak_ms:6500, can_interrupt:true }; }
function injectTinyHumor(say){
  const quips = [
    "Short and sweet—like a good handoff.",
    "I’ll keep it tight.",
    "No TED Talk, promise."
  ];
  return say.split(/\s+/).length > 60 ? say : `${say}  ${quips[Math.floor(Math.random()*quips.length)]}`;
}
function reply(statusCode, data){
  return { statusCode, headers:hdrs, body: JSON.stringify(data) };
}
