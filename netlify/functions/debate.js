// Echo Chamber v0.3 — Robust model fallback + better error surfacing
// - Tries OPENAI_MODEL first; if unavailable, falls back to gpt-4o-mini automatically
// - Returns errors[] array in response so the UI never feels "mysteriously broken"
// - Retains JSON-mode turns, optional interjections, moderator summary
// - ElevenLabs TTS first; OpenAI TTS fallback

const OPENAI_ROOT = "https://api.openai.com/v1";

// ---------- ENV / CONFIG ----------
const PREFERRED_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // you set gpt-5-thinking; we'll test it
const FALLBACK_MODEL  = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
// If you only set ELEVENLABS_VOICE_ID, we reuse it for A/B/MOD:
const VOICE_A   = process.env.ELEVENLABS_VOICE_A  || process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_B   = process.env.ELEVENLABS_VOICE_B  || process.env.ELEVENLABS_VOICE_ID || "";
const VOICE_MOD = process.env.ELEVENLABS_VOICE_MOD|| process.env.ELEVENLABS_VOICE_ID || "";

const TEMPERATURE = 0.4;
const MAX_TOKENS_TURN = 520;
const MAX_ROUNDS = 3;

// Topic guardrail (no social debates)
const BLOCKED = [
  "abortion","gay marriage","same-sex marriage","lgbt","transgender","gender identity",
  "sexual orientation","religion","race","racism","culture war","gun control"
];

// Interjection behavior
const BASE_INTERJECT_PROB = 0.25;
const MAX_INTERJECTION_SENTENCES = 2;

// ---------- HTTP helpers ----------
const headers = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST,OPTIONS,GET",
  "Cache-Control":"no-cache"
};
const reply = (code, data) => ({ statusCode: code, headers, body: JSON.stringify(data) });

// ---------- Entry ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return reply(200, { ok: true });
    if (event.httpMethod === "GET")     return reply(200, { ok: true, ts: new Date().toISOString() });
    if (event.httpMethod !== "POST")    return reply(405, { error: "Method Not Allowed" });
    if (!process.env.OPENAI_API_KEY)    return reply(500, { error: "OPENAI_API_KEY missing" });

    const input = safeJson(event.body);
    if (!input) return reply(400, { error: "Invalid JSON" });

    const personaA = (input.personaA||"").trim();
    const personaB = (input.personaB||"").trim();
    const topic    = (input.topic||"").trim();
    const rounds   = Math.max(1, Math.min(MAX_ROUNDS, parseInt(input.rounds||"2",10)));
    const withMod  = !!input.moderator;

    if (!personaA || !personaB || !topic) {
      return reply(400, { error: "personaA, personaB, topic required" });
    }
    if (isBlocked(topic)) {
      return reply(200, {
        blocked: true,
        model: PREFERRED_MODEL,
        tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
        message: "Blocked by topic policy."
      });
    }

    // ---- Model selection with auto-fallback
    const errors = [];
    const model = await pickModel(PREFERRED_MODEL, FALLBACK_MODEL, errors);

    // ---- Debate run
    const turnsOut = [];
    const transcript = []; // { who:'A'|'B', text:string }

    // Openings
    const openingA = await produceTurn(model, "A", personaA, personaB, topic, transcript, "opening");
    transcript.push({ who: "A", text: openingA.speech });
    turnsOut.push(await toTurnOut("Persona A", openingA.speech, VOICE_A, errors));

    const maybeIntB1 = await maybeInterject(model, "B", personaB, personaA, topic, transcript);
    if (maybeIntB1) {
      transcript.push({ who: "B", text: maybeIntB1.speech });
      turnsOut.push(await toTurnOut("Persona B — Interjection", maybeIntB1.speech, VOICE_B, errors));
    }

    const openingB = await produceTurn(model, "B", personaB, personaA, topic, transcript, "opening");
    transcript.push({ who: "B", text: openingB.speech });
    turnsOut.push(await toTurnOut("Persona B", openingB.speech, VOICE_B, errors));

    const maybeIntA1 = await maybeInterject(model, "A", personaA, personaB, topic, transcript);
    if (maybeIntA1) {
      transcript.push({ who: "A", text: maybeIntA1.speech });
      turnsOut.push(await toTurnOut("Persona A — Interjection", maybeIntA1.speech, VOICE_A, errors));
    }

    // Rebuttals
    for (let r=1; r<=rounds-1; r++) {
      const rebutA = await produceTurn(model, "A", personaA, personaB, topic, transcript, "rebuttal");
      transcript.push({ who: "A", text: rebutA.speech });
      turnsOut.push(await toTurnOut(`Persona A — Rebuttal ${r}`, rebutA.speech, VOICE_A, errors));

      const maybeIntB = await maybeInterject(model, "B", personaB, personaA, topic, transcript);
      if (maybeIntB) {
        transcript.push({ who: "B", text: maybeIntB.speech });
        turnsOut.push(await toTurnOut(`Persona B — Interjection`, maybeIntB.speech, VOICE_B, errors));
      }

      const rebutB = await produceTurn(model, "B", personaB, personaA, topic, transcript, "rebuttal");
      transcript.push({ who: "B", text: rebutB.speech });
      turnsOut.push(await toTurnOut(`Persona B — Rebuttal ${r}`, rebutB.speech, VOICE_B, errors));

      const maybeIntA = await maybeInterject(model, "A", personaA, personaB, topic, transcript);
      if (maybeIntA) {
        transcript.push({ who: "A", text: maybeIntA.speech });
        turnsOut.push(await toTurnOut(`Persona A — Interjection`, maybeIntA.speech, VOICE_A, errors));
      }
    }

    // Closings
    const closingA = await produceTurn(model, "A", personaA, personaB, topic, transcript, "closing");
    transcript.push({ who: "A", text: closingA.speech });
    turnsOut.push(await toTurnOut("Persona A — Closing", closingA.speech, VOICE_A, errors));

    const closingB = await produceTurn(model, "B", personaB, personaA, topic, transcript, "closing");
    transcript.push({ who: "B", text: closingB.speech });
    turnsOut.push(await toTurnOut("Persona B — Closing", closingB.speech, VOICE_B, errors));

    // Moderator (optional)
    let summary = null;
    if (withMod) {
      const sText = await moderatorSummary(model, topic, personaA, personaB, transcript);
      summary = { text: sText, audio: await speak(sText, VOICE_MOD, errors) };
    }

    return reply(200, {
      model,
      tts: ELEVEN_API_KEY ? "elevenlabs" : `openai-${OPENAI_TTS_MODEL}`,
      turns: turnsOut,
      summary,
      errors
    });

  } catch (err) {
    console.error("[DEBATE] Fatal:", err?.message || err);
    return reply(500, { error: String(err?.message || err) });
  }
};

// ---------- Model selection ----------
async function pickModel(preferred, fallback, errors) {
  // ping preferred with a tiny JSON-format call; if it fails, we fall back
  try {
    await tinyPing(preferred);
    return preferred;
  } catch (e) {
    const msg = `[model] preferred "${preferred}" failed: ${e?.message || e}`;
    console.warn(msg);
    errors.push(msg);
    // try fallback
    try {
      await tinyPing(fallback);
      errors.push(`[model] using fallback "${fallback}"`);
      return fallback;
    } catch (e2) {
      const msg2 = `[model] fallback "${fallback}" failed: ${e2?.message || e2}`;
      console.error(msg2);
      errors.push(msg2);
      throw new Error("No available model. Check OPENAI_MODEL access or set a valid fallback.");
    }
  }
}

async function tinyPing(model) {
  const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON: {\"ok\":true}" },
        { role: "user", content: "Say nothing else." }
      ]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`OpenAI ${res.status}: ${t}`);
  }
}

// ---------- Debate logic ----------
async function produceTurn(model, side, selfPersona, oppPersona, topic, transcript, phase) {
  const sys = systemForDebater(selfPersona);
  const user = userForTurn(side, selfPersona, oppPersona, topic, transcript, phase);
  const j = await chatJSON(model, sys, user);
  return normalizeJSONTurn(j, { maxSentences: 5, maxWords: 180 });
}

async function maybeInterject(model, side, selfPersona, oppPersona, topic, transcript) {
  const p = tuneInterjectProbability(selfPersona, BASE_INTERJECT_PROB);
  if (Math.random() > p) return null;

  const sys = systemForDebater(selfPersona);
  const user = userForInterjection(side, selfPersona, oppPersona, topic, transcript);
  const j = await chatJSON(model, sys, user);
  const clean = normalizeJSONTurn(j, { maxSentences: MAX_INTERJECTION_SENTENCES, maxWords: 60 });
  if (clean.intent !== "interject" || !clean.speech) return null;
  return clean;
}

function systemForDebater(persona) {
  return `You are a voiced debater. Stay in this persona:
${persona}

Rules:
- Civil, concise, concrete. Prefer reasons, mechanisms, examples.
- Avoid "social" issues (abortion, gay marriage, culture-war topics). If opponent drifts there, refocus.
- Absolutely no medical, legal, or financial advice.
- Return STRICT JSON ONLY, schema:
  {
    "speech": string,
    "intent": "speak" | "interject" | "silence",
    "end_reason": "point_complete" | "length_cap" | "no_more_points",
    "sentences": number
  }`;
}

function userForTurn(side, selfPersona, oppPersona, topic, transcript, phase) {
  const ctx = formatTranscript(transcript);
  return `
You are ${side === "A" ? "Persona A" : "Persona B"}.

Topic:
${topic}

Opponent persona (private):
${oppPersona}

Phase: ${phase}.

Transcript so far (last 10 turns):
${ctx}

Produce your ${phase} contribution. Constraints:
- intent must be "speak".
- 3–5 sentences, ~<=180 words.
- End decisively (end_reason).
- Persona-consistent pacing: impatient → brisk; patient → finish the point.
- No social-issue drift.`;
}

function userForInterjection(side, selfPersona, oppPersona, topic, transcript) {
  return `
You are ${side === "A" ? "Persona A" : "Persona B"}.

Topic:
${topic}

Opponent persona (private):
${oppPersona}

Recent transcript (last 4 turns):
${formatTranscript(transcript.slice(-4))}

You MAY interject only if it helps (max 2 sentences, <= ~60 words). Otherwise return intent "silence".
Be civil; ask for a clarification or point to a single flaw. No social-issue drift.`;
}

function formatTranscript(list) {
  if (!list || !list.length) return "(none yet)";
  return list.slice(-10).map(t => `${t.who}: ${t.text}`).join("\n\n");
}

function tuneInterjectProbability(persona, base) {
  const p = (persona || "").toLowerCase();
  let b = base;
  if (/\b(impatient|interrupts|fiery|combative)\b/.test(p)) b += 0.15;
  if (/\b(patient|measured|polite|listener)\b/.test(p))  b -= 0.15;
  return Math.max(0.05, Math.min(0.6, b));
}

// ---------- OpenAI JSON chat ----------
async function chatJSON(model, system, user) {
  const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
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
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`OpenAI ${res.status}: ${t}`);
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
  let parts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (caps.maxSentences && parts.length > caps.maxSentences) parts = parts.slice(0, caps.maxSentences);
  let out = parts.join(" ");
  const words = out.split(/\s+/);
  if (caps.maxWords && words.length > caps.maxWords) out = words.slice(0, caps.maxWords).join(" ") + "...";
  return out;
}

function countSentences(s) { return (s.match(/[.!?](\s|$)/g) || []).length || 1; }

// ---------- Moderator ----------
async function moderatorSummary(model, topic, personaA, personaB, transcript) {
  const sys = `You are a neutral moderator. Return STRICT JSON: {"speech": string}. Keep under ~180 words; include exactly 3 follow-up questions.`;
  const user = `
Topic: ${topic}

Persona A: ${personaA}
Persona B: ${personaB}

Transcript (last 10 turns):
${formatTranscript(transcript)}

Produce a single spoken summary + 3 follow-up questions. JSON only.`;
  const j = await chatJSON(model, sys, user);
  return String(j.speech || "").trim();
}

// ---------- TTS ----------
async function toTurnOut(who, text, voiceId, errors) {
  const audio = await speak(text, voiceId, errors);
  return { who, text, audio };
}

async function speak(text, voiceId, errors) {
  const speech = finalizeProsody(text);
  if (ELEVEN_API_KEY && voiceId) {
    try {
      const b64 = await elevenTTS(speech, voiceId);
      return `data:audio/mpeg;base64,${b64}`;
    } catch (e) {
      const msg = `[tts-eleven] ${e?.message || e}`;
      console.warn(msg);
      errors?.push(msg);
    }
  }
  // Fallback: OpenAI TTS
  try {
    const b64 = await openaiTTS(speech);
    return `data:audio/mpeg;base64,${b64}`;
  } catch (e) {
    const msg = `[tts-openai] ${e?.message || e}`;
    console.error(msg);
    errors?.push(msg);
    return null;
  }
}

function finalizeProsody(text) {
  let t = String(text || "").trim();
  t = t.replace(/([.!?])\s+/g, "$1  ").replace(/,\s+/g, ",  ").replace(/\s{3,}/g, "  ");
  if (!/[.!?…]$/.test(t)) t += ".";
  return t.slice(0, 3600);
}

async function elevenTTS(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.7, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      output_format: "mp3_44100_128"
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>"(no body)");
    throw new Error(`ElevenLabs ${res.status}: ${t}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("ElevenLabs returned tiny buffer");
  return buf.toString("base64");
}

async function openaiTTS(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE, input: text, response_format: "mp3", speed: 0.95 })
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>"(no body)");
    throw new Error(`OpenAI TTS ${r.status}: ${t}`);
  }
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

// ---------- utils ----------
function safeJson(s){ try { return JSON.parse(s); } catch { return null; } }
function isBlocked(topic){ const s=(topic||"").toLowerCase(); return BLOCKED.some(k => s.includes(k)); }
