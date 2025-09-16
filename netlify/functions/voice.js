// Nora voice brain: STT -> intent router (admin/employee) -> TTS
// Works on Netlify Functions / Node 18, no external deps.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer"; // bright/funky

// Retention windows
const UPDATES_TTL_HOURS = Number(process.env.UPDATES_TTL_HOURS || 168); // 7d
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24); // "what's new?"

// In-memory demo store (per site instance)
const DB = globalThis.__NORA_TEAMS__ || (globalThis.__NORA_TEAMS__ = new Map());
function team(id) {
  if (!DB.has(id)) DB.set(id, { updates: [], longterm: [], docs: [], lastSay: "" });
  return DB.get(id);
}
function isCode(s) { return /^[0-9]{4}-[0-9]{4}$/.test(String(s || "")); }
const now = () => Date.now();

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
    const mode = String(body.mode || "normal"); // "normal" | "admin-armed"
    if (!isCode(businessId)) return json({ error: "missing_or_bad_team_code", control: { requireCode: true } });

    const state = team(businessId);
    const audio = body.audio || {};
    if (!audio.data || !audio.mime) return json({ error: "no_audio" });

    // ---------- STT (with aggressive fallbacks for iOS/Safari blobs) ----------
    let transcript = "";
    try {
      transcript = await transcribeRobust(audio.data, audio.mime);
    } catch (e) {
      return json({ error: `STT ${e.message || "failed"}` });
    }
    const raw = (transcript || "").trim();
    if (!raw) return say(state, "I didn’t catch that. Try again a little closer to the mic.");

    const lower = raw.toLowerCase();

    // ---------- Global intents (work in any mode) ----------
    if (/\b(repeat|say (that|it) again|can you repeat|one more time)\b/.test(lower)) {
      if (state.lastSay) return say(state, state.lastSay);
      return say(state, "There’s nothing to repeat yet.");
    }
    if (/\b(help|what can you do|how do i use this|instructions)\b/.test(lower)) {
      return say(state, helpText());
    }

    // Allow “admin …” single-utterance arming + action
    const adminLeading = /^\s*admin[,:\s]+(.*)$/i.exec(raw);
    if (adminLeading && adminLeading[1]) {
      const handled = await handleAdminAction(state, adminLeading[1]);
      if (handled) return handled; // already replied
      // If content ambiguous, arm and ask for content
      return say(state,
        "Admin mode armed. Tell me an update, or say “remember …” to save long-term, or “delete …” to remove. Say “done” when finished.",
        { control: { adminArmed: true } }
      );
    }

    // “I am the admin”
    if (/^(i'?m|i am) the admin\b|^admin\b/.test(lower)) {
      return say(
        state,
        "Admin mode armed. Tell me an update, or say “remember …” to save long-term, or “delete …” to remove. Say “done” when finished.",
        { control: { adminArmed: true } }
      );
    }

    // ---------- Admin-armed session ----------
    if (mode === "admin-armed") {
      // finish
      if (/\b(done|finish|finished|that'?s all|that is all|we're done)\b/.test(lower)) {
        return say(state, "Saved. Admin mode off.", { control: { adminDisarm: true } });
      }

      // try to perform admin action
      const handled = await handleAdminAction(state, raw);
      if (handled) return handled;

      // if still here, treat as a plain update
      state.updates.push({ text: raw, ts: now() });
      prune(state);
      return say(state, "Added to today’s updates.");
    }

    // ---------- Employee / normal mode ----------
    if (/\b(what('?| i)s new|any updates|updates (today|for today))\b/.test(lower)) {
      const cut = now() - BRIEF_WINDOW_HOURS * 3600 * 1000;
      const recent = state.updates.filter(u => (u.ts || 0) >= cut).map(u => u.text);
      const text = recent.length ? "Here’s the latest. " + bullets(recent.slice(-8)) : "No new updates right now.";
      return say(state, text);
    }

    // fallback: Q&A using long-term + docs only
    const answer = await answerFromMemory(state, raw);
    return say(state, answer);

  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
};

// ---------- intent handlers ----------

async function handleAdminAction(state, contentRaw) {
  const raw = contentRaw.trim();
  const lower = raw.toLowerCase();

  // delete / forget
  if (/^(delete|remove|forget)\b/.test(lower)) {
    const tail = raw.replace(/^(delete|remove|forget)\b[:\-]?\s*/i, "").trim();
    if (!tail) return say(state, "Tell me what to delete; for example, “delete Friday’s schedule note.”");
    const idx = [...state.updates].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
    if (idx >= 0) {
      state.updates.splice(state.updates.length - 1 - idx, 1);
      return say(state, "Deleted that update.");
    }
    const ltIdx = [...state.longterm].reverse().findIndex(u => u.text.toLowerCase().includes(tail.toLowerCase()));
    if (ltIdx >= 0) {
      state.longterm.splice(state.longterm.length - 1 - ltIdx, 1);
      return say(state, "Deleted that long-term note.");
    }
    return say(state, "I didn’t find a matching note to delete.");
  }

  // long-term memory (lots of ways to say it)
  if (
    /^(long\s*[- ]?\s*term|remember|save|store|add (to )?memory|make (this )?permanent|keep this|log this)\b/.test(lower)
  ) {
    // allow “remember this …” / “remember: …”
    const tail = raw
      .replace(/^(long\s*[- ]?\s*term|remember|save|store|add (to )?memory|make (this )?permanent|keep this|log this)\b[:\-]?\s*/i, "")
      .trim();
    if (!tail) return say(state, "What should I save to long-term memory?");
    state.longterm.push({ text: tail, ts: now() });
    prune(state);
    return say(state, "Saved to long-term.");
  }

  // explicit “update/announce/tell the team”
  if (/^(update|announce|tell (the )?team|note|add|log)\b/.test(lower)) {
    const tail = raw.replace(/^(update|announce|tell (the )?team|note|add|log)\b[:\-]?\s*/i, "").trim();
    if (!tail) return say(state, "Tell me the update and I’ll add it.");
    state.updates.push({ text: tail, ts: now() });
    prune(state);
    return say(state, "Added to today’s updates.");
  }

  // nothing matched -> let caller handle as plain update or ask for clarity
  return null;
}

// ---------- answer from memory/docs ----------
async function answerFromMemory(state, question) {
  const pool = [
    ...state.longterm.map(x => ({ type: "lt", text: x.text })),
    ...state.docs.map(d => ({ type: "doc", text: d.text, name: d.name })),
  ];
  if (pool.length === 0) return "I don’t have that information yet. Ask your admin to add it.";

  const qset = new Set(tokens(question));
  const scored = pool.map(it => {
    const w = new Set(tokens(it.text));
    let overlap = 0; for (const t of qset) if (w.has(t)) overlap++;
    return { it, score: overlap / Math.max(1, Math.min(qset.size, w.size)) };
  }).sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 6).map(x => x.it.text);
  const system = `You are Nora, a voice-first team assistant. Answer ONLY using the provided context. If it's not covered, say you don't have that yet. Keep it brief and concrete.`;
  const user = `Question: ${question}\n\nContext:\n- ${top.join("\n- ")}`;

  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens: 220,
    }),
  });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "I don’t have that yet.").trim();
}

// ---------- STT / TTS ----------
async function transcribeRobust(b64, mime) {
  const data = Buffer.from(b64, "base64");
  if (data.length < 600) return "";

  const attempts = [
    { mime: normalizeMime(mime), ext: chooseExt(mime) },
    { mime: "audio/m4a", ext: ".m4a" },
    { mime: "audio/mp4", ext: ".mp4" },
    { mime: "audio/webm", ext: ".webm" },
    { mime: "audio/mpeg", ext: ".mp3" },
    { mime: "audio/wav", ext: ".wav" },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const fd = new FormData();
      fd.set("model", STT_MODEL);
      fd.set("temperature", "0.2");
      fd.set("prompt", "Short workplace update or question for a team assistant.");
      fd.set("file", new Blob([data], { type: a.mime }), "audio" + a.ext);
      const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd,
      });
      if (!r.ok) { lastErr = new Error(`STT ${r.status}: ${await r.text()}`); continue; }
      const j = await r.json();
      const text = (j.text || "").trim();
      if (text) return text;
    } catch (e) { lastErr = e; continue; }
  }
  throw lastErr || new Error("unrecognized_audio");
}
function normalizeMime(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("webm")) return "audio/webm";
  if (s.includes("m4a")) return "audio/m4a";
  if (s.includes("mp4")) return "audio/mp4";
  if (s.includes("mp3") || s.includes("mpeg") || s.includes("mpga")) return "audio/mpeg";
  if (s.includes("wav")) return "audio/wav";
  if (s.includes("ogg") || s.includes("oga")) return "audio/ogg";
  return "audio/webm";
}
function chooseExt(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("webm")) return ".webm";
  if (s.includes("m4a")) return ".m4a";
  if (s.includes("mp4")) return ".mp4";
  if (s.includes("mp3") || s.includes("mpeg") || s.includes("mpga")) return ".mp3";
  if (s.includes("wav")) return ".wav";
  if (s.includes("ogg") || s.includes("oga")) return ".ogg";
  return ".webm";
}

async function tts(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: sculpt(text),
      response_format: "mp3",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}
function sculpt(t) { let s = String(t || "").trim(); s = s.replace(/([.!?])\s+/g, "$1  "); if (!/[.!?…]$/.test(s)) s += "."; return s.slice(0, 4000); }

// ---------- small utils ----------
function bullets(arr) { return arr.map(s => "• " + s).join("  "); }
function tokens(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean); }
function prune(state) {
  const cut = now() - UPDATES_TTL_HOURS * 3600 * 1000;
  state.updates = state.updates.filter(u => (u.ts || 0) >= cut).slice(-500);
  state.longterm = state.longterm.slice(-1000);
  state.docs = state.docs.slice(-200);
}
function helpText() {
  return "I’m Nora. Say “admin” to add updates. Use phrases like “remember…”, “add to memory…”, “announce…”, or “delete…”. “What’s new?” reads today’s updates. “Repeat that” repeats my last response.";
}
async function say(state, text, extra = undefined) {
  state.lastSay = text;
  const audioUrl = await tts(text);
  return json({ audio: audioUrl, ...(extra || {}) });
}
