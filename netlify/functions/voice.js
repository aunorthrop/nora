const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL  = "whisper-1";
const TTS_MODEL  = "tts-1";
const OPENAI_TTS_VOICE  = process.env.OPENAI_TTS_VOICE || "shimmer";
const OPENAI_TTS_SPEED  = parseFloat(process.env.OPENAI_TTS_SPEED || "1.0");

const UPDATES_TTL_HOURS  = Number(process.env.UPDATES_TTL_HOURS  || 168);
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);

const DB = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
const now = () => Date.now();
function team(id){ if(!DB.has(id)) DB.set(id,{updates:[],longterm:[],docs:[],lastSay:"",lastAdded:null}); return DB.get(id); }
function isCode(s){ return /^[0-9]{4}-[0-9]{4}$/.test(String(s||"")); }
const json = (b, s=200) => ({ statusCode:s, headers:{
  "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"}, body:JSON.stringify(b) });

const ACK_UPDATE = ["Got it.", "Noted.", "Added.", "Okay—saved."];
const ACK_LT     = ["Saved.", "Logged.", "I’ll keep that.", "Stored."];
const ACK_DELETE = ["Deleted.", "Removed.", "Erased."];

const ADMIN_ON_RE = /\b(admin( mode)?|i'?m the admin|i am admin|set admin|switch to admin)\b/i;
const EMP_ON_RE   = /\b(employee( mode)?|i'?m (an )?employee|set employee|switch to employee)\b/i;
const SAVE_INTENT = /^(remember|save|store|keep|log)\b|(\badd|note|please remember|make a note)\b/i;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json({ok:true});
  try{
    const body = JSON.parse(event.body||"{}");
    const code = body.businessId;
    if (!isCode(code)) return json({error:"missing_or_bad_team_code", control:{requireCode:true}});

    const state = team(code);

    // INTRO
    if (body.intro) {
      const text = introText();
      return speak(state, text, { control:{ intro:true }, tts:{ speed: 0.98 }});
    }

    const roleClient = String(body.role||"employee");
    const audio = body.audio||{};
    if (!audio.data || !audio.mime) return speak(state, "I’m listening—try again.");

    // STT
    let transcript = "";
    try { transcript = await transcribeRobust(audio.data, audio.mime); }
    catch { return speak(state, "I couldn’t hear that—try again."); }
    const raw = (transcript||"").trim();
    if (!raw) return speak(state, "I’m listening—try again.");
    const lower = raw.toLowerCase();

    // Help / intro
    if (/\b(help|how do i|how to|instructions|intro)\b/.test(lower)){
      return speak(state, introText(), { tts:{ speed:0.98 }});
    }

    // Role switching
    if (ADMIN_ON_RE.test(lower) && roleClient !== "admin") {
      return speak(state, "Admin mode on. Go ahead with your update.", { control:{ role:"admin" }});
    }
    if (EMP_ON_RE.test(lower) && roleClient !== "employee") {
      return speak(state, "Okay—this device is employee.", { control:{ role:"employee" }});
    }

    // Repeat / memory snapshot
    if (/\b(repeat|say it again|repeat that|what about it)\b/.test(lower)) {
      return state.lastSay ? speak(state, state.lastSay) : speak(state, "There’s nothing to repeat yet.");
    }
    if (/\b(what (did|have) (you )?(just )?(add|note|save|store|log)(ed)?|what did i (just )?(add|say|note))\b/.test(lower)) {
      if (state.lastAdded) return speak(state, `You just saved: “${state.lastAdded.text}”.`);
      return speak(state, "We haven’t saved anything yet.");
    }
    if (/\b(what (do|d'you) (you )?(have|know|remember)|what'?s in (memory|store|storage)|show (me )?(memory|notes|updates))\b/.test(lower)) {
      return speak(state, snapshot(state));
    }

    // Employee "what's new"
    if (roleClient !== "admin" && /\b(what('?| i)s new|any updates|updates (today|for today))\b/.test(lower)) {
      return speak(state, whatsNew(state));
    }

    // --- SAVE INTENT (more forgiving) ---
    if (SAVE_INTENT.test(raw)) {
      // If not admin, do a one-shot escalation with a gentle confirmation
      if (roleClient !== "admin") {
        return speak(state, "I can save that, but only the admin can add info. If you’re the admin, say “admin” and repeat it.");
      }
      // admin path continues below as a regular update/long-term save
    }

    // --- ADMIN branch ---
    if (roleClient === "admin") {
      const looksQ = /[?]$/.test(raw) || /\b(what|when|where|who|why|how|which|do we|can we|should we)\b/i.test(raw);
      if (looksQ) {
        const a = await answerFromMemory(state, raw);
        if (/I don’t have that yet/i.test(a)) return speak(state, "I might not have that. Want me to save the details now?");
        return speak(state, a);
      }

      // Delete
      if (/^(delete|remove|forget)\b/i.test(raw)) {
        const tail = raw.replace(/^(delete|remove|forget)\b[:\-]?\s*/i,"").trim();
        if (!tail) return speak(state, "Tell me what to delete.");
        const rm = tryRemove(state, tail);
        return speak(state, rm ? pick(ACK_DELETE) : "I didn’t find that.");
      }

      // Heuristic: treat as long-term if policy-ish words present
      const isLongTerm =
        /(\bpermanent\b|\balways\b|\bpolicy\b|\bhandbook\b|\bprocedure\b|\bhours\b|\baddress\b|\bphone\b|\bsafety\b|\bmenu\b|\bforever\b|\bpersist\b|\bgeneral info\b)/i.test(raw) ||
        SAVE_INTENT.test(raw);

      const cleaned = raw.replace(SAVE_INTENT, "").replace(/^[:\-.,\s]+/,"").trim();
      const text = cleaned || raw;

      if (isLongTerm) {
        state.longterm.push({ text, ts: now() });
        state.lastAdded = { type:"longterm", text };
        prune(state);
        return speak(state, pick(ACK_LT));
      } else {
        state.updates.push({ text, ts: now() });
        state.lastAdded = { type:"update", text };
        prune(state);
        return speak(state, pick(ACK_UPDATE));
      }
    }

    // --- EMPLOYEE Q&A ---
    const answer = await answerFromMemory(state, raw);
    return speak(state, answer);

  } catch (e) {
    console.error(e);
    return json({ error:"server_error" }, 500);
  }
};

// -------------- helpers --------------
function introText(){
  return "Hi, I’m Nora. Tap once to turn me on—then we just talk. "
    + "If you’re the owner, say “admin” and tell me the updates. I’ll remember them. "
    + "Team members can ask “what’s new?” or anything we’ve saved, like Wi-Fi or hours. "
    + "Tap again to turn me off.";
}
function pick(a){ return a[Math.floor(Math.random()*a.length)] || a[0]; }
function prune(state){
  const cut = now() - UPDATES_TTL_HOURS*3600*1000;
  state.updates  = state.updates.filter(u => (u.ts||0) >= cut).slice(-500);
  state.longterm = state.longterm.slice(-1000);
  state.docs     = state.docs.slice(-200);
}
function whatsNew(state){
  const cut = now() - BRIEF_WINDOW_HOURS*3600*1000;
  const recent = state.updates.filter(u => (u.ts||0) >= cut).map(u=>u.text);
  return recent.length ? "Latest: " + recent.slice(-8).map(s=>"• "+s).join("  ") : "No new updates.";
}
function snapshot(state){
  const r = state.updates.slice(-5).map(u=>u.text);
  const k = state.longterm.slice(-5).map(u=>u.text);
  if (!r.length && !k.length) return "I don’t have anything saved yet.";
  let m = "Here’s a snapshot. ";
  if (r.length) m += "Recent: " + r.map(s=>"• "+s).join("  ") + ". ";
  if (k.length) m += "Key info: " + k.map(s=>"• "+s).join("  ") + ".";
  return m.trim();
}
function tryRemove(state, tail){
  const hitU = [...state.updates].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
  if (hitU >= 0){ state.updates.splice(state.updates.length-1-hitU,1); return true; }
  const hitL = [...state.longterm].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
  if (hitL >= 0){ state.longterm.splice(state.longterm.length-1-hitL,1); return true; }
  return false;
}

async function answerFromMemory(state, question){
  const pool = [
    ...state.longterm.map(x=>({text:x.text})),
    ...state.docs.map(d=>({text:d.text})),
    ...state.updates.map(x=>({text:x.text}))
  ];
  if (pool.length===0) return "I don’t have that yet.";
  const qset = new Set(tok(question));
  const ranked = pool.map(it=>{
    const w=new Set(tok(it.text)); let o=0; for(const t of qset) if(w.has(t)) o++;
    return {it, score: o/Math.max(1,Math.min(qset.size,w.size))};
  }).sort((a,b)=>b.score-a.score);
  const top = ranked.slice(0,8).map(x=>x.it.text);
  const system = "You are Nora, a voice-first team assistant. Answer ONLY from the context. If it’s not covered, say you don’t have that yet. Keep answers brief.";
  const user   = `Question: ${question}\n\nContext:\n- ${top.join("\n- ")}`;
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`,{
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:CHAT_MODEL,messages:[{role:"system",content:system},{role:"user",content:user}],temperature:0.2,max_tokens:220})
  });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content||"I don’t have that yet.").trim();
}
function tok(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

async function transcribeRobust(b64, mime){
  const data = Buffer.from(b64,"base64"); if (data.length<600) return "";
  const tries = [
    {mime:normalizeMime(mime),ext:extFor(mime)},
    {mime:"audio/m4a", ext:".m4a"},
    {mime:"audio/mp4", ext:".mp4"},
    {mime:"audio/webm",ext:".webm"},
    {mime:"audio/mpeg",ext:".mp3"},
    {mime:"audio/wav", ext:".wav"}
  ];
  let last=null;
  for(const t of tries){
    try{
      const fd=new FormData();
      fd.set("model",STT_MODEL); fd.set("temperature","0.2");
      fd.set("prompt","Workplace updates and questions for a team assistant. Short sentences, names, SKU codes.");
      fd.set("file",new Blob([data],{type:t.mime}),"audio"+t.ext);
      const r=await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},body:fd});
      if(!r.ok){ last=new Error(`STT ${r.status}: ${await r.text()}`); continue; }
      const j=await r.json(); const text=(j.text||"").trim(); if(text) return text;
    }catch(e){ last=e; continue; }
  }
  throw last || new Error("unrecognized_audio");
}
function normalizeMime(m){
  const s=String(m||"").toLowerCase();
  if(s.includes("webm"))return"audio/webm";
  if(s.includes("m4a")) return"audio/m4a";
  if(s.includes("mp4")) return"audio/mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga")) return"audio/mpeg";
  if(s.includes("wav")) return"audio/wav";
  if(s.includes("ogg")||s.includes("oga")) return"audio/ogg";
  return "audio/webm";
}
function extFor(m){
  const s=String(m||"").toLowerCase();
  if(s.includes("webm"))return".webm";
  if(s.includes("m4a")) return".m4a";
  if(s.includes("mp4")) return".mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga")) return".mp3";
  if(s.includes("wav")) return".wav";
  if(s.includes("ogg")||s.includes("oga")) return".ogg";
  return ".webm";
}

async function tts(text, opts={}){
  const speed = typeof opts.speed === "number" ? opts.speed : OPENAI_TTS_SPEED;
  const r=await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:TTS_MODEL,voice:OPENAI_TTS_VOICE,input:sculpt(text),response_format:"mp3",speed})
  });
  if(!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
function sculpt(t){ let s=String(t||"").trim(); s=s.replace(/([.!?])\s+/g,"$1 "); if(!/[.!?…]$/.test(s)) s+="."; return s.slice(0,4000); }
async function speak(state, text, extra){ state.lastSay=text; const audio=await tts(text, extra?.tts||{}); return json({audio, ...(extra||{})}); }
