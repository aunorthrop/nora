// Netlify Function: Senior-Optimized Voice Assistant (ElevenLabs Only)
// - Removes OpenAI TTS fallback
// - Uses only ElevenLabs for voice synthesis
// - Better error handling for ElevenLabs issues

const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_PRIMARY = "gpt-4o-mini";
const CHAT_FALLBACKS = ["gpt-4o", "gpt-3.5-turbo-0125", "gpt-3.5-turbo"];
const STT_MODEL = "whisper-1";

const DEFAULT_SPEED = 0.85;
const SENIOR_VOLUME_BOOST = 1.2;

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const MAX_TURNS = 30;
const MAX_MEMORY_ITEMS = 2000;

const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

// --- util core
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
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Restores the **original substring** (with casing) from `full` given a lowercase slice
function matchOriginal(full, lowerSlice){
  const pattern = lowerSlice
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")   // escape regex
    .replace(/\s+/g, "\\s+");                 // be lenient on whitespace
  const re = new RegExp(pattern, "i");
  const m = String(full || "").match(re);
  return m ? m[0].trim() : lowerSlice;
}

function titleCase(s){
  return String(s || "").replace(/\b\w/g, c => c.toUpperCase());
}

function pruneMap(map, max){
  if (map.size <= max) return;
  const keys = [...map.keys()];
  for (let i = 0; i < map.size - max; i++) map.delete(keys[i]);
}

function ensureBrain(businessId){
  if (!deviceBrain.has(businessId)) {
    deviceBrain.set(businessId, {
      speed: DEFAULT_SPEED,
      items: [],
      conversations: [],
    });
  }
  const b = deviceBrain.get(businessId);
  if (!b.conversations) b.conversations = [];
  return b;
}

function makeItem(type, text, extra = {}){
  const base = {
    id: uid(),
    type,
    text: String(text || "").trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: [],
    confidence: 1.0
  };
  Object.assign(base, extra);
  return base;
}

function indexItem(it){ brainVectors.set(it.id, new Set(tokenize(it.text))); }

function isDuplicate(items, newText){
  const newTokens = new Set(tokenize(newText));
  return items.some(item => {
    const itemTokens = new Set(tokenize(item.text));
    let overlap = 0;
    for (const t of newTokens) if (itemTokens.has(t)) overlap++;
    const similarity = overlap / Math.min(newTokens.size, itemTokens.size || 1);
    return similarity > 0.75;
  });
}

function scoreItems(items, query){
  const qset = new Set(tokenize(query));
  const now = Date.now();
  return items.map(it => {
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap = 0; for (const t of qset) if (w.has(t)) overlap++;
    const recency = 1 / Math.max(1, (now - (it.updatedAt || it.createdAt)) / (1000 * 60 * 60 * 24));
    const confidence = it.confidence || 0.5;
    let typeBoost = 0;
    if (it.type === "family") typeBoost = 0.9;
    else if (it.type === "medical-contact") typeBoost = 0.8;
    else if (it.type === "medication") typeBoost = 0.7;
    else if (it.type === "location") typeBoost = 0.6;
    else if (it.tags?.includes("important")) typeBoost = 0.5;
    return { ...it, _score: overlap + recency * 0.2 + confidence * 0.4 + typeBoost };
  }).sort((a,b) => b._score - a._score);
}

// --- Netlify handler
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
    
    // Check for required API keys
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "OPENAI_API_KEY not configured" }, headers);
    if (!ELEVEN_API_KEY) return reply(500, { error: "ELEVENLABS_API_KEY not configured" }, headers);
    if (!ELEVEN_VOICE_ID) return reply(500, { error: "ELEVENLABS_VOICE_ID not configured" }, headers);

    const body = safeJson(event.body);
    if (!body) return reply(400, { error: "Invalid JSON body" }, headers);
    if (body.test) return reply(200, { message: "API endpoint working", ts: new Date().toISOString() }, headers);

    const { businessId, sessionId, audio, memoryShadow } = body;
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
      const speech = await elevenLabsTTS(msg).catch(() => null);
      return reply(200, {
        sessionId: sid, transcript: "", response: msg,
        audio: speech?.dataUrl, ttsEngine: speech?.engine,
        memoryShadow: brainSnapshot(brain), error: "stt_failed"
      }, headers);
    }

    const words = (transcript || "").trim().split(/\s+/).filter(Boolean);
    if (!transcript?.trim() || words.length < 1) {
      const ask = "I heard something, but I'm not sure what you said. Could you repeat that for me?";
      const speech = await elevenLabsTTS(ask).catch(() => null);
      return reply(200, {
        sessionId: sid, transcript, response: ask,
        audio: speech?.dataUrl, ttsEngine: speech?.engine,
        memoryShadow: brainSnapshot(brain)
      }, headers);
    }

    logConversationTurn(businessId, sid, transcript, "user");

    // quick intents
    const fast = await routeIntentForSeniors(businessId, sid, transcript);
    if (fast) {
      logConversationTurn(businessId, sid, fast.say, "assistant");
      const speech = await elevenLabsTTS(fast.say).catch(() => null);
      return reply(200, {
        sessionId: sid, transcript, response: fast.say,
        audio: speech?.dataUrl, ttsEngine: speech?.engine,
        control: fast.control || undefined,
        memoryShadow: brainSnapshot(ensureBrain(businessId))
      }, headers);
    }

    // main chat
    const answer = await chatWithSeniorMemory(sid, businessId, transcript)
      .catch(() => "I'm having a small technical issue. Could you try that again?");
    logConversationTurn(businessId, sid, answer, "assistant");
    const speech = await elevenLabsTTS(answer).catch(() => null);

    return reply(200, {
      sessionId: sid, transcript, response: answer,
      audio: speech?.dataUrl, ttsEngine: speech?.engine,
      memoryShadow: brainSnapshot(ensureBrain(businessId))
    }, headers);

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

  if (/\b(what can you remember|memory|do you remember)\b/.test(lower) && /\b(how|what|tell me)\b/.test(lower)) {
    const itemCount = brain.items?.length || 0;
    const convCount = brain.conversations?.length || 0;
    return { say: `I remember ${itemCount} important things you've told me, and I keep track of our conversations.` };
  }

  const doctorInfo = lower.match(/^(?:remember|save)\s+(?:my\s+)?doctor'?s?\s+name\s+is\s+(.+?)\.?$/i);
  if (doctorInfo) {
    const name = titleCase(matchOriginal(raw, doctorInfo[1]));
    const item = makeItem("medical-contact", `Doctor: ${name}`, { type_detail: "doctor", name, tags: ["medical","important"], confidence: 1.0 });
    const b = ensureBrain(businessId); b.items.push(item); indexItem(item); pruneMemoryItems(b);
    return { say: `I've saved that your doctor is ${name}.` };
  }

  const medication = lower.match(/^(?:remember|save)\s+(?:my\s+)?(?:medicine|medication|pill)\s+(.+?)\.?$/i);
  if (medication) {
    const med = matchOriginal(raw, medication[1]);
    const item = makeItem("medication", `Medication: ${med}`, { medication: med, tags: ["medical","important"], confidence: 1.0 });
    const b = ensureBrain(businessId); b.items.push(item); indexItem(item); pruneMemoryItems(b);
    return { say: `I've noted your medication ${med}.` };
  }

  const family = lower.match(/^(?:remember|save)\s+(?:my\s+)?(son|daughter|grandson|granddaughter|child|grandchild)'?s?\s+name\s+is\s+(.+?)\.?$/i);
  if (family) {
    const relation = family[1];
    const name = titleCase(matchOriginal(raw, family[2]));
    const item = makeItem("family", `${titleCase(relation)}: ${name}`, { relation, name, tags:["family","important"], confidence: 1.0 });
    const b = ensureBrain(businessId); b.items.push(item); indexItem(item); pruneMemoryItems(b);
    return { say: `I'll remember that your ${relation} is named ${name}.` };
  }

  const remember = lower.match(/^(?:remember|don'?t forget)\s+(.+?)\.?$/i);
  if (remember) {
    const body = matchOriginal(raw, remember[1]);
    const item = makeItem("note", body, { tags:["personal","reminder"], confidence:1.0, timestamp:new Date().toLocaleString() });
    const b = ensureBrain(businessId); if (!isDuplicate(b.items, item.text)) { b.items.push(item); indexItem(item); pruneMemoryItems(b); }
    return { say: "I've made a note of that for you." };
  }

  const doctorRecall = lower.match(/^what'?s\s+(?:my\s+)?doctor'?s?\s+name\??$/i);
  if (doctorRecall) {
    const b = ensureBrain(businessId);
    const doctor = b.items.find(i => i.type === "medical-contact" && i.type_detail === "doctor");
    return { say: doctor ? `Your doctor is ${doctor.name}.` : "I don't have your doctor's name saved yet. Would you like to tell me?" };
  }

  const whereIs = lower.match(/^where\s+(?:did\s+i\s+put|are)\s+(?:my\s+)?(.+?)\??$/i);
  if (whereIs) {
    const item = matchOriginal(raw, whereIs[1]);
    const b = ensureBrain(businessId);
    const relevant = scoreItems(b.items, `put ${item} location`).slice(0, 3);
    if (relevant.length) {
      const locations = relevant.map(r => r.text).join(". ");
      return { say: `Let me think... ${locations}. Does that help?` };
    }
    return { say: `I don't have a note about where you put your ${item}. Next time, just tell me and I'll remember for you.` };
  }

  const familyRecall = lower.match(/^(?:what'?s|who'?s)\s+my\s+(son|daughter|grandson|granddaughter|child|grandchild)'?s?\s+name\??$/i);
  if (familyRecall) {
    const relation = familyRecall[1];
    const b = ensureBrain(businessId);
    const fm = b.items.find(i => i.type === "family" && i.relation?.toLowerCase() === relation.toLowerCase());
    return { say: fm ? `Your ${relation} is ${fm.name}.` : `I don't have your ${relation}'s name saved. Would you like to tell me?` };
  }

  if (/^(?:clear|delete|forget)\s+(?:all\s+)?memory$/i.test(lower))
    return { say: "Are you sure you want me to forget everything? If so, say 'yes, clear everything'." };

  if (/^yes,?\s+clear\s+everything$/i.test(lower)) {
    const b = ensureBrain(businessId);
    b.items = []; b.conversations = []; brainVectors.clear();
    return { say: "I've cleared all my memory. We can start fresh." };
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
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 200,
          temperature: 0.3,
          frequency_penalty: 0.1
        })
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

// ---------- TTS (ElevenLabs Only) ----------
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

async function elevenLabsTTS(text){
  console.log("Using ElevenLabs TTS for:", text.slice(0, 50) + "...");
  
  if (!ELEVEN_API_KEY) {
    throw new Error("ElevenLabs API key not configured");
  }
  
  if (!ELEVEN_VOICE_ID) {
    throw new Error("ElevenLabs Voice ID not configured");
  }

  const sculptedText = sculptForSeniors(text);
  
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
      method: "POST",
      headers: { 
        "xi-api-key": ELEVEN_API_KEY, 
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: sculptedText.slice(0, 2500),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.6,
          similarity_boost: 0.9,
          style: 0.1,
          use_speaker_boost: true
        }
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("ElevenLabs API Error:", res.status, errorText);
      throw new Error(`ElevenLabs ${res.status}: ${errorText}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const b64 = buf.toString("base64");
    
    console.log("ElevenLabs TTS successful, audio length:", buf.length);
    
    return { 
      dataUrl: `data:audio/mpeg;base64,${b64}`, 
      engine: "elevenlabs", 
      volumeBoost: SENIOR_VOLUME_BOOST 
    };
  } catch (error) {
    console.error("ElevenLabs TTS Error:", error);
    throw error;
  }
}

// ---------- Memory ----------
function logConversationTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if (!brain.conversations) brain.conversations = [];
  brain.conversations.push({
    id: uid(),
    sessionId,
    role,
    content,
    timestamp: Date.now(),
    date: new Date().toISOString().split('T')[0],
    timeOfDay: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  });
  if (brain.conversations.length > 1000) {
    brain.conversations = brain.conversations.slice(-1000);
  }
  if (role === "user") autoExtractSeniorInfo(businessId, content);
}

function autoExtractSeniorInfo(businessId, text){
  const brain = ensureBrain(businessId);
  const familyMentions = text.match(/\b(?:my\s+(?:son|daughter|grandson|granddaughter|child|grandchild))\s+\w+/gi);
  if (familyMentions) {
    familyMentions.forEach(m => {
      const item = makeItem("family-mention", m.trim(), { tags: ["family","auto-detected"], confidence: 0.6 });
      if (!isDuplicate(brain.items, item.text)) { brain.items.push(item); indexItem(item); }
    });
  }
  const locations = text.match(/\b(?:put|placed|left|stored)\s+.+?\s+(?:in|on|under|behind)\s+(?:the\s+)?(.+?)(?:\.|,|$)/gi);
  if (locations) {
    locations.forEach(m => {
      if (m.length < 200) {
        const item = makeItem("location", m.trim(), { tags: ["location","auto-detected"], confidence: 0.7 });
        if (!isDuplicate(brain.items, item.text)) { brain.items.push(item); indexItem(item); }
      }
    });
  }
}

function pruneMemoryItems(brain){
  if (brain.items.length <= MAX_MEMORY_ITEMS) return;
  const scored = brain.items.map(item => {
    let score = item.confidence || 0.5;
    const age = Date.now() - (item.updatedAt || item.createdAt);
    const days = age / (1000 * 60 * 60 * 24);
    if (item.type === "family") score += 0.3;
    if (item.type === "medical-contact") score += 0.4;
    if (item.type === "medication") score += 0.35;
    if (item.tags?.includes("important")) score += 0.2;
    score += Math.max(0, 0.1 - (days * 0.001));
    return { ...item, _pruneScore: score };
  });
  scored.sort((a,b) => b._pruneScore - a._pruneScore);
  const toRemove = scored.slice(MAX_MEMORY_ITEMS);
  toRemove.forEach(it => brainVectors.delete(it.id));
  brain.items = scored.slice(0, MAX_MEMORY_ITEMS);
}

function mergeShadow(businessId, shadow){
  const brain = ensureBrain(businessId);
  if (typeof shadow.pace === "number") brain.speed = Math.max(0.6, Math.min(1.0, shadow.pace));
  if (Array.isArray(shadow.items)) {
    const byId = new Map(brain.items.map(i => [i.id, i]));
    for (const it of shadow.items) {
      if (!it || !it.text) continue;
      if (!it.id || !byId.has(it.id)) {
        const newItem = {
          ...it,
          id: it.id || uid(),
          createdAt: it.createdAt || Date.now(),
          updatedAt: it.updatedAt || Date.now()
        };
        brain.items.push(newItem);
        indexItem(newItem);
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
  return {
    items: brain.items,
    conversations: brain.conversations || [],
    pace: brain.speed
  };
}

// --- retry wrapper
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
