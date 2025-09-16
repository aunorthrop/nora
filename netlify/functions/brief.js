// Speaks a quick brief + first-run onboarding if requested
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
    const body = JSON.parse(event.body || "{}");
    const businessId = body.businessId;
    const firstRun = !!body.firstRun;

    if (!isValidCode(businessId)) {
      return json({ error: "missing_or_bad_team_code", control: { requireCode: true } });
    }

    const team = mem.get(businessId) || { updates: [], longterm: [] };
    const cutoff = now() - BRIEF_WINDOW_HOURS * 3600 * 1000;
    const recent = team.updates.filter(u => (u.ts || 0) >= cutoff).map(u => u.text);

    let text;
    if (firstRun) {
      // crisp onboarding, then context
      const headline = recent.length
        ? "Welcome to Nora. I’ll read today’s updates, then you can ask questions. If you’re the admin, just say “admin” to add or delete updates; say “long-term: …” for permanent info; say “done” when finished."
        : "Welcome to Nora. If you’re the admin, say “admin” to add updates; say “long-term: …” for permanent info; say “done” when finished. Employees can ask “what’s new?” or any question covered by updates or files.";
      const tail = recent.length
        ? "Here’s what’s new. " + recent.slice(-8).map(s => "• " + s).join("  ")
        : "There are no updates yet.";
      text = headline + "  " + tail;
    } else {
      text = recent.length
        ? "Here’s the latest. " + recent.slice(-8).map(s => "• " + s).join("  ")
        : "No new updates right now.";
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
