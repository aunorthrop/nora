const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL  = "whisper-1";
const TTS_MODEL  = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";

const UPDATES_TTL_HOURS  = Number(process.env.UPDATES_TTL_HOURS  || 168);
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);

const DB = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
const now=()=>Date.now();
function isCode(s){ return /^[0-9]{4}-[0-9]{4}$/.test(String(s||"")); }
function team(id){ if(!DB.has(id)) DB.set(id,{updates:[],longterm:[],docs:[],lastSay:"",lastAdded:null}); return DB.get(id); }
const j=(b,s=200)=>({statusCode:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"},body:JSON.stringify(b)});

const ACK_UPDATE = ["Got it — added.", "Okay, added to today.", "Noted for today.", "Added to the updates."];
const ACK_LT     = ["Saved for the handbook.", "I’ll keep that.", "Logged for long-term.", "Stored permanently."];
const ACK_DELETE = ["Deleted.", "Removed.", "Erased."];

export const handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return j({ok:true});
  try{
    const body = JSON.parse(event.body||"{}");
    const businessId = body.businessId;
    if(!isCode(businessId)) return j({error:"missing_or_bad_team_code",control:{requireCode:true}});

    const role = String(body.role||"employee");
    const expectRole = !!body.expectRole;
    const audio = body.audio||{};
    if(!audio.data || !audio.mime) return j({error:"no_audio"});

    // STT
    let transcript=""; try{ transcript = await transcribeRobust(audio.data, audio.mime); }
    catch(e){ return j({error:`STT ${e.message||'failed'}`}); }
    const raw=(transcript||"").trim(); if(!raw) return say(team(businessId),"I didn’t catch that. Try again.");
    const lower=raw.toLowerCase();
    const state=team(businessId);

    // first-run: answer yes/no admin
    if(expectRole){
      const isYes=/\b(yes|yeah|yep|i am|i'm|admin)\b/.test(lower);
      const isNo =/\b(no|nope|not|employee|staff)\b/.test(lower);
      if(isYes && !isNo) return say(state,"Great — admin mode set for this device.",{control:{role:"admin"}});
      if(isNo  && !isYes) return say(state,"Okay — this device is set as employee.",{control:{role:"employee"}});
      return say(state,"Was that yes or no? Say yes if you’re the admin, otherwise no.",{control:{askRoleAgain:true}});
    }

    // global repeats
    if(/\b(repeat|say it again|one more time|repeat that)\b/.test(lower)){
      return state.lastSay ? say(state,state.lastSay) : say(state,"There’s nothing to repeat yet.");
    }

    // ADMIN — everything you say becomes knowledge
    if(role==="admin"){
      // quick recall of last addition
      if(/\b(what about it|what did i just say|what was that|repeat the last thing)\b/.test(lower)){
        if(state.lastAdded){ return say(state, `You just added: “${state.lastAdded.text}”.`); }
        return say(state,"We haven’t saved anything this session yet.");
      }

      // delete / forget
      if(/^(delete|remove|forget)\b/.test(lower)){
        const tail = raw.replace(/^(delete|remove|forget)\b[:\-]?\s*/i,"").trim();
        if(!tail) return say(state,"Tell me what to delete.");
        const uIdx = [...state.updates].reverse().findIndex(u=>u.text.toLowerCase().includes(tail.toLowerCase()));
        if(uIdx>=0){ state.updates.splice(state.updates.length-1-uIdx,1); return say(state, pick(ACK_DELETE)); }
        const lIdx = [...state.longterm].reverse().findIndex(u=>u.text.toLowerCase().includes(tail.toLowerCase()));
        if(lIdx>=0){ state.longterm.splice(state.longterm.length-1-lIdx,1); return say(state, pick(ACK_DELETE)); }
        return say(state,"I didn’t find a match to delete.");
      }

      // classify: long-term if it sounds permanent/policy-ish; else update
      const isLT = /(\bpermanent\b|\balways\b|\bpolicy\b|\bhandbook\b|\bprocedure\b|\baddress\b|\bphone\b|\bhours\b|\bsafety\b|\bmenu\b|\bforever\b|\bpersist\b)/i.test(raw)
                || /^(remember|save|store|keep|log)\b/i.test(raw);
      if(isLT){
        const text = raw.replace(/^(remember|save|store|keep|log)\b[:\-]?\s*/i,"").trim();
        state.longterm.push({text,ts:now()}); state.lastAdded={type:"longterm",text}; prune(state);
        return say(state,pick(ACK_LT));
      }else{
        state.updates.push({text:raw,ts:now()}); state.lastAdded={type:"update",text:raw}; prune(state);
        return say(state,pick(ACK_UPDATE));
      }
    }

    // EMPLOYEE — quick "what's new" phrase handled on client; here we do Q&A
    if(/\b(what('?| i)s new|any updates|updates (today|for today))\b/.test(lower)){
      const msg = whatsNewMsg(state); return say(state,msg);
    }

    const answer = await answerFromMemory(state, raw);
    return say(state, answer);

  }catch(e){ console.error(e); return j({error:"server_error"},500); }
};

// ---------- helpers ----------
function prune(state){
  const cut=now()-UPDATES_TTL_HOURS*3600*1000;
  state.updates  = state.updates.filter(u=>(u.ts||0)>=cut).slice(-500);
  state.longterm = state.longterm.slice(-1000);
  state.docs     = state.docs.slice(-200);
}
function whatsNewMsg(state){
  const cut=now()-BRIEF_WINDOW_HOURS*3600*1000;
  const recent=state.updates.filter(u=>(u.ts||0)>=cut).map(u=>u.text);
  return recent.length? "Here’s the latest. "+recent.slice(-8).map(s=>"• "+s).join("  ") : "No new updates right now.";
}
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)] || arr[0]; }

async function answerFromMemory(state, question){
  const pool=[...state.longterm.map(x=>({text:x.text})), ...state.docs.map(d=>({text:d.text}))];
  if(pool.length===0) return "I don’t have that yet. Ask your admin to add it.";
  const qset=new Set(tok(question));
  const ranked=pool.map(it=>{const w=new Set(tok(it.text)); let o=0; for(const t of qset) if(w.has(t)) o++; return {it,score:o/Math.max(1,Math.min(qset.size,w.size))};})
                   .sort((a,b)=>b.score-a.score);
  const top=ranked.slice(0,6).map(x=>x.it.text);
  const system="You are Nora, a voice-first team assistant. Answer ONLY from the context. If it’s not covered, say you don’t have that yet. Keep answers brief.";
  const user=`Question: ${question}\n\nContext:\n- ${top.join("\n- ")}`;
  const r=await fetch(`${OPENAI_ROOT}/chat/completions`,{
    method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:CHAT_MODEL,messages:[{role:"system",content:system},{role:"user",content:user}],temperature:0.2,max_tokens:220})
  });
  if(!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j=await r.json();
  return (j.choices?.[0]?.message?.content||"I don’t have that yet.").trim();
}
function tok(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

async function transcribeRobust(b64, mime){
  const data=Buffer.from(b64,"base64"); if(data.length<600) return "";
  const attempts=[
    {mime:norm(mime),ext:extFor(mime)},{mime:"audio/m4a",ext:".m4a"},{mime:"audio/mp4",ext:".mp4"},
    {mime:"audio/webm",ext:".webm"},{mime:"audio/mpeg",ext:".mp3"},{mime:"audio/wav",ext:".wav"}
  ];
  let last=null;
  for(const a of attempts){
    try{
      const fd=new FormData();
      fd.set("model",STT_MODEL); fd.set("temperature","0.2");
      fd.set("prompt","Short workplace update or question for a team assistant.");
      fd.set("file",new Blob([data],{type:a.mime}),"audio"+a.ext);
      const r=await fetch(`${OPENAI_ROOT}/audio/transcriptions`,{method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},body:fd});
      if(!r.ok){ last=new Error(`STT ${r.status}: ${await r.text()}`); continue; }
      const j=await r.json(); const text=(j.text||"").trim(); if(text) return text;
    }catch(e){ last=e; continue; }
  }
  throw last||new Error("unrecognized_audio");
}
function norm(m){ const s=String(m||"").toLowerCase();
  if(s.includes("webm"))return"audio/webm"; if(s.includes("m4a"))return"audio/m4a"; if(s.includes("mp4"))return"audio/mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga"))return"audio/mpeg"; if(s.includes("wav"))return"audio/wav";
  if(s.includes("ogg")||s.includes("oga"))return"audio/ogg"; return"audio/webm"; }
function extFor(m){ const s=String(m||"").toLowerCase();
  if(s.includes("webm"))return".webm"; if(s.includes("m4a"))return".m4a"; if(s.includes("mp4"))return".mp4";
  if(s.includes("mp3")||s.includes("mpeg")||s.includes("mpga"))return".mp3"; if(s.includes("wav"))return".wav";
  if(s.includes("ogg")||s.includes("oga"))return".ogg"; return".webm"; }

async function tts(text){
  const r=await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:TTS_MODEL,voice:OPENAI_TTS_VOICE,input:sculpt(text),response_format:"mp3",speed:1.0})
  });
  if(!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b64=Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
function sculpt(t){ let s=String(t||"").trim(); s=s.replace(/([.!?])\s+/g,"$1  "); if(!/[.!?…]$/.test(s)) s+="."; return s.slice(0,4000); }
async function say(state,text,extra){ state.lastSay=text; const audio=await tts(text); return j({audio, ...(extra||{})}); }
