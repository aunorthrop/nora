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
const memoryStore = new Map();
const deviceBrain = new Map();

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

function ensureBrain(businessId){
  if (!deviceBrain.has(businessId)) deviceBrain.set(businessId, { voice: DEFAULT_VOICE, speed: DEFAULT_SPEED, items: [], conversations: [] });
  return deviceBrain.get(businessId);
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

    const { businessId, sessionId, audio, memoryShadow, tts } = body;
    if (!businessId || !audio?.data || !audio?.mime)
      return reply(400, { error: "Missing required information" }, headers);

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const brain = ensureBrain(businessId);
    if (typeof memoryShadow?.pace === "number") brain.speed = Math.max(0.6, Math.min(1.0, memoryShadow.pace));

    // --- STT
    let transcript = "";
    try {
      transcript = await withRetry(() => transcribe(audio.data, audio.mime), 2);
    } catch (e) {
      const msg = "I'm having trouble hearing you. Please try again.";
      const speech = await safeTTS(msg, brain, { preferEleven: true }).catch(() => null);
      return reply(200, { sessionId: sid, transcript: "", response: msg, audio: speech?.dataUrl, ttsEngine: speech?.engine, error: "stt_failed" }, headers);
    }

    if (!/\S/.test(transcript || "")) {
      const ask = "I heard silence or very little audio. Could you repeat that?";
      const speech = await safeTTS(ask, brain, { preferEleven: true }).catch(() => null);
      return reply(200, { sessionId: sid, transcript, response: ask, audio: speech?.dataUrl, ttsEngine: speech?.engine }, headers);
    }

    logTurn(businessId, sid, transcript, "user");

    // quick tiny assistant logic; keep it minimal
    const quick = routeQuick(transcript);
    if (quick) {
      logTurn(businessId, sid, quick.say, "assistant");
      const speech = await safeTTS(quick.say, brain, { preferEleven: true }).catch(err => ({ dataUrl:null, engine:null, error:String(err?.message||err) }));
      return reply(200, { sessionId: sid, transcript, response: quick.say, audio: speech?.dataUrl, ttsEngine: speech?.engine, error: speech?.error }, headers);
    }

    // main chat
    const answer = await chatMini(sid, transcript).catch(() => "I'm having a small technical issue. Could you try again?");
    logTurn(businessId, sid, answer, "assistant");
    const speech = await safeTTS(answer, brain, { preferEleven: true }).catch(err => ({ dataUrl:null, engine:null, error:String(err?.message||err) }));

    return reply(200, { sessionId: sid, transcript, response: answer, audio: speech?.dataUrl, ttsEngine: speech?.engine, error: speech?.error }, headers);

  } catch (err) {
    console.error("Handler error:", err);
    return reply(500, { error: `Internal server error: ${err.message}` }, headers);
  }
};

// ---------- STT ----------
async function transcribe(b64, mime){
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 300) return "";

  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language", "en");
  fd.set("temperature", "0.2");
  fd.set("prompt", "Conversational speech, possibly with pauses.");

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

// ---------- quick intents ----------
function routeQuick(txt){
  const lower = String(txt).toLowerCase();
  if (/\b(can you hear me|are you there)\b/.test(lower)) return { say: "Yes, I can hear you." };
  if (/\btoo (quiet|low)|speak up|louder\b/.test(lower)) return { say: "I'll speak a little louder. Is this better?" };
  if (/\bslow(er)?\b/.test(lower)) return { say: "I'll slow down my speech a bit." };
  return null;
}

// ---------- chat (minimal) ----------
async function chatMini(sessionId, userText){
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role: "user", content: userText });
  const trimmed = hist.slice(-16);
  memoryStore.set(sessionId, trimmed);

  const system = { role: "system", content:
`You are a short, clear, helpful voice assistant. Keep replies 2–4 sentences.` };

  const messages = [system, ...trimmed];
  const order = [CHAT_PRIMARY, ...CHAT_FALLBACKS];
  let lastErr;
  for (const model of order) {
    try {
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: 200, temperature: 0.3 })
      });
      if (!res.ok) { lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); continue; }
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim();
      if (reply) {
        trimmed.push({ role: "assistant", content: reply });
        memoryStore.set(sessionId, trimmed.slice(-16));
        return reply;
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---------- TTS ----------
function sculpt(text){
  let t = String(text || "").trim();
  t = t.replace(/([.!?])\s+/g, "$1  ").replace(/,\s+/g, ",  ").replace(/;\s+/g, ";  ").replace(/ - /g, ", ").replace(/\s{3,}/g, "  ");
  if (!/[.!?…]$/.test(t)) t += ".";
  return t;
}

async function ttsOpenAI(text, speed){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: text.length > 100 ? TTS_MODEL_HD : TTS_MODEL_DEFAULT,
      voice: DEFAULT_VOICE,
      input: sculpt(text).slice(0, 4000),
      response_format: "mp3",
      speed: Math.max(0.6, Math.min(1.0, speed || DEFAULT_SPEED))
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

async function ttsEleven(text){
  if (!ELEVEN_API_KEY) throw new Error("ELEVENLABS_API_KEY not configured");
  if (!ELEVEN_VOICE_ID_ENV) throw new Error("ELEVENLABS_VOICE_ID not configured");
  const clean = sculpt(text).slice(0, 2500);

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID_ENV}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({
      text: clean,
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

/**
 * Prefer Eleven (env voice). If Eleven fails for any reason,
 * return an **audible** OpenAI TTS explanation so the client never sits silent.
 */
async function safeTTS(text, brain, opts = { preferEleven: true }){
  const preferEleven = !!opts.preferEleven;
  if (preferEleven) {
    try {
      const b64 = await withRetry(() => ttsEleven(text), 1);
      return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "elevenlabs", volumeBoost: SENIOR_VOLUME_BOOST };
    } catch (err) {
      const msg = shortExplain(err);
      // speak the error via OpenAI so the user hears *something*
      try {
        const b64 = await withRetry(() => ttsOpenAI(`There was a problem using ElevenLabs. ${msg}`, brain.speed), 1);
        return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "openai-tts-1", volumeBoost: SENIOR_VOLUME_BOOST, error: msg };
      } catch {
        // last resort: return no audio but include error text
        return { dataUrl: null, engine: null, error: msg };
      }
    }
  }

  // Not preferring Eleven: just use OpenAI
  const b64 = await withRetry(() => ttsOpenAI(text, brain.speed), 2);
  return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "openai-tts-1", volumeBoost: SENIOR_VOLUME_BOOST };
}

function shortExplain(err){
  const s = String(err?.message || err || "");
  if (/401|403/.test(s)) return "Your ElevenLabs API key was rejected.";
  if (/404/.test(s)) return "The ElevenLabs voice ID was not found.";
  if (/402|quota|credit/i.test(s)) return "It looks like your ElevenLabs credits may be out.";
  if (/429/.test(s)) return "ElevenLabs rate limit hit; try again shortly.";
  return s.slice(0, 180);
}

// ---------- misc ----------
function logTurn(businessId, sessionId, content, role){
  const brain = ensureBrain(businessId);
  if (!brain.conversations) brain.conversations = [];
  brain.conversations.push({ id: uid(), sessionId, role, content, ts: Date.now() });
  if (brain.conversations.length > 1000) brain.conversations = brain.conversations.slice(-1000);
}

async function withRetry(fn, n){
  try { return await fn(); }
  catch(e){
    if (n <= 0 || !/429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message || ""))) throw e;
    await sleep(300);
    return withRetry(fn, n - 1);
  }
}
