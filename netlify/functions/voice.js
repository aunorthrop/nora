// Nora voice brain – admin updates + employee Q&A + OpenAI STT/TTS
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";

// how long a “daily brief” looks back
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);
// how long an admin-armed session lasts on the server side (device also keeps a flag)
const ADMIN_ARM_MIN = 8;

const mem = globalThis.__NORA_MEM__ || (globalThis.__NORA_MEM__ = new Map());
const admins = globalThis.__NORA_ADM__ || (globalThis.__NORA_ADM__ = new Map());
// docs are stored by files.js in globalThis.__NORA_DOCS__
function getDocsMap() {
  return globalThis.__NORA_DOCS__ || (globalThis.__NORA_DOCS__ = new Map());
}

function now() { return Date.now(); }
function isValidCode(code) { return /^[0-9]{4}-[0-9]{4}$/.test(code || ""); }
function getTeam(businessId) {
  let t = mem.get(businessId);
  if (!t) {
    t = { updates: [], longterm: [] };
    mem.set(businessId, t);
  }
  return t;
}
function armAdmin(businessId) {
  admins.set(businessId, { until: now() + ADMIN_ARM_MIN * 60 * 1000 });
}
function isAdminArmed(businessId) {
  const a = admins.get(businessId);
  return a && a.until > now();
}
function disarmAdmin(businessId) { admins.delete(businessId); }

function reply(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(data),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return reply(200, { ok: true });

  try {
    const body = JSON.parse(event.body || "{}");
    const businessId = body.businessId;
    const mode = body.mode || "normal";
    const audio = body.audio || null;

    // enforce team code gate
    if (!isValidCode(businessId)) {
      return reply(200, {
        error: "missing_or_bad_team_code",
        control: { requireCode: true },
      });
    }

    // no audio? just say idle
    if (!audio?.data || !audio?.mime) {
      const say = "I'm ready when you are.";
      const tts = await ttsSay(say);
      return reply(200, { sessionId: "sess_" + now(), response: say, audio: tts });
    }

    // 1) STT
    const transcript = await transcribe(audio.data, audio.mime);
    const spoken = (transcript || "").trim();
    if (!spoken) {
      const say = "I didn’t catch that. Try again.";
      const tts = await ttsSay(say);
      return reply(200, { response: say, audio: tts });
    }

    // 2) ROUTING
    const lc = spoken.toLowerCase();

    // --- admin arm/disarm keywords (device says only "admin" to arm) ---
    if (/^\s*(admin|admin mode)\s*$/.test(lc)) {
      armAdmin(businessId);
      const say = "Admin mode activated. Say your updates, or say done when finished.";
      const tts = await ttsSay(say);
      return reply(200, { response: say, audio: tts, control: { adminArmed: true } });
    }
    if (/^(done|finish|finished|we're done|we are done)\.?$/i.test(spoken)) {
      disarmAdmin(businessId);
      const say = "Got it. Admin mode off.";
      const tts = await ttsSay(say);
      return reply(200, { response: say, audio: tts, control: { adminDisarm: true } });
    }

    // --- admin update capture ---
    if (isAdminArmed(businessId) || mode === "admin-armed") {
      const team = getTeam(businessId);

      // long-term memory toggle
      if (/^\s*(long\s*term|permanent|static)\s*[:\-]?\s*/i.test(spoken)) {
        const content = spoken.replace(/^\s*(long\s*term|permanent|static)\s*[:\-]?\s*/i, "").trim();
        if (content) {
          team.longterm.push({ ts: now(), text: content });
          const say = "Saved to long-term memory.";
          const tts = await ttsSay(say);
          return reply(200, { response: say, audio: tts });
        }
      }
      // deletions
      if (/^\s*(delete|forget)\s+/i.test(spoken)) {
        const q = spoken.replace(/^\s*(delete|forget)\s+/i, "").trim();
        const beforeLT = team.longterm.length, beforeU = team.updates.length;
        team.longterm = team.longterm.filter(x => !includesFuzzy(x.text, q));
        team.updates = team.updates.filter(x => !includesFuzzy(x.text, q));
        const say = (team.longterm.length !== beforeLT || team.updates.length !== beforeU)
          ? "Deleted."
          : "I couldn’t find that to delete.";
        const tts = await ttsSay(say);
        return reply(200, { response: say, audio: tts });
      }

      // default: treat as daily update
      team.updates.push({ ts: now(), text: spoken });
      const say = "Added to today’s updates.";
      const tts = await ttsSay(say);
      return reply(200, { response: say, audio: tts });
    }

    // --- employee Q&A ---
    const say = await answerEmployee(businessId, spoken);
    const tts = await ttsSay(say);
    return reply(200, { response: say, audio: tts });
  } catch (e) {
    console.error(e);
    const say = "I hit an error. Please try again.";
    const tts = await ttsSay(say).catch(() => null);
    return reply(200, { error: "server_error", response: say, audio: tts || undefined });
  }
};

// ---------- helpers ----------
async function transcribe(b64, mime) {
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("temperature", "0");
  fd.set("language", "en");
  const blob = Buffer.from(b64, "base64");
  fd.set("file", new Blob([blob], { type: mime || "application/octet-stream" }), "audio");
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text || "").trim();
}

async function ttsSay(text) {
  const clean = String(text || "").slice(0, 4000);
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: clean,
      response_format: "mp3",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b}`;
}

function includesFuzzy(hay, needle) {
  hay = (hay || "").toLowerCase();
  needle = (needle || "").toLowerCase();
  if (!needle) return false;
  return hay.includes(needle);
}

function pickRecent(updates, hours) {
  const cutoff = now() - hours * 3600 * 1000;
  return (updates || []).filter(u => (u.ts || 0) >= cutoff);
}

async function answerEmployee(businessId, question) {
  const docsMap = getDocsMap();
  const team = getTeam(businessId);
  const recent = pickRecent(team.updates, BRIEF_WINDOW_HOURS);
  const longterm = team.longterm || [];
  const docs = docsMap.get(businessId) || [];

  // build small corpus
  const sources = [];
  if (recent.length) sources.push("Recent updates:\n" + recent.map(u => "- " + u.text).join("\n"));
  if (longterm.length) sources.push("Long-term info:\n" + longterm.map(u => "- " + u.text).join("\n"));
  if (docs.length) {
    const docSnips = docs.slice(-12).map(d => `- ${d.name}: ${d.text.slice(0, 1200)}`);
    sources.push("Documents (latest):\n" + docSnips.join("\n"));
  }
  if (!sources.length) {
    return "No updates or files yet. Ask your admin to add updates or upload a PDF.";
  }

  const system = [
    "You are Nora, a strictly retrieval-based voice assistant for a business team.",
    "Answer ONLY using the provided updates, long-term info, and document snippets.",
    "If an answer is not present, say you don’t have that information.",
    "Be concise, warm, and plain. 2–4 sentences.",
  ].join(" ");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Question: ${question}\n\nKnowledge:\n${sources.join("\n\n")}` },
  ];

  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0 }),
  });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "I don’t have that info.").trim();
}
