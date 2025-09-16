// Nora voice function — server TTS intro, STT→Chat→TTS replies, flexible admin verbs, team-scoped memory
// Requires env: OPENAI_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL  = "whisper-1";
const TTS_MODEL  = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer"; // higher, brighter by default
const OPENAI_TTS_SPEED = parseFloat(process.env.OPENAI_TTS_SPEED || "0.96");

// In-memory store (per lambda instance). Good enough for dev; swap to Redis/Supabase for prod.
const DB = globalThis.__NORA_DB__ || (globalThis.__NORA_DB__ = new Map());
function teamState(code){ if(!DB.has(code)) DB.set(code,{ updates:[], longterm:[], lastTs:Date.now() }); return DB.get(code); }
const ok = (b)=>resp(200,b);
const err = (s,b)=>resp(s,b);
function resp(s, b){ return { statusCode:s, headers:{
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST,OPTIONS"
}, body:JSON.stringify(b)}}
const isCode = s => /^[0-9]{4}-[0-9]{4}$/.test(String(s||""));

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ok:true});
  try{
    if (!OPENAI_API_KEY) return err(500,{error:"OPENAI_API_KEY missing"});
    const body = JSON.parse(event.body||"{}");
    const code = body.businessId;
    if (!isCode(code)) return ok({ error:"missing_or_bad_team_code", control:{requireCode:true} });
    const state = teamState(code);

    // Direct TTS request (when client has text but no audio)
    if (typeof body.say === "string" && body.say.trim()){
      const audio = await tts(body.say);
      return ok({ audio, response: body.say });
    }

    // Intro request — always produce server TTS
    if (body.intro){
      const text = introText();
      const audio = await tts(text);
      return ok({ audio, response:text });
    }

    // Normal speech turn
    const audioIn = body.audio;
    const role = String(body.role || "employee");
    if (!audioIn?.data || !audioIn?.mime) return ok({ audio:null, response:"I’m listening—try again." });

    const userText = (await stt(audioIn.data, audioIn.mime)).trim();
    if (!userText) return ok({ audio:null, response:"I couldn’t hear that—try again." });

    // Role switching by phrase
    const lower = userText.toLowerCase();
    if (/\b(admin( mode)?|i'?m the admin|i am admin)\b/.test(lower)) {
      const say = "Admin mode active. Go ahead with your update—I'll remember it.";
      return ok({ ...(await sayTTS(say)), control:{role:"admin"} });
    }
    if (/\b(employee( mode)?|i'?m (an )?employee)\b/.test(lower)) {
      const say = "Okay, this device is set to employee.";
      return ok({ ...(await sayTTS(say)), control:{role:"employee"} });
    }

    // Admin commands (flexible verbs)
    if (role === "admin") {
      if (/^(remember|save|add|note|store|keep|log|write|record)\b/i.test(userText)) {
        const cleaned = userText.replace(/^(remember|save|add|note|store|keep|log|write|record)\b[:,\-\s]*/i,"").trim();
        state.updates.push({ text: cleaned || userText, ts: Date.now() });
        state.lastTs = Date.now();
        return sayTTS("Saved.");
      }
      if (/^(forget|remove|delete|clear|drop)\b/i.test(userText)) {
        const cleaned = userText.replace(/^(forget|remove|delete|clear|drop)\b[:,\-\s]*/i,"").trim();
        state.updates = state.updates.filter(u => u.text.toLowerCase() !== cleaned.toLowerCase());
        state.lastTs = Date.now();
        return sayTTS("Removed.");
      }
    }

    // Quick built-ins
    if (/\b(what('?| i)s new|any updates|latest)\b/i.test(lower)) {
      const recent = state.updates.slice(-8).map(u=>"• "+u.text).join("  ");
      const say = recent ? `Latest: ${recent}` : "No new updates.";
      return sayTTS(say);
    }
    if (/^(what did you (just )?add|what did you note|what do you have)/i.test(lower)) {
      const recent = state.updates.slice(-6).map(u=>"• "+u.text).join("  ");
      const say = recent ? `I have: ${recent}` : "Nothing saved yet.";
      return sayTTS(say);
    }

    // Smart answer via Chat over your memory
    const memList = [
      ...state.longterm.map(x=>`• ${x.text}`),
      ...state.updates.slice(-40).map(x=>`• ${x.text}`)
    ].join("\n");

    const sys = [
      "You are Nora, a voice-first team assistant.",
      "Primary goals: 1) speak concisely and naturally, 2) prioritize owner/admin updates, 3) answer employees using saved info only.",
      "Never invent policy. If unsure, say you don't have that yet and suggest the admin add it.",
      "Style: warm, brief, helpful. 1–3 sentences per reply.",
      "If the user says “admin” at any time, they intend to give updates.",
      "Use plain language. Avoid filler. If asked to summarize updates, list bullets succinctly."
    ].join(" ");

    const prompt = [
      "Saved context (latest first):",
      memList || "(none yet)",
      "",
      "User asks:",
      userText
    ].join("\n");

    const reply = await chat(sys, prompt);
    return sayTTS(reply || "I don’t have that yet.");

  } catch (e) {
    console.error(e);
    return err(500,{error:"server_error"});
  }
};

// ---------- Helpers ----------
async function sayTTS(text){
  return { audio: await tts(text), response: text };
}

async function stt(b64, mime){
  const buf = Buffer.from(b64,"base64");
  if (buf.length < 600) return "";
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("temperature","0");
  fd.set("file", new Blob([buf], { type: mime || "application/octet-stream" }), "audio.webm");
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{
    method:"POST", headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, body: fd
  });
  if(!r.ok) throw new Error(`STT ${r.status}`);
  const j = await r.json();
  return (j.text||"");
}

async function tts(text){
  const r=await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body:JSON.stringify({
      model:TTS_MODEL,
      voice:OPENAI_TTS_VOICE,       // default shimmer (brighter)
      input: String(text||"").slice(0,4000),
      response_format:"mp3",
      speed: Math.max(0.8, Math.min(1.15, OPENAI_TTS_SPEED))
    })
  });
  if(!r.ok) throw new Error(`TTS ${r.status}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}

async function chat(system, user){
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`,{
    method:"POST",
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body:JSON.stringify({ model: CHAT_MODEL, temperature:0.3, max_tokens:180,
      messages:[ {role:"system", content:system}, {role:"user", content:user} ]
    })
  });
  if(!r.ok) throw new Error(`CHAT ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}

function introText(){
  return "Hi, I’m Nora. I’m on. If you’re the owner, say “admin” and give me the updates and policies—I'll remember them. Team members can ask “what’s new?” or any saved details. Tap again to turn me off.";
}
