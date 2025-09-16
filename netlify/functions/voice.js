// Nora — Voice Assistant (Your prompt via NORA_SYSTEM_PROMPT + ElevenLabs TTS, client TTS fallback)
// - STT: OpenAI Whisper
// - Chat: OpenAI (JSON out with tone/turn-taking)
// - TTS: ElevenLabs only; if unavailable, server returns {clientTTS:true, sayText:"..."}
// - Memory: tiny consent-first notes
//
// ==== REQUIRED ENV ====
// OPENAI_API_KEY
// ELEVENLABS_API_KEY
// ELEVENLABS_VOICE_ID
//
// ==== OPTIONAL ENV ====
// OPENAI_MODEL           (default: gpt-4o-mini)  <-- use a real model name; not "gpt-5-thinking"
// NORA_SYSTEM_PROMPT     (your long prompt string)
// OPENAI_TTS_VOICE       (unused here; we don't call OpenAI TTS)
// DEFAULT_TONE           (neutral|cheerful|empathetic|serious; default neutral)

const OPENAI_ROOT = "https://api.openai.com/v1";

// ---- Models ----
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  if (!m) return fallback;
  const banned = ["gpt-5-thinking", "gpt5", "thinking", "demo"];
  if (banned.includes(m.toLowerCase())) return fallback;
  return m;
})();
const CHAT_FALLBACKS = ["gpt-4o", "gpt-4o-mini"];
const STT_MODEL = "whisper-1";

// ---- ElevenLabs ----
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

// ---- Defaults / behavior ----
const DEFAULT_SPEED = 0.95;
const DEFAULT_TONE  = (process.env.DEFAULT_TONE || "neutral").toLowerCase(); // neutral|cheerful|empathetic|serious
const MAX_TURNS = 30;
const MAX_MEMORY_ITEMS = 2000;

// ---- In-memory state (per lambda instance) ----
const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

// ---- Utilities ----
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const safeJson = (s)=>{ try{return JSON.parse(s);}catch{return null;} };
const ext = (m)=>!m?".wav": m.includes("wav")?".wav": m.includes("mp3")?".mp3": m.includes("mp4")?".mp4": m.includes("webm")?".webm": m.includes("ogg")?".ogg":".wav";
const reply = (code,data,headers)=>({ statusCode:code, headers, body:JSON.stringify(data) });
const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST, OPTIONS, GET",
  "Cache-Control":"no-cache"
};
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function tokenize(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }
function pruneMap(map,max){ if(map.size<=max) return; const keys=[...map.keys()]; for(let i=0;i<map.size-max;i++) map.delete(keys[i]); }

// ---- Micro "brain" ----
function ensureBrain(businessId){
  if(!deviceBrain.has(businessId)){
    deviceBrain.set(businessId,{ speed:DEFAULT_SPEED, items:[], conversations:[] });
  }
  const b = deviceBrain.get(businessId);
  if(!b.conversations) b.conversations=[];
  return b;
}
function makeItem(type,text,extra={}){ return { id:uid(), type, text:String(text||"").trim(), createdAt:Date.now(), updatedAt:Date.now(), tags:[], confidence:1.0, ...extra }; }
function indexItem(it){ brainVectors.set(it.id, new Set(tokenize(it.text))); }
function isDuplicate(items,newText){
  const a = new Set(tokenize(newText));
  return items.some(it=>{
    const b = new Set(tokenize(it.text));
    let overlap=0; for(const t of a) if(b.has(t)) overlap++;
    const sim = overlap / Math.min(a.size, b.size||1);
    return sim>0.75;
  });
}
function scoreItems(items,query){
  const q = new Set(tokenize(query));
  const now=Date.now();
  return items.map(it=>{
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap=0; for(const t of q) if(w.has(t)) overlap++;
    const recency = 1 / Math.max(1, (now - (it.updatedAt||it.createdAt)) / (1000*60*60*24));
    const confidence = it.confidence || 0.5;
    const typeBoost = it.type==="contact"?0.3 : it.type==="note"?0.1 : 0;
    return { ...it, _score: overlap + recency*0.2 + confidence*0.4 + typeBoost };
  }).sort((a,b)=>b._score-a._score);
}

// ---- System prompt wiring ----
function buildSystemPrompt(){
  const userPrompt = (process.env.NORA_SYSTEM_PROMPT || "").trim();
  const base = userPrompt || `
You are Nora, a voice-first assistant. Be clear, short (2–4 sentences), practical, friendly.
Never give medical, legal, or financial advice; refuse briefly and suggest safe next steps.
Use consent-first memory: only save notes if the user asks to "remember", "save", or "note".
When you used a source or you are uncertain, be transparent in one short clause.`;

  // We append a strict JSON contract so your app can drive tone/turn-taking/TTS reliably.
  const contract = `
Return STRICT JSON ONLY:
{
  "say": string,                          // 2–4 short sentences to speak
  "tone": "neutral"|"cheerful"|"empathetic"|"serious",
  "can_interrupt": boolean,               // allow barge-in without losing coherence
  "max_speak_ms": number,                 // cap TTS playback, e.g., 6500
  "confidence": number,                   // 0.0 – 1.0 self-estimate
  "receipt": string|null,                 // tiny audible source tag or null
  "save_note": string|null                // note text to store or null
}
Self-check: inside scope? concise? valid JSON only.`;

  return `${base.trim()}\n\n${contract.trim()}`;
}

// ---- Handler ----
exports.handler = async (event)=>{
  try{
    if(event.httpMethod==="OPTIONS") return reply(200,{ok:true},hdrs);
    if(event.httpMethod==="GET")     return reply(200,{message:"Nora Voice OK", ts:new Date().toISOString()},hdrs);
    if(event.httpMethod!=="POST")    return reply(405,{error:"Method Not Allowed"},hdrs);
    if(!process.env.OPENAI_API_KEY)  return reply(500,{error:"OPENAI_API_KEY not configured"},hdrs);

    const body = safeJson(event.body);
    if(!body) return reply(400,{error:"Invalid JSON body"},hdrs);
    const { businessId, sessionId, audio, memoryShadow } = body;
    if(!businessId || !audio?.data || !audio?.mime) return reply(400,{error:"Missing required information"},hdrs);

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    if(memoryShadow && typeof memoryShadow==="object") mergeShadow(businessId, memoryShadow);
    const brain = ensureBrain(businessId);

    // 1) STT
    let transcript="";
    try{
      transcript = await withRetry(()=>transcribe(audio.data, audio.mime), 2);
    }catch(e){
      return speakOrText(200, sid, brain, "Sorry—I couldn’t catch that. Try a little closer to the mic.", null, true);
    }
    if(!(transcript||"").trim()){
      return speakOrText(200, sid, brain, "I heard audio but not the words. Could you repeat that?", null, true);
    }
    logTurn(businessId, sid, transcript, "user");

    // 2) Quick intents (notes)
    const fast = routeIntent(businessId, transcript);
    if(fast){
      logTurn(businessId, sid, fast.say, "assistant");
      return await speakOrText(200, sid, brain, fast.say, { tone: DEFAULT_TONE, max_speak_ms:6500, can_interrupt:true }, false);
    }

    // 3) Chat (JSON out)
    const out = await chatJSONWithMemory(sid, businessId, transcript)
      .catch(()=>({ say:"I hit a snag. Mind asking that again?", tone: DEFAULT_TONE, can_interrupt:true, max_speak_ms:6500, confidence:0.6, receipt:null, save_note:null }));

    if (out.save_note) addNoteToMemory(businessId, out.save_note);

    logTurn(businessId, sid, out.say, "assistant");

    // 4) TTS (ElevenLabs) or client fallback
    return await speakOrText(200, sid, brain, out.say, out, false);

  }catch(err){
    console.error("Handler error:", err);
    return reply(500,{ error:`Internal server error: ${err.message}` },hdrs);
  }
};

// ---- STT (OpenAI Whisper) ----
async function transcribe(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if(buf.length<300) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language","en");
  fd.set("temperature","0.2");
  fd.set("prompt","Casual assistant conversation. The user may pause.");
  const blob = new Blob([buf],{ type:mime||"application/octet-stream" });
  fd.set("file", blob, "audio"+ext(mime));

  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}` },
    body:fd
  });
  if(!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text||"").trim();
}

// ---- Intents (remember/forget) ----
function routeIntent(businessId, text){
  const lower = String(text||"").toLowerCase().trim();
  if (/^(remember|note|save)\s+/.test(lower)){
    const body = text.replace(/^(remember|note|save)\s+/i,"").trim();
    addNoteToMemory(businessId, body);
    return { say: "Saved." };
  }
  if (/^forget\s+last\s+note/.test(lower)){
    const b = ensureBrain(businessId);
    const lastIdx = [...b.items].reverse().findIndex(i=>i.type==="note");
    if (lastIdx >= 0) b.items.splice(b.items.length-1-lastIdx, 1);
    return { say: "Okay, removed the last note." };
  }
  return null;
}

function addNoteToMemory(businessId, text){
  const b = ensureBrain(businessId);
  const item = makeItem("note", text, { tags: ["note"], confidence: 1.0, expiresAt: Date.now() + 30*24*60*60*1000 }); // 30-day TTL
  if(!isDuplicate(b.items, item.text)){ b.items.push(item); indexItem(item); pruneMemoryItems(b); }
}

// ---- Chat (JSON contract) ----
async function chatJSONWithMemory(sessionId, businessId, userText){
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role:"user", content:userText, ts:Date.now() });
  const trimmed = hist.slice(-MAX_TURNS*2);
  memoryStore.set(sessionId, trimmed);

  const brain = ensureBrain(businessId);
  const saved = brain.items.slice(-20).map(i=>{
    if(i.type==="note") return `- Note: ${i.text.slice(0,180)}`;
    return `- ${i.type}: ${i.text.slice(0,180)}`;
  }).join("\n") || "No saved info yet.";

  const relevant = scoreItems(brain.items, userText).slice(0,6);
  const relevantBlock = relevant.length ? ("\nRelevant:\n" + relevant.map(i=>`- ${i.text.slice(0,200)}`).join("\n")) : "";

  const system = {
    role:"system",
    content: buildSystemPrompt() + `

Saved info:
${saved}
${relevantBlock}`
  };

  const messages = [system, ...trimmed.map(m=>({ role:m.role, content:m.content }))];

  const order = [CHAT_MODEL, ...CHAT_FALLBACKS.filter(m=>m!==CHAT_MODEL)];
  let lastErr;
  for(const model of order){
    try{
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`,{
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({
          model, temperature:0.35, max_tokens:260,
          response_format:{ type:"json_object" },
          messages
        })
      });
      if(!res.ok){ lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); continue; }
      const json = await res.json();
      const raw = json.choices?.[0]?.message?.content || "{}";
      const out = safeJson(raw) || {};
      const say = String(out.say || "").trim() || "I’m here.";
      const tone = (out.tone || DEFAULT_TONE).toLowerCase();
      const can_interrupt = !!out.can_interrupt;
      const max_speak_ms = Math.max(2500, Math.min(12000, Number(out.max_speak_ms || 6500)));
      const confidence = Math.max(0, Math.min(1, Number(out.confidence || 0.6)));
      const receipt = out.receipt || null;
      const save_note = out.save_note || null;

      trimmed.push({ role:"assistant", content:say, ts:Date.now() });
      memoryStore.set(sessionId, trimmed); pruneMap(memoryStore, 50);

      return { say, tone, can_interrupt, max_speak_ms, confidence, receipt, save_note };
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---- TTS (ElevenLabs) or client fallback ----
async function speakOrText(statusCode, sid, brain, say, meta, softFallback){
  // Try ElevenLabs first if configured
  const wantEleven = ELEVEN_API_KEY && ELEVEN_VOICE_ID;
  if (wantEleven){
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
      if(!res.ok){ throw new Error(`ElevenLabs ${res.status}: ${await res.text().catch(()=>"(no body)")}`); }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error("ElevenLabs tiny buffer");

      return reply(statusCode, {
        sessionId: sid,
        transcript: undefined,
        response: say,
        tone: meta?.tone || DEFAULT_TONE,
        audio: `data:audio/mpeg;base64,${buf.toString("base64")}`,
        ttsEngine: "elevenlabs",
        canInterrupt: !!meta?.can_interrupt,
        maxSpeakMs: Number(meta?.max_speak_ms || 6500),
        receipt: meta?.receipt || null,
        memoryShadow: brainSnapshot(brain)
      }, hdrs);
    }catch(e){
      // fall through to client TTS
      console.warn("ElevenLabs failed; falling back to client TTS:", e.message);
    }
  }

  // Client TTS fallback (no server audio)
  return reply(statusCode, {
    sessionId: sid,
    response: say,
    ttsEngine: "client-speechSynthesis",
    clientTTS: true,
    sayText: say,
    tone: meta?.tone || DEFAULT_TONE,
    canInterrupt: !!meta?.can_interrupt,
    maxSpeakMs: Number(meta?.max_speak_ms || 6500),
    receipt: meta?.receipt || null,
    memoryShadow: brainSnapshot(brain)
  }, hdrs);
}

function polish(text){
  let t = String(text||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ").replace(/\s{3,}/g,"  ");
  if(!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0,3600);
}

// ---- Memory helpers ----
function logTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if(!brain.conversations) brain.conversations=[];
  brain.conversations.push({ id:uid(), sessionId, role, content, timestamp:Date.now() });
  if(brain.conversations.length>1000) brain.conversations = brain.conversations.slice(-1000);
  if(role==="user") autoExtract(businessId, content);
}

function autoExtract(businessId, text){
  const m = String(text||"").match(/\b(?:remember|note)\s+([^.,;!?]+)[.,;!?]?/i);
  if(m){ addNoteToMemory(businessId, m[1].trim()); }
}

function pruneMemoryItems(brain){
  if(brain.items.length<=MAX_MEMORY_ITEMS) return;
  const scored = brain.items.map(item=>{
    let score = item.confidence||0.5;
    const age = Date.now() - (item.updatedAt||item.createdAt);
    const days = age/(1000*60*60*24);
    if(item.type==="contact") score+=0.3;
    if(item.type==="note") score+=0.1;
    score += Math.max(0, 0.1 - (days*0.001));
    return { ...item, _pruneScore:score };
  }).sort((a,b)=>b._pruneScore-a._pruneScore);
  const toRemove = scored.slice(MAX_MEMORY_ITEMS);
  toRemove.forEach(it=>brainVectors.delete(it.id));
  brain.items = scored.slice(0,MAX_MEMORY_ITEMS);
}

function mergeShadow(businessId, shadow){
  const brain = ensureBrain(businessId);
  if(typeof shadow.pace === "number") brain.speed = Math.max(0.6, Math.min(1.1, shadow.pace));
  if(Array.isArray(shadow.items)){
    const byId = new Map(brain.items.map(i=>[i.id,i]));
    for(const it of shadow.items){
      if(!it || !it.text) continue;
      if(!it.id || !byId.has(it.id)){
        const newItem = { ...it, id:it.id||uid(), createdAt:it.createdAt||Date.now(), updatedAt:it.updatedAt||Date.now() };
        brain.items.push(newItem); indexItem(newItem);
      }
    }
  }
  if(Array.isArray(shadow.conversations)){
    if(!brain.conversations) brain.conversations=[];
    shadow.conversations.forEach(conv=>{
      if(conv && conv.content && !brain.conversations.find(c=>c.id===conv.id)){
        brain.conversations.push({ ...conv, id:conv.id||uid(), timestamp:conv.timestamp||Date.now() });
      }
    });
    brain.conversations.sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  }
}

function brainSnapshot(brain){
  return { items: brain.items, conversations: brain.conversations||[], pace: brain.speed };
}

// ---- Retry ----
async function withRetry(fn,n){
  try{ return await fn(); }
  catch(e){ if(n<=0 || !isTransient(e)) throw e; await sleep(250); return withRetry(fn,n-1); }
}
function isTransient(e){
  return /429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message||""));
}
