// Echo Chamber v0.2 — Two-persona debate with controlled turn-taking + optional interjections
// - JSON-mode turns so speakers know when to stop
// - Optional short interjections based on persona and a small probability
// - ElevenLabs first for TTS (per-voice), OpenAI TTS fallback (never silent)
// - Blocks specified “social” topics
// - Tight error logging so 500s are diagnosable

const OPENAI_ROOT = "https://api.openai.com/v1";

// ---- ENV / CONFIG ----
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // set in Netlify if you have a newer model
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const VOICE_A         = process.env.ELEVENLABS_VOICE_A || process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_B         = process.env.ELEVENLABS_VOICE_B || process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_MOD       = process.env.ELEVENLABS_VOICE_MOD || process.env.ELEVENLABS_VOICE_ID || "";

const TEMPERATURE = 0.4;
const MAX_TOKENS_TURN = 520;
const MAX_ROUNDS = 3;

// “Nothing social” guardrail
const BLOCKED = [
  "abortion","gay marriage","same-sex marriage","lgbt","transgender","gender identity",
  "sexual orientation","religion","race","racism","culture war","gun control"
];

// Interjection behavior
const BASE_INTERJECT_PROB = 0.25; // can be implicitly nudged by persona wording
const MAX_INTERJECTION_SENTENCES = 2;

// ---- HTTP wrapper ----
const reply = (code, data, headers) => ({ statusCode: code, headers, body: JSON.stringify(data) });
const headers = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST,OPTIONS,GET",
  "Cache-Control":"no-cache"
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return reply(200, { ok: true }, headers);
    if (event.httpMethod === "GET") return reply(200, { ok: true, ts: new Date().toISOString() }, headers);
    if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" }, headers);
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "OPENAI_API_KEY missing" }, headers);

    const body = safeJson(event.body);
    if (!body) return reply(400, { error: "Invalid JSON" }, headers);

    const personaA = (body.personaA || "").trim();
    const personaB = (body.personaB || "").trim();
    const topic    = (body.topic || "").trim();
    const rounds   = Math.max(1, Math.min(MAX_ROUNDS, parseInt(body.rounds || "2", 10)));
    const withMod  = !!body.moderator;

    if (!personaA || !personaB || !topic) {
      return reply(400, { error: "personaA, personaB, topic required" }, headers);
    }
    if (isBlocked(topic)) {
      return reply(200, {
        blocked: true,
        model: OPENAI_MODEL,
        tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
        message: "Blocked by topic policy."
      }, headers);
    }

    const turnsOut = [];
    const transcript = []; // {who:'A'|'B', text:string}

    // --- OPENINGS ---
    const openingA = await produceTurn("A", personaA, personaB, topic, transcript, "opening", BASE_INTERJECT_PROB);
    transcript.push({ who: "A", text: openingA.speech });
    turnsOut.push(await toTurnOut("Persona A", openingA.speech, VOICE_A));

    const maybeIntB1 = await maybeInterject("B", personaB, personaA, topic, transcript, BASE_INTERJECT_PROB);
    if (maybeIntB1) {
      transcript.push({ who: "B", text: maybeIntB1.speech });
      turnsOut.push(await toTurnOut("Persona B — Interjection", maybeIntB1.speech, VOICE_B));
    }

    const openingB = await produceTurn("B", personaB, personaA, topic, transcript, "opening", BASE_INTERJECT_PROB);
    transcript.push({ who: "B", text: openingB.speech });
    turnsOut.push(await toTurnOut("Persona B", openingB.speech, VOICE_B));

    const maybeIntA1 = await maybeInterject("A", personaA, personaB, topic, transcript, BASE_INTERJECT_PROB);
    if (maybeIntA1) {
      transcript.push({ who: "A", text: maybeIntA1.speech });
      turnsOut.push(await toTurnOut("Persona A — Interjection", maybeIntA1.speech, VOICE_A));
    }

    // --- REBUTTALS ---
    for (let r = 1; r <= rounds - 1; r++) {
      const rebutA = await produceTurn("A", personaA, personaB, topic, transcript, "rebuttal", BASE_INTERJECT_PROB);
      transcript.push({ who: "A", text: rebutA.speech });
      turnsOut.push(await toTurnOut(`Persona A — Rebuttal ${r}`, rebutA.speech, VOICE_A));

      const maybeIntB = await maybeInterject("B", personaB, personaA, topic, transcript, BASE_INTERJECT_PROB);
      if (maybeIntB) {
        transcript.push({ who: "B", text: maybeIntB.speech });
        turnsOut.push(await toTurnOut(`Persona B — Interjection`, maybeIntB.speech, VOICE_B));
      }

      const rebutB = await produceTurn("B", personaB, personaA, topic, transcript, "rebuttal", BASE_INTERJECT_PROB);
      transcript.push({ who: "B", text: rebutB.speech });
      turnsOut.push(await toTurnOut(`Persona B — Rebuttal ${r}`, rebutB.speech, VOICE_B));

      const maybeIntA = await maybeInterject("A", personaA, personaB, topic, transcript, BASE_INTERJECT_PROB);
      if (maybeIntA) {
        transcript.push({ who: "A", text: maybeIntA.speech });
        turnsOut.push(await toTurnOut(`Persona A — Interjection`, maybeIntA.speech, VOICE_A));
      }
    }

    // --- CLOSINGS ---
    const closingA = await produceTurn("A", personaA, personaB, topic, transcript, "closing", BASE_INTERJECT_PROB);
    transcript.push({ who: "A", text: closingA.speech });
    turnsOut.push(await toTurnOut("Persona A — Closing", closingA.speech, VOICE_A));

    const closingB = await produceTurn("B", personaB, personaA, topic, transcript, "closing", BASE_INTERJECT_PROB);
    transcript.push({ who: "B", text: closingB.speech });
    turnsOut.push(await toTurnOut("Persona B — Closing", closingB.speech, VOICE_B));

    // --- MODERATOR SUMMARY ---
    let summary = null;
    if (withMod) {
      const sText = await moderatorSummary(topic, personaA, personaB, transcript);
      summary = {
        text: sText,
        audio: await speak(sText, VOICE_MOD)
      };
    }

    return reply(200, {
      model: OPENAI_MODEL,
      tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
      turns: turnsOut,
      summary
    }, headers);

  } catch (err) {
    console.error("[DEBATE] Fatal:", err?.message || err);
    return reply(500, { error: String(err?.message || err) }, headers);
  }
};

// ---------- Debate logic ----------
async function produceTurn(side, selfPersona, oppPersona, topic, transcript, phase, interjectProb) {
  const sys = systemForDebater(selfPersona);
  const user = userForTurn(side, selfPersona, oppPersona, topic, transcript, phase, interjectProb);
  const j = await chatJSON(sys, user);
  const clean = normalizeJSONTurn(j, { maxSentences: 5, maxWords: 180 });
  return clean;
}

async function maybeInterject(side, selfPersona, oppPersona, topic, transcript, baseProb) {
  // quick probabilistic gate so not EVERY turn interjects
  const p = tuneInterjectProbability(selfPersona, baseProb);
  if (Math.random() > p) return null;

  const sys = systemForDebater(selfPersona);
  const user = userForInterjection(side, selfPersona, oppPersona, topic, transcript);
  const j = await chatJSON(sys, user);
  const clean = normalizeJSONTurn(j, { maxSentences: MAX_INTERJECTION_SENTENCES, maxWords: 60 });
  if (clean.intent !== "interject" || !clean.speech) return null;
  return clean;
}

function systemForDebater(persona) {
  return `You are a voiced debater. Stay in this persona at all times:
${persona}

Rules:
- Civil, concise, concrete. Prefer reasons, mechanisms, examples.
- Avoid "social" issues (abortion, gay marriage, culture-war topics). If opponent drifts there, gently refocus.
- Absolutely no medical, legal, or financial advice.
- Return STRICT JSON ONLY matching this schema:
  {
    "speech": string,        // what you will speak, natural and concise
    "intent": "speak" | "interject" | "silence",
    "end_reason": "point_complete" | "length_cap" | "no_more_points",
    "sentences": number      // approx sentence count (integer)
  }`;
}

function userForTurn(side, selfPersona, oppPersona, topic, transcript, phase, interjectProb) {
  const ctx = formatTranscript(transcript);
  return `
You are ${side === "A" ? "Persona A" : "Persona B"}.

Debate topic:
${topic}

Opponent persona (private):
${oppPersona}

Phase: ${phase}.

Transcript so far (last 10 turns):
${ctx}

Produce your ${phase} contribution. Constraints:
- intent must be "speak".
- 3–5 sentences, under ~180 words.
- End clearly when your point is complete (end_reason accordingly).
- Be persona-consistent: if impatient in persona, a brisker pace is OK; if patient, fully finish the point.
- No social-issue drift.`;
}

function userForInterjection(side, selfPersona, oppPersona, topic, transcript) {
  const ctx = formatTranscript(transcript);
  return `
You are ${side === "A" ? "Persona A" : "Persona B"}.

Debate topic:
${topic}

Opponent persona (private):
${oppPersona}

Recent transcript (last 4 turns):
${formatTranscript(transcript.slice(-4))}

You MAY produce a brief interjection IF it helps your persona (max 2 sentences, <= ~60 words). If not appropriate, return intent "silence" with empty speech.
Constraints:
- If interjecting: be very short and civil; point to a single flaw or request a clarification.
- No social-issue drift.`;
}

function formatTranscript(list) {
  if (!list || !list.length) return "(none yet)";
  return list.slice(-10).map(t => `${t.who}: ${t.text}`).join("\n\n");
}

function tuneInterjectProbability(persona, base) {
  const p = (persona || "").toLowerCase();
  let b = base;
  if (/\b(impatient|interrupts|fiery|combative)\b/.test(p)) b += 0.15;
  if (/\b(patient|measured|polite|listener)\b/.test(p)) b -= 0.15;
  return Math.max(0.05, Math.min(0.6, b));
}

// ---------- OpenAI (JSON mode) ----------
async function chatJSON(system, user) {
  const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS_TURN,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user",   content: user }
      ]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"");
    console.error("[OPENAI] error:", res.status, t);
    throw new Error(`OpenAI ${res.status}: ${t || "(no body)"}`);
  }
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content || "{}";
  return safeJson(raw) || {};
}

function normalizeJSONTurn(obj, caps) {
  const speech = clampSpeech(String(obj.speech || ""), caps);
  const intent = (obj.intent === "interject" || obj.intent === "silence") ? obj.intent : "speak";
  const end_reason = obj.end_reason || (intent === "silence" ? "no_more_points" : "point_complete");
  const sentences = Number.isFinite(obj.sentences) ? obj.sentences : countSentences(speech);
  return { speech, intent, end_reason, sentences };
}

function clampSpeech(s, caps) {
  const trimmed = s.trim().replace(/\s{3,}/g, " ");
  if (!caps) return trimmed;
  // sentence cap
  let parts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (caps.maxSentences && parts.length > caps.maxSentences) {
    parts = parts.slice(0, caps.maxSentences);
  }
  let out = parts.join(" ");
  // word cap
  const words = out.split(/\s+/);
  if (caps.maxWords && words.length > caps.maxWords) {
    out = words.slice(0, caps.maxWords).join(" ") + "...";
  }
  return out;
}

function countSentences(s) {
  if (!s) return 0;
  return (s.match(/[.!?](\s|$)/g) || []).length || 1;
}

// ---------- Moderator ----------
async function moderatorSummary(topic, personaA, personaB, transcript) {
  const sys = `You are a neutral moderator. Return STRICT JSON:
  {
    "speech": string
  }
  Keep under ~180 words; include 3 concise follow-up questions.`;
  const user = `
Topic: ${topic}

Persona A: ${personaA}
Persona B: ${personaB}

Transcript (last 10 turns):
${formatTranscript(transcript)}

Produce a single spoken summary + exactly 3 follow-up questions. JSON only.`;
  const j = await chatJSON(sys, user);
  return String(j.speech || "").trim();
}

// ---------- TTS ----------
async function speak(text, voiceId) {
  const speech = finalizeProsody(text);
  if (ELEVEN_API_KEY && voiceId) {
    try {
      const b64 = await elevenTTS(speech, voiceId);
      return `data:audio/mpeg;base64,${b64}`;
    } catch (e) {
      console.warn("[TTS] Eleven failed, falling back:", e?.message || e);
    }
  }
  // fallback: OpenAI TTS
  try {
    const b64 = await openaiTTS(speech);
    return `data:audio/mpeg;base64,${b64}`;
  } catch (e) {
    console.error("[TTS] OpenAI failed:", e?.message || e);
    return null; // UI will still show text
  }
}

function finalizeProsody(text) {
  let t = String(text || "").trim();
  t = t.replace(/([.!?])\s+/g, "$1  ")
       .replace(/,\s+/g, ",  ")
       .replace(/\s{3,}/g, "  ");
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, 3600);
}

async function elevenTTS(text, voiceId) {
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
  if (!res.ok) {
    const t = await res.text().catch(()=>"");
    throw new Error(`ElevenLabs ${res.status}: ${t || "(no body)"}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Tiny buffer from ElevenLabs");
  return buf.toString("base64");
}

async function openaiTTS(text) {
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
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`OpenAI TTS ${r.status}: ${t || "(no body)"}`);
  }
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

// ---------- misc ----------
function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function isBlocked(topic){
  const s = (topic || "").toLowerCase();
  return BLOCKED.some(k => s.includes(k));
}
