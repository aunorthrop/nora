// netlify/functions/voice.js
// Nora voice handler: STT -> intent/router -> TTS
// Requires: OPENAI_API_KEY

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1"; // OpenAI TTS
const DEFAULT_VOICE = "shimmer"; // a brighter / higher-pitch OpenAI voice

const DEMO_CODE = "TEAM-NORA";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  try {
    if (event.httpMethod === "OPTIONS") return reply(200, { ok: true }, headers);
    if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" }, headers);
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "OPENAI_API_KEY not set" }, headers);

    const body = safep(event.body);
    if (!body || !body.audio?.data || !body.audio?.mime) {
      return reply(400, { error: "Missing audio" }, headers);
    }

    const { businessId, sessionId, mode: clientMode } = body;
    const sid = sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    // Require team code unless you’re in demo
    if (!businessId || !String(businessId).trim()) {
      const say = "I need a team code before we start. Long-press the button to enter one.";
      const audioUrl = await speakTTS(say);
      return reply(200, { sessionId: sid, response: say, audio: audioUrl, control: { requireCode: true } }, headers);
    }

    // 1) STT
    const transcript = await transcribe(body.audio.data, body.audio.mime).catch(() => "");
    if (!transcript) {
      const say = "Sorry, I didn't catch that. Try again.";
      const audioUrl = await speakTTS(say);
      return reply(200, { sessionId: sid, response: say, audio: audioUrl }, headers);
    }
    const lower = transcript.trim().toLowerCase();

    // 2) Lightweight command router (fast path)
    // Enter admin mode
    if (lower === "admin" || lower.startsWith("admin ")) {
      const say = "Admin mode. Say “begin updates” to start, “add static info” for long-term notes, or “exit admin” to return to normal.";
      const audioUrl = await speakTTS(say);
      return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl, control: { adminArmed: true } }, headers);
    }

    // Admin mode commands (when client says it is armed)
    if (clientMode === "admin-armed") {
      if (/^exit admin\b/.test(lower)) {
        const say = "Exiting admin mode.";
        const audioUrl = await speakTTS(say);
        return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl, control: { adminDisarm: true } }, headers);
      }
      if (/^(begin|begin updates|start updates)\b/.test(lower)) {
        const say = "Okay. Recording today’s updates. Say “done” when finished.";
        const audioUrl = await speakTTS(say);
        return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl }, headers);
      }
      if (/^(add static info|add long[-\s]?term|long[-\s]?term info)/.test(lower)) {
        const say = "Ready to add long-term info. Speak the details, then say “done”.";
        const audioUrl = await speakTTS(say);
        return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl }, headers);
      }
      if (/^done$/.test(lower)) {
        const say = "Saved. Anything else, or say “exit admin”.";
        const audioUrl = await speakTTS(say);
        return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl }, headers);
      }
      // Fallback inside admin mode
      {
        const say = "Admin mode is active. Say “begin updates”, “add static info”, “done”, or “exit admin”.";
        const audioUrl = await speakTTS(say);
        return reply(200, { sessionId: sid, transcript, response: say, audio: audioUrl }, headers);
      }
    }

    // 3) Normal mode: brief answer from chat + TTS
    // If demo code, you’ll likely have no content yet; still handle politely
    const system = {
      role: "system",
      content:
        `You are Nora, a concise voice assistant for team updates and Q&A from the business owner.
- Voice-only; keep replies short (2–3 sentences).
- If there are no updates or no static info, say so plainly and invite the admin to add some using admin mode.
- Avoid medical, legal, or financial advice.
- Don’t claim personal memory about users; only refer to business info.`,
    };

    const user = { role: "user", content: transcript };

    const chatText = await chatOnce([system, user]).catch(() => "I’m having trouble responding right now.");
    const audioUrl = await speakTTS(chatText);

    return reply(200, { sessionId: sid, transcript, response: chatText, audio: audioUrl }, headers);

  } catch (err) {
    console.error(err);
    return reply(500, { error: "Internal Server Error" }, headers);
  }
};

/* ---------- helpers ---------- */

function reply(code, data, headers) {
  return { statusCode: code, headers, body: JSON.stringify(data) };
}
function safep(s) { try { return JSON.parse(s); } catch { return null; } }

async function transcribe(b64, mime) {
  const buf = Buffer.from(b64, "base64");
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("temperature", "0");
  const blob = new Blob([buf], { type: mime || "application/octet-stream" });
  fd.set("file", blob, "audio" + pickExt(mime));
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text || "").trim();
}

async function chatOnce(messages) {
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 180,
    }),
  });
  if (!r.ok) throw new Error(`Chat ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

async function speakTTS(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: DEFAULT_VOICE,
      input: sculpt(text),
      response_format: "mp3",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b}`;
}

function sculpt(t) {
  let s = String(t || "").trim();
  s = s.replace(/([.!?])\s+/g, "$1  ");
  if (!/[.!?…]$/.test(s)) s += ".";
  return s.slice(0, 4000);
}

function pickExt(m) {
  if (!m) return ".wav";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("ogg")) return ".ogg";
  return ".wav";
}
