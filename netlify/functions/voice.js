// Nora — Purposeful Interruptions + Humor + Growth + Configurable Memory
// - STT: OpenAI Whisper
// - Chat: OpenAI (STRICT JSON w/ interruption + tone + humor)
// - TTS: ElevenLabs only; client SpeechSynthesis fallback if TTS fails
// - Memory: consent-first or always-on (env switch), with optional TTL

const OPENAI_ROOT = "https://api.openai.com/v1";

// ---- Models ----
const CHAT_MODEL = (() => {
  const fallback = "gpt-4o-mini";
  const m = (process.env.OPENAI_MODEL || "").trim();
  if (!m) return fallback;
  const banned = ["gpt-5-thinking","gpt5","thinking","demo"];
  if (banned.includes(m.toLowerCase())) return fallback;
  return m;
})();
const CHAT_FALLBACKS = ["gpt-4o", "gpt-4o-mini"];
const STT_MODEL = "whisper-1";

// ---- ElevenLabs ----
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

// ---- Behavior + Memory ----
const DEFAULT_TONE  = (process.env.DEFAULT_TONE || "neutral").toLowerCase(); // neutral|cheerful|empathetic|serious
const DEFAULT_SPEED = 0.95;
const MEMORY_MODE   = (process.env.NORA_MEMORY_MODE || "consent").toLowerCase(); // 'consent' | 'always'
const TTL_DAYS_ENV  = process.env.NORA_MEMORY_TTL_DAYS;
const MEMORY_TTL_MS = TTL_DAYS_ENV ? Math.max(1, parseInt(TTL_DAYS_ENV,10)) * 24*60*60*1000
                                   : (MEMORY_MODE === "always" ? null : 30*24*60*60*1000); // default: 30d in consent mode

const MAX_TURNS = 30;
const MAX_MEMORY_ITEMS = 4000;

// ---- State (per lambda instance) ----
const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

// ---- Utils ----
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
  const q = new Set(tokenize(query)); const now=Date.now();
  return items.map(it=>{
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap=0; for(const t of q) if(w.has(t)) overlap++;
    const recency = 1 / Math.max(1, (now - (it.updatedAt||it.createdAt)) / (1000*60*60*24));
    const confidence = it.confidence || 0.5;
    const typeBoost = it.type==="profile"?0.35 : it.type==="preference"?0.25 : it.type==="note"?0.1 : 0;
    return { ...it, _score: overlap + recency*0.2 + confidence*0.4 + typeBoost };
  }).sort((a,b)=>b._score-a._score);
}

// ---- System Prompt ----
function buildSystemPrompt(){
  const userPrompt = (process.env.NORA_SYSTEM_PROMPT || "").trim();
  const base = userPrompt || `
You are Nora, a voice-first assistant. You are clear, genuinely curious, lightly humorous (never snarky), and helpful.
You keep answers short (2–4 sentences). Start with the gist. No medical, legal, or financial advice—refuse briefly and propose safe next steps.
You interrupt with purpose only when needed: (1) intent is unclear, (2) info is missing to complete a task, (3) a safety concern or contradiction appears, (4) the user seems off-track from their stated goal.
When you interrupt, do it kindly: one crisp question or fix, then wait.

MEMORY
- If mode is "consent": store only when the user says remember/save/note or when save_note is provided.
- If mode is "always": extract helpful facts (preferences, names, birthdays, “call me…”, recurring plans) from natural talk and store them.
- Summarize recall in ≤3 bullets when asked.

HUMOR
- Use light, situational humor when humor_level > 0.4. One quick line max. Never punch down.

RECENCY
- If time-sensitive or uncertain, admit it and ask a tiny clarifier before proceeding, or provide a safe partial answer.

DIFFERENTIATORS
- Mirror → Counter → Synthesis in opinionated topics (short, constructive).
- Audible receipts: if you used an external source or are uncertain, set a short receipt like "Source: manufacturer site, today."
`;

  const contract = `
Return STRICT JSON ONLY with this exact shape:
{
  "say": string,                          // 2–4 short sentences to speak
  "tone": "neutral"|"cheerful"|"empathetic"|"serious",
  "can_interrupt": boolean,               // allow user barge-in without losing coherence
  "max_speak_ms": number,                 // e.g., 6500
  "confidence": number,                   // 0.0–1.0
  "receipt": string|null,                 // tiny audible source tag
  "save_note": string|null,               // text to store or null
  "interrupt_now": boolean,               // true if Nora should interject before a full answer
  "interrupt_reason": "unclear_intent"|"missing_info"|"safety"|"off_track"|null,
  "follow_up": string|null,               // the one short clarifying question or correction
  "humor_level": number                   // 0.0–1.0; >0.4 enables a gentle quip
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
      return speakOrText(200, sid, brain, "Sorry—I couldn’t catch that. Try a little closer to the mic.", {tone:DEFAULT_TONE,max_speak_ms:4500,can_interrupt:true}, true);
    }
    if(!(transcript||"").trim()){
      return speakOrText(200, sid, brain, "I heard audio but not the words. Could you repeat that?", {tone:DEFAULT_TONE,max_speak_ms:4500,can_interrupt:true}, true);
    }
    logTurn(businessId, sid, transcript, "user");

    // 2) Memory mode: opportunistic extraction for ALWAYS
    if (MEMORY_MODE === "always") autoExtractProfile(businessId, transcript);

    // 3) Quick intents (explicit notes / forget)
    const fast = routeIntent(businessId, transcript);
    if(fast){
      logTurn(businessId, sid, fast.say, "assistant");
      return await speakOrText(200, sid, brain, fast.say, { tone: DEFAULT_TONE, max_speak_ms:6500, can_interrupt:true }, false);
    }

    // 4) Chat (JSON out)
    const out = await chatJSONWithMemory(sid, businessId, transcript)
      .catch(()=>({
        say:"I hit a snag. Mind asking that again?",
        tone: DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
        confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0.0, save_note:null
      }));

    if (out.save_note) addNoteToMemory(businessId, out.save_note);

    // If purposeful interruption is requested, speak only the follow_up (short) now
    let sayNow = out.say;
    if (out.interrupt_now && out.follow_up){
      sayNow = out.follow_up;
    } else {
      // Optionally append tiny receipt
      if (out.receipt && out.receipt.trim()){
        sayNow = `${sayNow.trim()}  ${out.receipt.trim()}`;
      }
      // Gentle humor if asked for
      if (Number(out.humor_level||0) > 0.4){
        sayNow = injectTinyHumor(sayNow);
      }
    }

    logTurn(businessId, sid, sayNow, "assistant");
    return await speakOrText(200, sid, brain, sayNow, out, false);

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
  fd.set("prompt","Conversational voice; user may pause or self-correct.");
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

// ---- Intents (notes/forget) ----
function routeIntent(businessId, text){
  const lower = String(text||"").toLowerCase().trim();
  if (/^(remember|note|save)\s+/.test(lower)){
    const body = text.replace(/^(remember|note|save)\s+/i,"").trim();
    addNoteToMemory(businessId, body);
    return { say: "Saved." };
  }
  if (/^forget\s+last\s+note/.test(lower)){
    const b = ensureBrain(businessId);
    const last = [...b.items].reverse().find(i=>i.type==="note");
    if (last){ b.items = b.items.filter(i=>i.id!==last.id); }
    return { say: "Okay, removed the last note." };
  }
  return null;
}

// ---- Memory helpers ----
function addNoteToMemory(businessId, text, kind="note", extra={}){
  const b = ensureBrain(businessId);
  const item = makeItem(kind, text, {
    tags: [kind],
    confidence: 1.0,
    expiresAt: MEMORY_TTL_MS ? (Date.now() + MEMORY_TTL_MS) : null,
    ...extra
  });
  if(!isDuplicate(b.items, item.text)){ b.items.push(item); indexItem(item); pruneMemoryItems(b); }
}

function injectTinyHumor(say){
  // One tiny, context-agnostic quip at the end. Keep it gentle.
  const quips = [
    "Promise I won’t make it a TED Talk.",
    "Short, like good coffee shots.",
    "I’ll keep the nerdiness under control. Mostly."
  ];
  const pick = quips[Math.floor(Math.random()*quips.length)];
  // Respect length—don’t explode past ~4 sentences.
  return say.split(/\s+/).length > 60 ? say : `${say}  ${pick}`;
}

function autoExtractProfile(businessId, text){
  const t = " " + String(text||"") + " ";
  // Names / “call me …”
  const callMe = t.match(/\bcall me ([A-Za-z][\w'-]{1,30})/i);
  if (callMe) addNoteToMemory(businessId, `Preferred name: ${callMe[1]}`, "profile", { key:"preferred_name", value: callMe[1] });

  // Birthday
  const bd = t.match(/\b(?:birthday|bday|born on)\s+(?:is\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (bd) addNoteToMemory(businessId, `Birthday: ${bd[1]}`, "profile", { key:"birthday", value: bd[1] });

  // Likes / dislikes
  const like = t.match(/\b(i (really )?like|my favorite is)\s+([^.,;!?]{2,60})/i);
  if (like) addNoteToMemory(businessId, `Likes: ${like[3].trim()}`, "preference", { key:"likes", value: like[3].trim() });

  const dislike = t.match(/\b(i (really )?dislike|i hate)\s+([^.,;!?]{2,60})/i);
  if (dislike) addNoteToMemory(businessId, `Dislikes: ${dislike[3].trim()}`, "preference", { key:"dislikes", value: dislike[3].trim() });
}

function logTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if(!brain.conversations) brain.conversations=[];
  brain.conversations.push({ id:uid(), sessionId, role, content, timestamp:Date.now() });
  if(brain.conversations.length>1500) brain.conversations = brain.conversations.slice(-1500);
  if(role==="user" && MEMORY_MODE==="always") autoExtractProfile(businessId, content);
}

function pruneMemoryItems(brain){
  if(brain.items.length<=MAX_MEMORY_ITEMS) return;
  const scored = brain.items.map(item=>{
    let score = item.confidence||0.5;
    const age = Date.now() - (item.updatedAt||item.createdAt);
    const days = age/(1000*60*60*24);
    if(item.type==="profile") score+=0.4;
    if(item.type==="preference") score+=0.2;
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
  return { items: brain.items, conversations: brain.conversations||[], pace: brain.speed, memoryMode: MEMORY_MODE };
}

// ---- Chat (JSON) ----
async function chatJSONWithMemory(sessionId, businessId, userText){
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role:"user", content:userText, ts:Date.now() });
  const trimmed = hist.slice(-MAX_TURNS*2);
  memoryStore.set(sessionId, trimmed);

  const brain = ensureBrain(businessId);
  const saved = brain.items.slice(-25).map(i=>{
    if(i.type==="profile" || i.type==="preference") return `- ${i.type}: ${i.text}`;
    if(i.type==="note") return `- Note: ${i.text.slice(0,200)}`;
    return `- ${i.type}: ${i.text.slice(0,200)}`;
  }).join("\n") || "No saved info yet.";

  const relevant = scoreItems(brain.items, userText).slice(0,8);
  const relevantBlock = relevant.length ? ("\nRelevant:\n" + relevant.map(i=>`- ${i.text.slice(0,220)}`).join("\n")) : "";

  const sys = { role:"system", content: buildSystemPrompt() + `

Memory mode: ${MEMORY_MODE.toUpperCase()}
Saved info:
${saved}
${relevantBlock}` };

  const messages = [sys, ...trimmed.map(m=>({ role:m.role, content:m.content }))];

  const order = [CHAT_MODEL, ...CHAT_FALLBACKS.filter(m=>m!==CHAT_MODEL)];
  let lastErr;
  for(const model of order){
    try{
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`,{
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({
          model, temperature:0.35, max_tokens:320,
          response_format:{ type:"json_object" },
          messages
        })
      });
      if(!res.ok){ lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); continue; }
      const json = await res.json();
      const raw = json.choices?.[0]?.message?.content || "{}";
      const out = safeJson(raw) || {};
      // normalize
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
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---- TTS (ElevenLabs) or client fallback ----
async function speakOrText(statusCode, sid, brain, say, meta, softFallback){
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
        response: say,
        tone: meta?.tone || DEFAULT_TONE,
        audio: `data:audio/mpeg;base64,${buf.toString("base64")}`,
        ttsEngine: "elevenlabs",
        canInterrupt: !!meta?.can_interrupt,
        maxSpeakMs: Number(meta?.max_speak_ms || 6500),
        receipt: meta?.receipt || null,
        interruptReason: meta?.interrupt_reason || null,
        clientTTS: false,
        memoryShadow: brainSnapshot(brain)
      }, hdrs);
    }catch(e){
      console.warn("ElevenLabs failed; falling back to client TTS:", e.message);
    }
  }

  // Client SpeechSynthesis fallback (no audio payload)
  return reply(statusCode, {
    sessionId: sid,
    response: say,
    sayText: say,
    ttsEngine: "client-speechSynthesis",
    clientTTS: true,
    tone: meta?.tone || DEFAULT_TONE,
    canInterrupt: !!meta?.can_interrupt,
    maxSpeakMs: Number(meta?.max_speak_ms || 6500),
    receipt: meta?.receipt || null,
    interruptReason: meta?.interrupt_reason || null,
    memoryShadow: brainSnapshot(brain)
  }, hdrs);
}

function polish(text){
  let t = String(text||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ").replace(/\s{3,}/g,"  ");
  if(!/[.!?…]$/.test(t)) t+=".";
  return t.slice(0,3600);
}

// ---- Retry ----
async function withRetry(fn,n){
  try{ return await fn(); }
  catch(e){ if(n<=0 || !isTransient(e)) throw e; await sleep(250); return withRetry(fn,n-1); }
}
function isTransient(e){
  return /429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message||""));
}
