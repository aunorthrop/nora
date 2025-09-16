// Speaks a quick brief based on last BRIEF_WINDOW_HOURS updates + any long-term headlines
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";
const BRIEF_WINDOW_HOURS = Number(process.env.BRIEF_WINDOW_HOURS || 24);

const mem = globalThis.__NORA_MEM__ || (globalThis.__NORA_MEM__ = new Map());
function isValidCode(code) { return /^[0-9]{4}-[0-9]{4}$/.test(code || ""); }
function now(){ return Date.now(); }

export const handler = async (event) => {
  try {
    const { businessId } = JSON.parse(event.body || "{}");
    if (!isValidCode(businessId)) {
      return json({ error: "missing_or_bad_team_code", control: { requireCode: true } });
    }
    const team = mem.get(businessId) || { updates: [], longterm: [] };
    const cutoff = now() - BRIEF_WINDOW_HOURS * 3600 * 1000;
    const recent = team.updates.filter(u => (u.ts || 0) >= cutoff).map(u => u.text);

    let text;
    if (recent.length) {
      const bullets = recent.slice(-8).map(s => "• " + s).join("  ");
      text = `Here’s the latest. ${bullets}`;
    } else {
      text = "No new updates right now.";
    }

    const tts = await ttsSay(text);
    return json({ ok: true, audio: tts });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" });
  }
};

function json(body) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

async function ttsSay(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: String(text || "").slice(0, 4000),
      response_format: "mp3",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
  const b = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b}`;
}
