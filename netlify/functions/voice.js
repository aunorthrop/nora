// Nora voice brain: STT -> intent router (admin/employee) -> TTS
// No external deps (Netlify Functions / Node 18)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";

const UPDATES_TTL_HOURS = Number(process.env.UPDATES_TTL_HOURS || 168); // 7d
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);

const db = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
function team(id){ if(!db.has(id)) db.set(id,{updates:[],longterm:[],docs:[]}); return db.get(id); }
function isCode(s){ return /^[0-9]{4}-[0-9]{4}$/.test(String(s||"")); }
const now = () => Date.now();

function json(body,status=200){ return {statusCode:status,headers:{
  "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"},body:JSON.stringify(body)}; }

export const handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return json({ok:true});
  try{
    const body = JSON.parse(event.body||"{}");
    const businessId = body.businessId;
    const mode = String(body.mode||"normal");
    if(!isCode(businessId)) return json({error:"missing_or_bad_team_code",control:{requireCode:true}});
    const audio = body.audio||{};
    if(!audio.data||!audio.mime) return json({error:"no_audio"});

    // --- STT with aggressive MIME/extension fallbacks ---
    let transcript="";
    try{
      transcript = await transcribeRobust(audio.data, audio.mime);
    }catch(e){
      return json({error:`STT ${e.message||"failed"}`});
    }
    const raw = (transcript||"").trim();
    if(!raw){
      const audioUrl = await tts("I didn’t catch that. Try again a little closer to the mic.");
      return json({audio:audioUrl});
    }

    // --- Intent routing ---
    const t = raw.toLowerCase();
    const state = team(businessId);

    // arm admin
    if(/^(admin|i am the admin)\b/.test(t)){
      const audioUrl = await tts("Admin mode armed. Say your updates. Say “long-term: …” for permanent notes. Say “delete …” to remove. Say “done” when finished.");
      return json({audio:audioUrl, control:{adminArmed:true}});
    }

    // admin session
    if(mode==="admin-armed"){
      if(/\b(done|finish|finished|that'?s all|that is all)\b/.test(t)){
        const audioUrl = await tts("Saved. Admin mode off.");
        return json({audio:audioUrl, control:{adminDisarm:true}});
      }
      if(/^delete\b/.test(t)){
        const tail = raw.replace(/^delete\b[:\-]?\s*/i,"").trim();
        const idx = [...state.updates].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
        if(idx>=0){ state.updates.splice(state.updates.length-1-idx,1); const au=await tts("Deleted that update."); return json({audio:au}); }
        const au = await tts("I didn’t find a matching update to delete.");
        return json({audio:au});
      }
      const lt = raw.match(/^(long\s*[- ]?\s*term|remember|permanent)[:\-]?\s*(.+)$/i);
      if(lt&&lt[2]){ state.longterm.push({text:lt[2].trim(),ts:now()}); const au=await tts("Saved to long-term."); return json({audio:au}); }

      state.updates.push({text:raw,ts:now()}); prune(state);
      const au = await tts("Added to today’s updates.");
      return json({audio:au});
    }

    // employee / normal
    if(/\b(what('?| i)s new|any updates|updates today)\b/.test(t)){
      const cut = now()-BRIEF_WINDOW_HOURS*3600*1000;
      const recent = state.updates.filter(u=>(u.ts||0)>=cut).map(u=>u.text);
      const text = recent.length? "Here’s the latest. "+ bullets(recent.slice(-8)) : "No new updates right now.";
      const au = await tts(text); return json({audio:au});
    }

    // Q&A from long-term + docs
    const answer = await answerFromMemory(state, raw);
    const au = await tts(answer);
    return json({audio:au});

  }catch(e){ console.error(e); return json({error:"server_error"},500); }
};

// ---------- helpers ----------
function bullets(arr){ return arr.map(s=>"• "+s).join("  "); }
function prune(state){
  const cut = now()-UPDATES_TTL_HOURS*3600*1000;
  state.updates = state.updates.filter(u=>(u.ts||0)>=cut).slice(-500);
  state.longterm = state.longterm.slice(-1000);
  state.docs = state.docs.slice(-200);
}

async function transcribeRobust(b64, mime){
  const data = Buffer.from(b64,"base64");
  if(data.length<600) return "";

  const attempts = [
    {mime: normalizeMime(mime), ext: chooseExt(mime)},
    {mime: "audio/m4a", ext: ".m4a"},
    {mime: "audio/mp4", ext: ".mp4"},
    {mime: "audio/webm", ext: ".webm"},
    {mime: "audio/mpeg", ext: ".mp3"},
    {mime: "audio/wav", ext: ".wav"},
  ];

  let lastErr=null;
  for (const a of attempts){
    try{
      const fd = new FormData();
      fd.set("model", STT_MODEL);
      fd.set("temperature","0.2");
      fd.set("prompt","Short workplace update or question for a team assistant.");
      fd.set("file", new Blob([data], {type:a.mime}), "audio"+a.ext);
      const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
        method:"POST", headers:{Authorization:`Bearer ${OPENAI_API_KEY}`}, body:fd
      });
      if(!r.ok){ lastErr = new Error(`STT ${r.status}: ${await r.text()}`); continue; }
      const j = await r.json();
      const text = (j.text||"").trim();
      if(text) return text;
      // if seconds:0 or empty, try next variant
    }catch(e){ lastErr=e; continue; }
  }
  throw lastErr||new Error("unrecognized_audio");
}

function normalizeMime(m){
  const s=String(m||"").toLowerCase();
  if(s.includes("webm")) return "audio/webm";
  if(s.includes("m4a")) return "audio/m4a";
  if(s.includes("mp4")) return "audio/mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga")) return "audio/mpeg";
  if(s.includes("wav")) return "audio/wav";
  if(s.includes("ogg")||s.includes("oga")) return "audio/ogg";
  return "audio/webm";
}
function chooseExt(m){
  const s=String(m||"").toLowerCase();
  if(s.includes("webm")) return ".webm";
  if(s.includes("m4a")) return ".m4a";
  if(s.includes("mp4")) return ".mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga")) return ".mp3";
  if(s.includes("wav")) return ".wav";
  if(s.includes("ogg")||s.includes("oga")) return ".ogg";
  return ".webm";
}

async function tts(text){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({ model:TTS_MODEL, voice:OPENAI_TTS_VOICE, input:sculpt(text), response_format:"mp3", speed:1.0 })
  });
  if(!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
function sculpt(t){ let s=String(t||"").trim(); s=s.replace(/([.!?])\s+/g,"$1  "); if(!/[.!?…]$/.test(s)) s+="."; return s.slice(0,4000); }

async function answerFromMemory(state, question){
  const pool=[...state.longterm.map(x=>({type:"lt",text:x.text})), ...state.docs.map(d=>({type:"doc",text:d.text,name:d.name}))];
  if(pool.length===0) return "I don’t have that information yet. Ask your admin to add it.";
  const qset=new Set(tok(question));
  const scored=pool.map(it=>{const w=new Set(tok(it.text)); let o=0; for(const t of qset) if(w.has(t)) o++; return {it,score:o/Math.max(1,Math.min(qset.size,w.size))};})
                   .sort((a,b)=>b.score-a.score);
  const top=scored.slice(0,6).map(x=>x.it.text);
  const system="You are Nora, a voice-first team assistant. Answer ONLY using the provided context. If not covered, say you don't have that yet. Keep answers brief.";
  const user=`Question: ${question}\n\nContext:\n- ${top.join("\n- ")}`;
  const r=await fetch(`${OPENAI_ROOT}/chat/completions`,{method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:CHAT_MODEL,messages:[{role:"system",content:system},{role:"user",content:user}],temperature:0.2,max_tokens:220})});
  if(!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j=await r.json(); return (j.choices?.[0]?.message?.content||"I don’t have that information yet.").trim();
}
function tok(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }
