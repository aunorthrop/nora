// Returns a short intro (first-run) or a quick "what's new" snippet as TTS.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";

const DB = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
function isCode(s){ return /^[0-9]{4}-[0-9]{4}$/.test(String(s||"")); }
function team(id){ if(!DB.has(id)) DB.set(id,{updates:[],longterm:[],docs:[],lastSay:""}); return DB.get(id); }
const now = ()=>Date.now();
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS||24);

const j=(b,s=200)=>({statusCode:s,headers:{
  "Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"
},body:JSON.stringify(b)});

export const handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return j({ok:true});
  const qs = event.queryStringParameters || {};
  const businessId = qs.businessId || "";
  const first = qs.first==="1";
  if(!isCode(businessId)) return j({error:"missing_or_bad_team_code"},400);

  let text = "";
  if(first){
    text = "Hi, I’m Nora. I’ll remember what you tell me and share team updates. Are you the admin? Say yes or no.";
  }else{
    const state = team(businessId);
    const cut = now()-BRIEF_WINDOW_HOURS*3600*1000;
    const recent = state.updates.filter(u=>(u.ts||0)>=cut).map(u=>u.text);
    text = recent.length ? "Here’s the latest. " + recent.slice(-8).map(s=>"• "+s).join("  ") : "No new updates right now.";
  }

  const audio = await tts(text);
  return j({audio});
};

async function tts(text){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`,{
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({model:TTS_MODEL,voice:OPENAI_TTS_VOICE,input:text,response_format:"mp3",speed:1.0})
  });
  if(!r.ok) throw new Error(await r.text());
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
