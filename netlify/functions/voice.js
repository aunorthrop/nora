// Minimal, sturdy voice function with guaranteed intro + TTS fallback signal

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL  = "whisper-1";
const TTS_MODEL  = "tts-1";
const OPENAI_TTS_VOICE  = process.env.OPENAI_TTS_VOICE || "alloy"; // safe default
const OPENAI_TTS_SPEED  = parseFloat(process.env.OPENAI_TTS_SPEED || "1.0");

const DB = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
const now = () => Date.now();
function team(id){ if(!DB.has(id)) DB.set(id,{updates:[],longterm:[],lastSay:""}); return DB.get(id); }
function isCode(s){ return /^[0-9]{4}-[0-9]{4}$/.test(String(s||"")); }

const json = (b, s=200) => ({ statusCode:s, headers:{
  "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"}, body:JSON.stringify(b) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json({ok:true});
  try{
    const body = JSON.parse(event.body||"{}");
    const code = body.businessId;
    if (!isCode(code)) return json({ error:"missing_or_bad_team_code", control:{requireCode:true} });

    const state = team(code);

    // INTRO path: always return something usable
    if (body.intro) {
      const text = "Hi, I’m Nora. I’m on. If you’re the owner, say “admin” and tell me the updates—I'll remember them. Team members can ask “what’s new?” or anything we’ve saved. Tap again to turn me off.";
      const audio = await safeTTS(text).catch(()=>null);
      return json(audio ? { audio, response:text } : { audio:null, response:text });
    }

    // Normal turn requires audio
    const audio = body.audio||{};
    if (!audio.data || !audio.mime) return json({ audio:null, response:"I’m listening—try again." });

    const transcript = await transcribe(audio.data, audio.mime).catch(()=> "");
    const raw = (transcript||"").trim();
    if (!raw) return json({ audio:null, response:"I couldn’t hear that—try again." });

    // Quick intents
    const lower = raw.toLowerCase();
    if (/\b(admin( mode)?|i'?m the admin|i am admin)\b/.test(lower))
      return say(state, "Admin mode on. Go ahead with your update.", { control:{ role:"admin" }});
    if (/\b(employee( mode)?)\b/.test(lower))
      return say(state, "Okay—this device is employee.", { control:{ role:"employee" }});

    // Simple memory: admin saves, employee asks
    const role = String(body.role||"employee");
    if (role === "admin" && /^(remember|save|add|note|store|keep|log)\b/i.test(raw)) {
      const cleaned = raw.replace(/^(remember|save|add|note|store|keep|log)\b[:,\-\s]*/i,"").trim();
      state.updates.push({ text: cleaned||raw, ts: now() });
      return say(state, "Saved.");
    }
    if (/\b(what('?| i)s new|any updates)\b/i.test(lower)) {
      const recent = state.updates.slice(-8).map(u=>"• "+u.text).join("  ");
      return say(state, recent ? "Latest: " + recent : "No new updates.");
    }

    // Q&A from memory (ultra-simple)
    const answer = answerFromMemory(state, raw);
    return say(state, answer || "I don’t have that yet.");

  } catch (e) {
    console.error(e);
    return json({ error:"server_error" }, 500);
  }
};

// ------- helpers
function answerFromMemory(state, q){
  // naive lexical match over saved updates/longterm
  const pool = [...state.longterm.map(x=>x.text), ...state.updates.map(x=>x.text)];
  if(!pool.length) return "";
  const qs = toks(q); let best="", score=-1;
  for(const t of pool){
    const ts=toks(t); let overlap=0; for(const w of qs) if(ts.has(w)) overlap++;
    const s = overlap / Math.max(1, Math.min(qs.size, ts.size));
    if(s>score){ score=s; best=t; }
  }
  return score>0 ? best : "";
}
function toks(s){ return new Set(String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean)); }

async function say(state, text, extra={}){
  state.lastSay = text;
  const audio = await safeTTS(text).catch(()=>null);
  return json(audio ? { audio, response:text, ...extra } : { audio:null, response:text, ...extra });
}

async function transcribe(b64, mime){
  const data = Buffer.from(b64,"base64");
  if (data.length < 600) return "";

  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("temperature","0");
  fd.set("file", new Blob([data], { type: mime || "application/octet-stream" }), "audio.webm");

  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{
    method:"POST",
    headers:{ Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd
  });
  if(!r.ok) throw new Error(`STT ${r.status}`);
  const j = await r.json();
  return (j.text||"").trim();
}

async function safeTTS(text){
  const r=await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body:JSON.stringify({
      model:TTS_MODEL, voice:OPENAI_TTS_VOICE,
      input: String(text||"").slice(0,4000),
      response_format:"mp3", speed: Math.max(0.8, Math.min(1.2, OPENAI_TTS_SPEED))
    })
  });
  if(!r.ok) throw new Error(`TTS ${r.status}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
