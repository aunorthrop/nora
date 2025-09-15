// Nora — General Voice Assistant (OpenAI STT/Chat + ElevenLabs/OpenAI TTS)
// - ElevenLabs TTS first if configured; OpenAI TTS fallback
// - Lightweight memory per businessId (items + conversations)
// - Clear logging + error messages; no “senior” text anywhere

const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_PRIMARY = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CHAT_FALLBACKS = ["gpt-4o-mini", "gpt-4o"];
const STT_MODEL = "whisper-1";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const DEFAULT_SPEED = 0.95;
const VOLUME_BOOST = 1.15;

const MAX_TURNS = 30;
const MAX_MEMORY_ITEMS = 2000;

// in-memory stores (per function cold start)
const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

// utils
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const safeJson = (s)=>{ try{return JSON.parse(s);}catch{return null;} };
const ext = (m)=>!m?".wav": m.includes("wav")?".wav": m.includes("mp3")?".mp3": m.includes("mp4")?".mp4": m.includes("webm")?".webm": m.includes("ogg")?".ogg":".wav";
const reply = (code,data,headers)=>({ statusCode:code, headers, body:JSON.stringify(data) });
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function tokenize(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }
function matchOriginal(full, lowerSlice){
  const pattern = lowerSlice.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+");
  const re = new RegExp(pattern, "i"); const m = String(full||"").match(re); return m?m[0].trim():lowerSlice;
}
function titleCase(s){ return String(s||"").replace(/\b\w/g,c=>c.toUpperCase()); }
function pruneMap(map,max){ if(map.size<=max) return; const keys=[...map.keys()]; for(let i=0;i<map.size-max;i++) map.delete(keys[i]); }

function ensureBrain(businessId){
  if(!deviceBrain.has(businessId)){
    deviceBrain.set(businessId,{ voice:OPENAI_TTS_VOICE, speed:DEFAULT_SPEED, items:[], conversations:[] });
  }
  const b = deviceBrain.get(businessId); if(!b.conversations) b.conversations=[];
  return b;
}
function makeItem(type,text,extra={}){ return { id:uid(), type, text:String(text||"").trim(), createdAt:Date.now(), updatedAt:Date.now(), tags:[], confidence:1.0, ...extra }; }
function indexItem(it){ brainVectors.set(it.id, new Set(tokenize(it.text))); }
function isDuplicate(items,newText){
  const newTokens = new Set(tokenize(newText));
  return items.some(item=>{
    const itemTokens = new Set(tokenize(item.text));
    let overlap=0; for(const t of newTokens) if(itemTokens.has(t)) overlap++;
    const sim = overlap / Math.min(newTokens.size, itemTokens.size||1);
    return sim>0.75;
  });
}
function scoreItems(items,query){
  const qset = new Set(tokenize(query)); const now=Date.now();
  return items.map(it=>{
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap=0; for(const t of qset) if(w.has(t)) overlap++;
    const recency = 1 / Math.max(1, (now - (it.updatedAt||it.createdAt)) / (1000*60*60*24));
    const confidence = it.confidence || 0.5;
    let typeBoost=0; if(it.type==="family") typeBoost=0.4; else if(it.type==="contact") typeBoost=0.3; else if(it.type==="note") typeBoost=0.1;
    return { ...it, _score: overlap + recency*0.2 + confidence*0.4 + typeBoost };
  }).sort((a,b)=>b._score-a._score);
}

exports.handler = async (event)=>{
  const headers = {
    "Content-Type":"application/json",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"POST, OPTIONS, GET",
    "Cache-Control":"no-cache"
  };

  try{
    if(event.httpMethod==="OPTIONS") return reply(200,{ok:true},headers);
    if(event.httpMethod==="GET")     return reply(200,{message:"Nora Voice OK",ts:new Date().toISOString()},headers);
    if(event.httpMethod!=="POST")    return reply(405,{error:"Method Not Allowed"},headers);
    if(!process.env.OPENAI_API_KEY)  return reply(500,{error:"OPENAI_API_KEY not configured"},headers);

    const body = safeJson(event.body);
    if(!body) return reply(400,{error:"Invalid JSON body"},headers);
    const { businessId, sessionId, audio, memoryShadow } = body;
    if(!businessId || !audio?.data || !audio?.mime) return reply(400,{error:"Missing required information"},headers);

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    if(memoryShadow && typeof memoryShadow==="object") mergeShadow(businessId, memoryShadow);
    const brain = ensureBrain(businessId);

    // --- Speech-to-text ---
    let transcript="";
    try{
      transcript = await withRetry(()=>transcribe(audio.data, audio.mime), 2);
    }catch(e){
      const msg = "Sorry—I couldn’t catch that. Please try again a bit closer to the mic.";
      const speech = await safeTTS(msg, businessId).catch(()=>null);
      return reply(200,{ sessionId:sid, transcript:"", response:msg, audio:speech?.dataUrl, ttsEngine:speech?.engine, memoryShadow:brainSnapshot(brain), error:"stt_failed" },headers);
    }

    const words = (transcript||"").trim().split(/\s+/).filter(Boolean);
    if(!transcript?.trim() || words.length<1){
      const ask="I heard audio but not the words. Could you repeat that?";
      const speech=await safeTTS(ask,businessId).catch(()=>null);
      return reply(200,{ sessionId:sid, transcript, response:ask, audio:speech?.dataUrl, ttsEngine:speech?.engine, memoryShadow:brainSnapshot(brain) },headers);
    }

    logTurn(businessId, sid, transcript, "user");

    // quick intents (memory helpers + safety)
    const fast = await routeIntent(businessId, sid, transcript);
    if(fast){
      logTurn(businessId, sid, fast.say, "assistant");
      const speech=await safeTTS(fast.say,businessId).catch(()=>null);
      return reply(200,{ sessionId:sid, transcript, response:fast.say, audio:speech?.dataUrl, ttsEngine:speech?.engine, control:fast.control||undefined, memoryShadow:brainSnapshot(ensureBrain(businessId)) },headers);
    }

    // chat
    const answer = await chatWithMemory(sid, businessId, transcript)
      .catch(()=> "I hit a snag. Mind asking that again?");
    logTurn(businessId, sid, answer, "assistant");
    const speech=await safeTTS(answer,businessId).catch(()=>null);

    return reply(200,{ sessionId:sid, transcript, response:answer, audio:speech?.dataUrl, ttsEngine:speech?.engine, memoryShadow:brainSnapshot(ensureBrain(businessId)) },headers);

  }catch(err){
    console.error("Handler error:", err);
    return reply(500,{ error:`Internal server error: ${err.message}` },headers);
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

// ---------- Intents (simple memory helpers + guardrails) ----------
async function routeIntent(businessId, sessionId, raw){
  const text = raw.trim(); const lower = text.toLowerCase(); const brain = ensureBrain(businessId);

  if (/\b(hello|hey|hi|you there)\b/.test(lower)) return { say:"Hi! I’m here and listening. What can I help with?" };
  if (/\b(speak (louder|up)|too quiet|can'?t hear)\b/.test(lower)) return { say:"I’ll speak a bit louder. Is this better?" };
  if (/\b(slow down|too fast|speak slower)\b/.test(lower)) { brain.speed=Math.max(0.7,(brain.speed||DEFAULT_SPEED)-0.1); return { say:"I’ll slow my pace down a touch." }; }

  // memory add
  const remember = lower.match(/^(?:remember|note|save)\s+(.+?)\.?$/i);
  if (remember) {
    const body = matchOriginal(raw, remember[1]);
    const item = makeItem("note", body, { tags:["note"], confidence:1.0, timestamp:new Date().toLocaleString() });
    const b = ensureBrain(businessId); if (!isDuplicate(b.items, item.text)) { b.items.push(item); indexItem(item); pruneMemoryItems(b); }
    return { say:"Saved." };
  }

  const nameAdd = lower.match(/^(?:remember|save)\s+(?:contact|person)\s+(.+?)\.?$/i);
  if(nameAdd){
    const name = titleCase(matchOriginal(raw,nameAdd[1]));
    const item = makeItem("contact", `Contact: ${name}`, { name, tags:["contact"], confidence:1.0 });
    const b = ensureBrain(businessId); b.items.push(item); indexItem(item); pruneMemoryItems(b);
    return { say:`Got it — ${name} saved to memory.` };
  }

  const recall = lower.match(/^what(?:'s| is)\s+the\s+note\s+about\s+(.+?)\??$/i);
  if (recall){
    const q = matchOriginal(raw, recall[1]);
    const b = ensureBrain(businessId); const results = scoreItems(b.items, q).slice(0,3);
    if(results.length){ return { say: results.map(r=>r.text).join(". ") }; }
    return { say: "I don’t have anything on that yet." };
  }

  // disclaimers
  if (/\b(medical|health|doctor|medicine|pain|hurt|sick|legal|lawyer|law|financial|money|investment)\b/.test(lower) &&
      /\b(advice|recommend|should i|what do you think|opinion)\b/.test(lower)) {
    return { say:"I can’t give medical, legal, or financial advice. A qualified professional is the right move there." };
  }

  return null;
}

// ---------- Chat with memory ----------
async function chatWithMemory(sessionId, businessId, userText){
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role:"user", content:userText, ts:Date.now() });
  const trimmed = hist.slice(-MAX_TURNS*2);
  memoryStore.set(sessionId, trimmed);

  const brain = ensureBrain(businessId);

  const recentItems = brain.items.slice(-25).map(i=>{
    if(i.type==="contact") return `- Contact: ${i.text}`;
    if(i.type==="note") return `- Note: ${i.text.slice(0,200)}`;
    return `- ${i.type}: ${i.text.slice(0,200)}`;
  }).join("\n") || "No saved info yet.";

  const relevantItems = scoreItems(brain.items, userText).slice(0,10);
  const contextItems = relevantItems.length ? "\nRelevant:\n" + relevantItems.map(i=>`- ${i.text.slice(0,300)}`).join("\n") : "";

  const recentConversations = brain.conversations ? brain.conversations.slice(-12).map(c => `${c.role==='user'?'They said':'I said'}: ${c.content.slice(0,150)}`).join("\n") : "";

  const system = {
    role:"system",
    content:
`You are a helpful, friendly voice assistant named Nora.
- Be clear and concise (2–4 sentences).
- Never provide medical, legal, or financial advice.
- Use the saved info when relevant.

Saved:
${recentItems}
${contextItems}

Recent conversation:
${recentConversations.slice(-600)}`
  };

  const messages = [system, ...trimmed.map(m=>({ role:m.role, content:m.content }))];
  const order = [CHAT_PRIMARY, ...CHAT_FALLBACKS];

  let lastErr;
  for(const model of order){
    try{
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`,{
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({ model, messages, max_tokens:200, temperature:0.3, frequency_penalty:0.1 })
      });
      if(!res.ok){ lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); continue; }
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim();
      if(reply){ trimmed.push({ role:"assistant", content:reply, ts:Date.now() }); memoryStore.set(sessionId, trimmed); pruneMap(memoryStore,50); return reply; }
    }catch(e){ lastErr = e; continue; }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---------- TTS ----------
function polish(text){
  let t = String(text||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ").replace(/\s{3,}/g,"  ");
  if(!/[.!?…]$/.test(t)) t+=".";
  return t;
}

async function ttsOpenAI(text, voice, speed, model){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model, voice, input: polish(text).slice(0,4000), response_format:"mp3", speed: Math.max(0.6, Math.min(1.1, speed||DEFAULT_SPEED)) })
  });
  if(!r.ok) throw new Error(await r.text());
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

async function ttsEleven(text){
  if(!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error("ElevenLabs key/voice not configured");
  const clean = polish(text).slice(0,2500);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,{
    method:"POST",
    headers:{ "xi-api-key":ELEVEN_API_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
    body: JSON.stringify({
      text: clean,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability:0.7, similarity_boost:0.8, style:0.2, use_speaker_boost:true },
      output_format: "mp3_44100_128"
    })
  });
  if(!res.ok){ const t=await res.text().catch(()=>"(no body)"); throw new Error(`ElevenLabs ${res.status}: ${t}`); }
  const buf = Buffer.from(await res.arrayBuffer());
  if(buf.length<1000) throw new Error("ElevenLabs tiny buffer");
  return buf.toString("base64");
}

async function safeTTS(text, businessId){
  const brain = ensureBrain(businessId);
  const speed = brain.speed || DEFAULT_SPEED;
  const useHd = text.length>100;
  const model = OPENAI_TTS_MODEL;

  // try ElevenLabs first if configured
  if(ELEVEN_API_KEY && ELEVEN_VOICE_ID){
    try{
      const b64 = await withRetry(()=>ttsEleven(text), 2);
      return { dataUrl:`data:audio/mpeg;base64,${b64}`, engine:"elevenlabs", volumeBoost:VOLUME_BOOST };
    }catch(e){
      console.warn("ElevenLabs TTS failed, falling back:", e.message);
    }
  }

  // fallback: OpenAI TTS
  const b64 = await withRetry(()=>ttsOpenAI(text, OPENAI_TTS_VOICE, speed, model), 2);
  return { dataUrl:`data:audio/mpeg;base64,${b64}`, engine:`openai-${model}`, volumeBoost:VOLUME_BOOST };
}

// ---------- Memory ----------
function logTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if(!brain.conversations) brain.conversations=[];
  brain.conversations.push({ id:uid(), sessionId, role, content, timestamp:Date.now(), date:new Date().toISOString().split('T')[0] });
  if(brain.conversations.length>1000) brain.conversations = brain.conversations.slice(-1000);
  if(role==="user") autoExtract(businessId, content);
}

function autoExtract(businessId, text){
  const brain = ensureBrain(businessId);
  const contacts = text.match(/\b(?:contact|person)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/g);
  if(contacts){
    contacts.forEach(m=>{
      const name = m.replace(/^(?:contact|person)\s+/i,"").trim();
      const item = makeItem("contact", `Contact: ${name}`, { name, tags:["contact"], confidence:0.8 });
      if(!isDuplicate(brain.items,item.text)){ brain.items.push(item); indexItem(item); }
    });
  }
  const notes = text.match(/\b(?:note|remember)\s+([^.,;!?]+)[.,;!?]?/i);
  if(notes){
    const item = makeItem("note", notes[1].trim(), { tags:["note","auto"], confidence:0.7 });
    if(!isDuplicate(brain.items,item.text)){ brain.items.push(item); indexItem(item); }
  }
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
  return { items: brain.items, conversations: brain.conversations||[], voice: OPENAI_TTS_VOICE, pace: brain.speed };
}

// retry wrapper
async function withRetry(fn,n){
  try{ return await fn(); }
  catch(e){ if(n<=0 || !isTransient(e)) throw e; await sleep(250); return withRetry(fn,n-1); }
}
function isTransient(e){
  return /429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message||""));
}
