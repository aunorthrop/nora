// Echo Chamber v0 — Two-persona debate with voice output
// - Uses one OpenAI model twice with different system/persona scaffolds
// - ElevenLabs voices for A, B, and Moderator (env-configured)
// - Blocks "social" topics you specified
// - Returns per-turn audio (mp3 data URLs) + text

const OPENAI_ROOT = "https://api.openai.com/v1";

// === CONFIG via ENV ===
// Point this to the most current model you have access to.
// You asked for "GPT-5 Thinking" — set OPENAI_MODEL to that model name in Netlify
// if it's available to your account. Otherwise keep a known-good default.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // override in env to "gpt-5-thinking" when ready

const ELEVEN_API_KEY   = process.env.ELEVENLABS_API_KEY || "";
const VOICE_A          = process.env.ELEVENLABS_VOICE_A || process.env.ELEVENLABS_VOICE_ID || ""; // fallback to single voice
const VOICE_B          = process.env.ELEVENLABS_VOICE_B || process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_MODERATOR  = process.env.ELEVENLABS_VOICE_MOD || process.env.ELEVENLABS_VOICE_ID || "";

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

// Rounds and token limits
const MAX_ROUNDS = 3;
const MAX_TOKENS_TURN = 480; // keep spoken turns crisp
const TEMPERATURE = 0.4;

// Blocked topic keywords — “nothing social” per your constraint
const BLOCKED = [
  "abortion","gay marriage","same-sex marriage","lgbt","transgender","gender identity","sexual orientation",
  "religion","race","racism","immigration (social)","culture war","gun control"
];

// Basic helpers
const reply = (code, data, headers) => ({ statusCode: code, headers, body: JSON.stringify(data) });
function tooSocial(topic){
  const s = (topic||"").toLowerCase();
  return BLOCKED.some(k => s.includes(k));
}
function sculptSpeech(text){
  let t = String(text||"").trim();
  t = t.replace(/([.!?])\s+/g,"$1  ").replace(/,\s+/g,",  ").replace(/\s{3,}/g,"  ");
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, 3500);
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type":"application/json",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"POST,OPTIONS,GET",
    "Cache-Control":"no-cache"
  };

  try{
    if (event.httpMethod === "OPTIONS") return reply(200,{ok:true},headers);
    if (event.httpMethod === "GET") return reply(200,{ok:true, ts:new Date().toISOString()},headers);
    if (event.httpMethod !== "POST") return reply(405,{error:"Method Not Allowed"},headers);
    if (!process.env.OPENAI_API_KEY) return reply(500,{error:"OPENAI_API_KEY missing"},headers);

    const body = safeJson(event.body);
    if (!body) return reply(400,{error:"Invalid JSON"},headers);

    const personaA = (body.personaA||"").trim();
    const personaB = (body.personaB||"").trim();
    const topic    = (body.topic||"").trim();
    const rounds   = Math.max(1, Math.min(MAX_ROUNDS, parseInt(body.rounds||"2",10)));
    const withMod  = !!body.moderator;

    if (!personaA || !personaB || !topic){
      return reply(400,{error:"personaA, personaB, topic required"},headers);
    }

    if (tooSocial(topic)){
      return reply(200,{
        blocked:true,
        model: OPENAI_MODEL,
        tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
        message:"Blocked by topic policy."
      },headers);
    }

    // Debate state
    const history = []; // {who:'A'|'B', text:string}
    const turnsOut = [];

    // Opening statements
    const openA = await turnFor("A", personaA, personaB, topic, history, "opening");
    history.push({who:"A", text: openA});
    const audioA = await speak(openA, VOICE_A);
    turnsOut.push({who:"Persona A", text: openA, audio: audioA});

    const openB = await turnFor("B", personaB, personaA, topic, history, "opening");
    history.push({who:"B", text: openB});
    const audioB = await speak(openB, VOICE_B);
    turnsOut.push({who:"Persona B", text: openB, audio: audioB});

    // Rebuttal rounds
    for (let r=1; r<=rounds-1; r++){
      const rebA = await turnFor("A", personaA, personaB, topic, history, "rebuttal");
      history.push({who:"A", text: rebA});
      const aA = await speak(rebA, VOICE_A);
      turnsOut.push({who:`Persona A — Rebuttal ${r}`, text: rebA, audio: aA});

      const rebB = await turnFor("B", personaB, personaA, topic, history, "rebuttal");
      history.push({who:"B", text: rebB});
      const aB = await speak(rebB, VOICE_B);
      turnsOut.push({who:`Persona B — Rebuttal ${r}`, text: rebB, audio: aB});
    }

    // Closing statements
    const closeA = await turnFor("A", personaA, personaB, topic, history, "closing");
    history.push({who:"A", text: closeA});
    const cA = await speak(closeA, VOICE_A);
    turnsOut.push({who:"Persona A — Closing", text: closeA, audio: cA});

    const closeB = await turnFor("B", personaB, personaA, topic, history, "closing");
    history.push({who:"B", text: closeB});
    const cB = await speak(closeB, VOICE_B);
    turnsOut.push({who:"Persona B — Closing", text: closeB, audio: cB});

    // Moderator summary (optional)
    let summary = null;
    if (withMod){
      const sum = await moderatorSummary(topic, personaA, personaB, history);
      const sAud = await speak(sum, VOICE_MODERATOR);
      summary = { text: sum, audio: sAud };
    }

    return reply(200,{
      model: OPENAI_MODEL,
      tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
      turns: turnsOut,
      summary
    },headers);

  } catch (err){
    console.error(err);
    return reply(500,{error:String(err?.message||err)},headers);
  }
};

// ===== Core debate turn =====
async function turnFor(side, selfPersona, oppPersona, topic, history, phase){
  const sys = systemPrompt(selfPersona);
  const opp = oppositeName(side);

  const context = formatHistory(history);

  const user = `
You are ${side === "A" ? "Persona A" : "Persona B"} in a formal debate.

Topic:
${topic}

Your persona (private):
${selfPersona}

Opponent persona (private):
${oppPersona}

Phase: ${phase.toUpperCase()}.

Context so far:
${context}

Write your ${phase} turn. Constraints:
- Max ~180 words.
- Be concrete; cite reasons, mechanisms, or examples.
- No insults, no social-issue content drift.
- End with one memorable takeaway sentence.`;

  const text = await chat(sys, user);
  return sanitizeLine(text);
}

function systemPrompt(persona){
  return `You are a debater speaking *in voice* with a clear, concise style.
Stay firmly within your assigned persona:
${persona}

Rules:
- Be civil, clear, and structured.
- Prefer concrete points over abstractions.
- Avoid medical, legal, and financial advice.
- Avoid social-issue debates (e.g., abortion, gay marriage, culture war). If opponent drifts there, refocus on the given topic.
- Keep ~120–180 words per turn.
- End your turn with one short takeaway sentence.`;
}

function oppositeName(side){ return side === "A" ? "B" : "A"; }
function formatHistory(h){
  if (!h || !h.length) return "(no prior turns)";
  return h.map(t => `${t.who}: ${t.text}`).slice(-10).join("\n\n");
}

async function moderatorSummary(topic, personaA, personaB, history){
  const sys = `You are a neutral moderator. Summarize fairly, then give 3 follow-up questions for the audience to research. Keep it under 180 words.`;
  const user = `
Debate topic:
${topic}

Persona A:
${personaA}

Persona B:
${personaB}

Final transcript (last 10 turns):
${formatHistory(history)}

Write: short summary + exactly 3 questions for further thought.`;
  const text = await chat(sys, user);
  return sanitizeLine(text);
}

// ===== OpenAI chat =====
async function chat(system, user){
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS_TURN,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user   }
      ]
    })
  });
  if (!r.ok){
    const t = await r.text().catch(()=>"(no body)");
    throw new Error(`OpenAI ${r.status}: ${t}`);
  }
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content?.trim() || "";
  return txt;
}

// ===== TTS =====
async function speak(text, elevenVoiceId){
  const speech = sculptSpeech(text);
  // Prefer ElevenLabs if configured; otherwise fall back to OpenAI TTS
  if (process.env.ELEVENLABS_API_KEY && elevenVoiceId){
    try {
      const b64 = await eleven(speech, elevenVoiceId);
      return `data:audio/mpeg;base64,${b64}`;
    } catch (e){
      console.error("ElevenLabs failed, falling back to OpenAI TTS:", e?.message||e);
    }
  }
  try {
    const b64 = await openaiTTS(speech);
    return `data:audio/mpeg;base64,${b64}`;
  } catch (e){
    console.error("OpenAI TTS failed:", e?.message||e);
    return null;
  }
}

async function eleven(text, voiceId){
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      output_format: "mp3_44100_128"
    })
  });
  if (!res.ok){
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`ElevenLabs ${res.status}: ${t}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Tiny buffer from ElevenLabs");
  return buf.toString("base64");
}

async function openaiTTS(text){
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      response_format: "mp3",
      speed: 0.95
    })
  });
  if (!r.ok){
    const t = await r.text().catch(()=>"(no body)");
    throw new Error(`OpenAI TTS ${r.status}: ${t}`);
  }
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

// ===== utils =====
function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function sanitizeLine(s){ return String(s||"").replace(/\s+\n/g,"\n").trim(); }
