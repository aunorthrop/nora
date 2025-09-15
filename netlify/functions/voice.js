// Netlify Function: Senior-Optimized Voice Assistant (ElevenLabs-first, hard-fail when requested)

const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_PRIMARY = "gpt-4o-mini";
const CHAT_FALLBACKS = ["gpt-4o", "gpt-3.5-turbo-0125", "gpt-3.5-turbo"];
const STT_MODEL = "whisper-1";
const TTS_MODEL_DEFAULT = "tts-1";
const TTS_MODEL_HD = "tts-1-hd";

const DEFAULT_VOICE = "alloy";
const DEFAULT_SPEED = 0.85;
const SENIOR_VOLUME_BOOST = 1.2;

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID_ENV = process.env.ELEVENLABS_VOICE_ID || "";

const MAX_TURNS = 30;
const MAX_MEMORY_ITEMS = 2000;

const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

// --- utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const ext = (m) =>
  !m ? ".wav" :
  m.includes("wav") ? ".wav" :
  m.includes("mp3") ? ".mp3" :
  m.includes("mp4") ? ".mp4" :
  m.includes("webm") ? ".webm" :
  m.includes("ogg") ? ".ogg" : ".wav";
const reply = (code, data, headers) => ({ statusCode: code, headers, body: JSON.stringify(data) });
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function tokenize(s){
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}
function matchOriginal(full, lowerSlice){
  const pattern = lowerSlice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(pattern, "i");
  const m = String(full || "").match(re);
  return m ? m[0].trim() : lowerSlice;
}
function titleCase(s){ return String(s || "").replace(/\b\w/g, c => c.toUpperCase()); }
function pruneMap(map, max){ if (map.size <= max) return; const keys = [...map.keys()]; for (let i = 0; i < map.size - max; i++) map.delete(keys[i]); }

function ensureBrain(businessId){
  if (!deviceBrain.has(businessId)) {
    deviceBrain.set(businessId, { voice: DEFAULT_VOICE, speed: DEFAULT_SPEED, items: [], conversations: [] });
  }
  const b = deviceBrain.get(businessId);
  if (!b.conversations) b.conversations = [];
  return b;
}
function makeItem(type, text, extra = {}){ return Object.assign({ id: uid(), type, text: String(text || "").trim(), createdAt: Date.now(), updatedAt: Date.now(), tags: [], confidence: 1.0 }, extra); }
function indexItem(it){ brainVectors.set(it.id, new Set(tokenize(it.text))); }
function isDuplicate(items, newText){
  const a = new Set(tokenize(newText));
  return items.some(item => {
    const b = new Set(tokenize(item.text));
    let overlap = 0; for (const t of a) if (b.has(t)) overlap++;
    const sim = overlap / Math.min(a.size, b.size || 1);
    return sim > 0.75;
  });
}
function scoreItems(items, query){
  const qset = new Set(tokenize(query));
  const now = Date.now();
  return items.map(it => {
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap = 0; for (const t of qset) if (w.has(t)) overlap++;
    const recency = 1 / Math.max(1, (now - (it.updatedAt || it.createdAt)) / (86400000));
    const confidence = it.confidence || 0.5;
    let typeBoost = 0;
    if (it.type === "family") typeBoost = 0.9;
    else if (it.type === "medical-contact") typeBoost = 0.8;
    else if (it.type === "medication") typeBoost = 0.7;
    else if (it.tags?.includes("important")) typeBoost = 0.5;
    return { ...it, _score: overlap + recency * 0.2 + confidence * 0.4 + typeBoost };
  }).sort((a,b) => b._score - a._score);
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Cache-Control": "no-cache"
  };

  try {
    if (event.httpMethod === "OPTIONS") return reply(200, { ok: true }, headers);
    if (event.httpMethod === "GET") return reply(200, { message: "Senior Voice Assistant OK", ts: new Date().toISOString() }, headers);
    if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" }, headers);
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "OPENAI_API_KEY not configured" }, headers);

    const body = safeJson(event.body);
    if (!body) return reply(400, { error: "Invalid JSON body" }, headers);
    if (body.test) return reply(200, { message: "API endpoint working", ts: new Date().toISOString() }, headers);

    const { businessId, sessionId, audio, memoryShadow, tts } = body;
    if (!businessId || !audio?.data || !audio?.mime)
      return reply(400, { error: "Missing required information" }, headers);

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    if (memoryShadow && typeof memoryShadow === "object") mergeShadow(businessId, memoryShadow);
    const brain = ensureBrain(businessId);

    // --- STT
    let transcript = "";
    try {
      transcript = await withRetry(() => transcribeForSeniors(audio.data, audio.mime), 2);
    } catch (e) {
      const msg = "I'm having trouble hearing you. Could you please speak a bit louder and try again?";
      const speech = await safeTTS(msg, businessId, tts).catch(() => null);
      return reply(200, { sessionId: sid, transcript: "", response: msg, audio: speech?.dataUrl, ttsEngine: speech?.engine, memoryShadow: brainSnapshot(brain), error: "stt_failed" }, headers);
    }

    const words = (transcript || "").trim().split(/\s+/).filter(Boolean);
    if (!transcript?.trim() || words.length < 1) {
      const ask = "I heard something, but I'm not sure what you said. Could you repeat that for me?";
      const speech = await safeTTS(ask, businessId, tts).catch(() => null);
      return reply(200, { sessionId: sid, transcript, response: ask, audio: speech?.dataUrl, ttsEngine: speech?.engine, memoryShadow: brainSnapshot(brain) }, headers);
    }

    logConversationTurn(businessId, sid, transcript, "user");

    // quick intents
    const fast = await routeIntentForSeniors(businessId, sid, transcript);
    if (fast) {
      logConversationTurn(businessId, sid, fast.say, "assistant");
      const speech = await safeTTS(fast.say, businessId, tts).catch((err) => ({ dataUrl:null, engine:null, error:String(err?.message||err) }));
      // If Eleven was forced and failed, surface the error
      const resp = { sessionId: sid, transcript, response: fast.say, audio: speech?.dataUrl, ttsEngine: speech?.engine, control: fast.control || undefined, memoryShadow: brainSnapshot(ensureBrain(businessId)) };
      if (!speech?.dataUrl && tts?.engine === "eleven") resp.error = speech?.error || "eleven_failed";
      return reply(200, resp, headers);
    }

    // main chat
    const answer = await chatWithSeniorMemory(sid, businessId, transcript).catch(() => "I'm having a small technical issue. Could you try that again?");
    logConversationTurn(businessId, sid, answer, "assistant");
    const speech = await safeTTS(answer, businessId, tts).catch((err) => ({ dataUrl:null, engine:null, error:String(err?.message||err) }));

    const responsePayload = { sessionId: sid, transcript, response: answer, audio: speech?.dataUrl, ttsEngine: speech?.engine, memoryShadow: brainSnapshot(ensureBrain(businessId)) };
    if (!speech?.dataUrl && tts?.engine === "eleven") responsePayload.error = speech?.error || "eleven_failed";
    return reply(200, responsePayload, headers);

  } catch (err) {
    console.error("Handler error:", err);
    return reply(500, { error: `Internal server error: ${err.message}` }, headers);
  }
};

// ---------- STT ----------
async function transcribeForSeniors(b64, mime){
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 300) return "";

  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language", "en");
  fd.set("temperature", "0.2");
  fd.set("prompt", "Conversation with an older adult. They may speak slowly or pause.");

  const blob = new Blob([buf], { type: mime || "application/octet-stream" });
  fd.set("file", blob, "audio" + ext(mime));

  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd
  });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text || "").trim();
}

// ---------- Intent router ----------
async function routeIntentForSeniors(businessId, sessionId, raw){
  const text = raw.trim();
  const lower = text.toLowerCase();
  const brain = ensureBrain(businessId);

  if (/\b(can you hear me|are you there|hello|hi there)\b/.test(lower))
    return { say: "Yes, I can hear you. I'm here and ready to help. What would you like to talk about?" };

  if (/\b(speak (up|louder)|i can'?t hear you|too quiet)\b/.test(lower))
    return { say: "I'll speak louder and more clearly. Is this better?" };

  if (/\b(slow down|too fast|speak slower)\b/.test(lower)) {
    ensureBrain(businessId).speed = Math.max(0.7, (brain.speed || DEFAULT_SPEED) - 0.1);
    return { say: "I'll slow down my speech. How is this pace?" };
  }

  if (/\b(medical|health|doctor|medicine|pain|hurt|sick|legal|lawyer|law|financial|money|investment)\b/.test(lower) &&
      /\b(advice|recommend|suggest|should i|what do you think|opinion)\b/.test(lower)) {
    return { say: "I can't give medical, legal, or financial advice. It's best to speak with a qualified professional." };
  }

  return null;
}

// ---------- Chat ----------
async function chatWithSeniorMemory(sessionId, businessId, userText){
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role: "user", content: userText, ts: Date.now() });
  const trimmed = hist.slice(-MAX_TURNS * 2);
  memoryStore.set(sessionId, trimmed);

  const brain = ensureBrain(businessId);

  const recentItems = brain.items.slice(-25).map(i => {
    if (i.type === "family") return `- Family: ${i.text}`;
    if (i.type === "medical-contact") return `- Medical: ${i.text}`;
    if (i.type === "medication") return `- Medication: ${i.text}`;
    return `- Note: ${i.text.slice(0, 200)}`;
  }).join("\n") || "No saved information yet.";

  const relevantItems = scoreItems(brain.items, userText).slice(0, 10);
  const contextItems = relevantItems.length
    ? "\nRelevant to current conversation:\n" + relevantItems.map(i => `- ${i.text.slice(0, 300)}`).join("\n")
    : "";

  const recentConversations = brain.conversations
    ? brain.conversations.slice(-15).map(c => `${c.role === 'user' ? 'They said' : 'I said'}: ${c.content.slice(0, 150)}`).join("\n")
    : "";

  const system = {
    role: "system",
    content:
`You are a friendly, patient voice assistant designed for older adults.
- Speak clearly, warmly, and at a comfortable pace.
- Avoid medical, legal, or financial advice.
- Offer memory help (names, locations, appointments).
- Keep responses 2–4 sentences.

Saved info:
${recentItems}
${contextItems}

Recent conversation:
${recentConversations.slice(-600)}`
  };

  const messages = [system, ...trimmed.map(m => ({ role: m.role, content: m.content }))];
  const order = [CHAT_PRIMARY, ...CHAT_FALLBACKS];

  let lastErr;
  for (const model of order) {
    try {
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: 200, temperature: 0.3, frequency_penalty: 0.1 })
      });
      if (!res.ok) { lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); continue; }
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim();
      if (reply) {
        trimmed.push({ role: "assistant", content: reply, ts: Date.now() });
        memoryStore.set(sessionId, trimmed);
        pruneMap(memoryStore, 50);
        return reply;
      }
    } catch (e) { lastErr = e; continue; }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---------- TTS ----------
function sculptForSeniors(text){
  let t = String(text || "").trim();
  t = t.replace(/([.!?])\s+/g, "$1  ");
  t = t.replace(/,\s+/g, ",  ");
  t = t.replace(/;\s+/g, ";  ");
  t = t.replace(/ - /g, ", ").replace(/\s{3,}/g, "  ");
  t = t.replace(/([a-zA-Z0-9])\n/g, "$1. ");
  if (!/[.!?…]$/.test(t)) t += ".";
  return t;
}

async function ttsRawOpenAI(text, voice, speed, model){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: sculptForSeniors(text).slice(0, 4000), response_format: "mp3", speed: Math.max(0.6, Math.min(1.0, speed)) })
  });
  if (!r.ok) throw new Error(await r.text());
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

async function ttsViaElevenLabs(text, voiceId){
  if (!ELEVEN_API_KEY || !voiceId) throw new Error("Missing ElevenLabs API key or voiceId");
  const cleanText = sculptForSeniors(text).slice(0, 2500);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({
      text: cleanText,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      output_format: "mp3_44100_128"
    })
  });

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${errTxt}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("ElevenLabs returned tiny audio buffer");
  return buf.toString("base64");
}

// Respect client's tts request. If engine === "eleven", hard-fail instead of silently falling back.
async function safeTTS(text, businessId, ttsOpts = {}){
  const brain = ensureBrain(businessId);
  const speed = brain.speed || DEFAULT_SPEED;
  const refined = sculptForSeniors(text);

  const wantEleven = ttsOpts?.engine === "eleven";
  const voiceId = (ttsOpts?.voiceId || ELEVEN_VOICE_ID_ENV || "").trim();

  // Force ElevenLabs if explicitly requested
  if (wantEleven) {
    if (!ELEVEN_API_KEY) throw new Error("ElevenLabs required but ELEVENLABS_API_KEY is not configured");
    if (!voiceId) throw new Error("ElevenLabs required but no voiceId provided (client tts.voiceId or ELEVENLABS_VOICE_ID)");
    const b64 = await withRetry(() => ttsViaElevenLabs(refined, voiceId), 1);
    return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "elevenlabs", volumeBoost: SENIOR_VOLUME_BOOST };
  }

  // Prefer Eleven when available (soft fallback behavior)
  if (ELEVEN_API_KEY && voiceId) {
    try {
      const b64 = await withRetry(() => ttsViaElevenLabs(refined, voiceId), 2);
      return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "elevenlabs", volumeBoost: SENIOR_VOLUME_BOOST };
    } catch (err) {
      console.error("ElevenLabs TTS failed; falling back:", err.message);
    }
  }

  // OpenAI fallback
  const useHd = refined.length > 100;
  const model = useHd ? TTS_MODEL_HD : TTS_MODEL_DEFAULT;
  const b64 = await withRetry(() => ttsRawOpenAI(refined, DEFAULT_VOICE, speed, model), 2);
  return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: useHd ? "openai-tts-1-hd" : "openai-tts-1", volumeBoost: SENIOR_VOLUME_BOOST };
}

// ---------- Memory (minimal for this build) ----------
function logConversationTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if (!brain.conversations) brain.conversations = [];
  brain.conversations.push({ id: uid(), sessionId, role, content, timestamp: Date.now(), date: new Date().toISOString().split('T')[0] });
  if (brain.conversations.length > 1000) brain.conversations = brain.conversations.slice(-1000);
}
function mergeShadow(businessId, shadow){
  const brain = ensureBrain(businessId);
  if (typeof shadow.pace === "number") brain.speed = Math.max(0.6, Math.min(1.0, shadow.pace));
  if (Array.isArray(shadow.items)) {
    const byId = new Map(brain.items.map(i => [i.id, i]));
    for (const it of shadow.items) {
      if (!it || !it.text) continue;
      if (!it.id || !byId.has(it.id)) {
        const newItem = { ...it, id: it.id || uid(), createdAt: it.createdAt || Date.now(), updatedAt: it.updatedAt || Date.now() };
        brain.items.push(newItem); indexItem(newItem);
      }
    }
  }
  if (Array.isArray(shadow.conversations)) {
    if (!brain.conversations) brain.conversations = [];
    shadow.conversations.forEach(conv => {
      if (conv && conv.content && !brain.conversations.find(c => c.id === conv.id)) {
        brain.conversations.push({ ...conv, id: conv.id || uid(), timestamp: conv.timestamp || Date.now() });
      }
    });
    brain.conversations.sort((a,b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
}
function brainSnapshot(brain){
  return { items: brain.items, conversations: brain.conversations || [], voice: DEFAULT_VOICE, pace: brain.speed };
}

// --- retry
async function withRetry(fn, n){
  try { return await fn(); }
  catch(e){
    if (n <= 0 || !isTransient(e)) throw e;
    await sleep(250);
    return withRetry(fn, n - 1);
  }
}
function isTransient(e){
  return /429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message || ""));
}
