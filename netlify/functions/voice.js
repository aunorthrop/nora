// Nora voice brain: STT -> intent router (admin/employee) -> TTS
// No external deps (works on Netlify Functions / Node 18)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";

// Keep recent updates for N hours (employees hear "what's new?")
const UPDATES_TTL_HOURS = Number(process.env.UPDATES_TTL_HOURS || 168); // 7 days default
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);

const db = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());

function team(biz) {
  if (!db.has(biz)) db.set(biz, { updates: [], longterm: [], docs: [] });
  return db.get(biz);
}
function isCode(code) { return /^[0-9]{4}-[0-9]{4}$/.test(String(code || "")); }
const now = () => Date.now();

function sanitizeMime(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("webm")) return "audio/webm";
  if (s.includes("m4a")) return "audio/m4a";
  if (s.includes("mp4")) return "audio/mp4";
  if (s.includes("mp3")) return "audio/mpeg";
  if (s.includes("wav")) return "audio/wav";
  if (s.includes("ogg") || s.includes("oga")) return "audio/ogg";
  return "audio/webm";
}
function extFor(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("webm")) return ".webm";
  if (s.includes("m4a")) return ".m4a";
  if (s.includes("mp4")) return ".mp4";
  if (s.includes("mp3")) return ".mp3";
  if (s.includes("wav")) return ".wav";
  if (s.includes("ogg") || s.includes("oga")) return ".ogg";
  return ".webm";
}

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json({ ok: true });
  try {
    const body = JSON.parse(event.body || "{}");
    const businessId = body.businessId;
    const sessionId = body.sessionId || "s" + Date.now();
    const mode = String(body.mode || "normal");

    if (!isCode(businessId)) {
      return json({ error: "missing_or_bad_team_code", control: { requireCode: true } });
    }
    const audio = body.audio || {};
    if (!audio.data || !audio.mime) return json({ error: "no_audio" });

    // --- STT ---
    let transcript = "";
    try {
      transcript = await transcribe(audio.data, audio.mime);
    } catch (e) {
      return json({ error: "STT " + (e.message || "failed") });
    }
    const raw = (transcript || "").trim();
    if (!raw) {
      const audioUrl = await tts("I didn’t catch that. Try again a little closer to the mic.");
      return json({ audio: audioUrl });
    }

    // --- INTENT ROUTER ---
    const t = raw.toLowerCase();
    const state = team(businessId);

    // 1) arming admin
    if (/^(admin|i am the admin)\b/.test(t)) {
      const audioUrl = await tts("Admin mode armed. Say your updates. Say “long-term: ...” for permanent notes. Say “done” when finished.");
      return json({ audio: audioUrl, control: { adminArmed: true } });
    }

    // 2) admin session (client sends mode=admin-armed after arming)
    if (mode === "admin-armed") {
      // finish
      if (/\b(done|finish|finished|that's all|that is all)\b/.test(t)) {
        const audioUrl = await tts("Saved. Admin mode off.");
        return json({ audio: audioUrl, control: { adminDisarm: true } });
      }

      // delete last item containing keywords
      if (/^delete\b/.test(t)) {
        const tail = raw.replace(/^delete\b[:\-]?\s*/i, "").trim();
        const where = [...state.updates].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
        if (where >= 0) {
          state.updates.splice(state.updates.length - 1 - where, 1);
          const audioUrl = await tts("Deleted that update.");
          return json({ audio: audioUrl });
        }
        const audioUrl = await tts("I didn’t find a matching update to delete.");
        return json({ audio: audioUrl });
      }

      // long-term memory
      const lt = raw.match(/^(long\s*[- ]?\s*term|remember|permanent)[:\-]?\s*(.+)$/i);
      if (lt && lt[2]) {
        state.longterm.push({ text: lt[2].trim(), ts: now() });
        const audioUrl = await tts("Saved to long-term.");
        return json({ audio: audioUrl });
      }

      // default: treat as today update
      state.updates.push({ text: raw, ts: now() });
      prune(state);
      const audioUrl = await tts("Added to today’s updates.");
      return json({ audio: audioUrl });
    }

    // 3) employee / normal mode
    if (/\b(what('?| i)s new|any updates|updates today)\b/.test(t)) {
      const cutoff = now() - BRIEF_WINDOW_HOURS * 3600 * 1000;
      const recent = state.updates.filter(u => (u.ts || 0) >= cutoff).map(u => u.text);
      const text = recent.length ? "Here’s the latest. " + bullets(recent.slice(-8))
                                 : "No new updates right now.";
      const audioUrl = await tts(text);
      return json({ audio: audioUrl });
    }

    // Q&A from long-term + docs
    const answer = await answerFromMemory(state, raw);
    const audioUrl = await tts(answer);
    return json({ audio: audioUrl });

  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

// ---------- helpers ----------

function bullets(arr) { return arr.map(s => "• " + s).join("  "); }

function prune(state) {
  const ttl = UPDATES_TTL_HOURS * 3600 * 1000;
  const cut = now() - ttl;
  state.updates = state.updates.filter(u => (u.ts || 0) >= cut);
  // keep reasonable caps
  state.updates = state.updates.slice(-500);
  state.longterm = state.longterm.slice(-1000);
  state.docs = state.docs.slice(-200);
}

async function transcribe(b64, mime) {
  const data = Buffer.from(b64, "base64");
  if (data.length < 600) return "";

  const cleanMime = sanitizeMime(mime);
  const filename = "audio" + extFor(cleanMime);

  const fd = new FormData();
  fd.set("model", STT_MODEL);
  // keep language auto; set prompt to bias toward ops/update talk
  fd.set("prompt", "Short workplace update or question for a team assistant.");
  fd.set("temperature", "0.2");
  fd.set("file", new Blob([data], { type: cleanMime }), filename);

  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`STT ${r.status}: ${t}`);
  }
  const j = await r.json();
  return (j.text || "").trim();
}

async function tts(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: OPENAI_TTS_VOICE, // "shimmer" (lighter/brighter)
      input: sculpt(text),
      response_format: "mp3",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}

function sculpt(t) {
  let s = String(t || "").trim();
  s = s.replace(/([.!?])\s+/g, "$1  ");
  if (!/[.!?…]$/.test(s)) s += ".";
  return s.slice(0, 4000);
}

async function answerFromMemory(state, question) {
  // Cheap retrieval by token overlap
  const pool = [
    ...state.longterm.map(x => ({ type: "lt", text: x.text })),
    ...state.docs.map(d => ({ type: "doc", text: d.text, name: d.name })),
  ];
  if (pool.length === 0) {
    return "I don’t have that information yet. Ask your admin to add it.";
  }

  const qset = new Set(tokens(question));
  const scored = pool.map(it => {
    const w = new Set(tokens(it.text));
    let overlap = 0;
    for (const t of qset) if (w.has(t)) overlap++;
    return { it, score: overlap / Math.max(1, Math.min(qset.size, w.size)) };
  }).sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 6).map(x => x.it.text);
  const system = `You are Nora, a voice-first team assistant. Answer ONLY using the provided context. If the answer is not covered, say you don't have that information yet. Keep answers brief.`;
  const user = `Question: ${question}\n\nContext:\n- ${top.join("\n- ")}`;

  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 220,
    }),
  });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "I don’t have that information yet.").trim();
}

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
