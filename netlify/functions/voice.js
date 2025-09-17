// Nora voice function — server TTS intro, STT→Chat→TTS replies, flexible admin verbs, team-scoped memory
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const STT_MODEL = "whisper-1";
const TTS_MODEL = "tts-1";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "shimmer";
const OPENAI_TTS_SPEED = parseFloat(process.env.OPENAI_TTS_SPEED || "0.96");

const DB = globalThis.__NORA_DB__ || (globalThis.__NORA_DB__ = new Map());
function teamState(code) {
  if (!DB.has(code)) {
    DB.set(code, {
      updates: [],
      longterm: [],
      staticInfo: [], // For policies, procedures, etc.
      lastTs: Date.now(),
      introGiven: false
    });
  }
  return DB.get(code);
}

const ok = (b) => resp(200, b);
const err = (s, b) => resp(s, b);
function resp(s, b) {
  return {
    statusCode: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS"
    },
    body: JSON.stringify(b)
  };
}
const isCode = s => /^[0-9]{4}-[0-9]{4}$/.test(String(s || ""));

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });
  
  try {
    if (!OPENAI_API_KEY) return err(500, { error: "OPENAI_API_KEY missing" });
    
    const body = JSON.parse(event.body || "{}");
    const code = body.businessId;
    
    if (!isCode(code)) {
      return ok({ 
        error: "missing_or_bad_team_code", 
        control: { requireCode: true } 
      });
    }
    
    const state = teamState(code);

    // Direct TTS for any text
    if (typeof body.say === "string" && body.say.trim()) {
      const audio = await tts(body.say);
      return ok({ audio, response: body.say });
    }

    // First-time intro
    if (body.intro) {
      const text = introText();
      const audio = await tts(text);
      state.introGiven = true;
      return ok({ audio, response: text });
    }

    // Check if returning user needs updates
    if (body.checkForUpdates) {
      const recentUpdates = state.updates.slice(-5);
      if (recentUpdates.length > 0) {
        const updateText = `Welcome back! Here are your latest updates: ${recentUpdates.map(u => u.text).join('. ')}. What would you like to know?`;
        const audio = await tts(updateText);
        return ok({ audio, response: updateText });
      } else {
        const noUpdatesText = "Welcome back! No new updates since your last visit. What can I help you with?";
        const audio = await tts(noUpdatesText);
        return ok({ audio, response: noUpdatesText });
      }
    }

    // Normal conversation turn
    const audioIn = body.audio;
    const role = String(body.role || "employee");
    
    if (!audioIn?.data || !audioIn?.mime) {
      return ok({ audio: null, response: "I'm listening—try again." });
    }

    const userText = (await stt(audioIn.data, audioIn.mime)).trim();
    if (!userText) {
      return ok({ audio: null, response: "I couldn't hear that clearly—try again." });
    }

    const lower = userText.toLowerCase();

    // Role switching
    if (/\b(admin( mode)?|i'?m the admin|i am admin|manager|boss)\b/.test(lower)) {
      const say = "Admin mode activated. Go ahead with your updates—I'll remember everything you tell me.";
      return ok({ 
        ...(await sayTTS(say)), 
        control: { role: "admin" } 
      });
    }
    
    if (/\b(employee( mode)?|i'?m (an? )?employee|team member|worker)\b/.test(lower)) {
      const say = "Got it, you're set as a team member.";
      return ok({ 
        ...(await sayTTS(say)), 
        control: { role: "employee" } 
      });
    }

    // Prevent non-admins from saving (with helpful guidance)
    if (role !== "admin" && /^(remember|save|add|note|store|keep|log|write|record)\b/i.test(userText)) {
      return sayTTS("I can save that for you, but first say 'admin mode' to continue.");
    }

    // Admin commands for saving information
    if (role === "admin") {
      // Save general updates/policies/info
      if (/^(remember|save|add|note|store|keep|log|write|record)\b/i.test(userText)) {
        const cleaned = userText.replace(/^(remember|save|add|note|store|keep|log|write|record)\b[:,\-\s]*/i, "").trim();
        const content = cleaned || userText;
        
        // Determine if it's a policy/procedure or general update
        if (/\b(policy|procedure|rule|process|how to|always|never|must|should)\b/i.test(content)) {
          state.staticInfo.push({ text: content, ts: Date.now(), type: 'policy' });
        } else {
          state.updates.push({ text: content, ts: Date.now() });
        }
        
        state.lastTs = Date.now();
        return sayTTS("Got it, saved to memory.");
      }
      
      // Remove information
      if (/^(forget|remove|delete|clear|drop)\b/i.test(userText)) {
        const cleaned = userText.replace(/^(forget|remove|delete|clear|drop)\b[:,\-\s]*/i, "").trim();
        
        // Remove from both updates and static info
        state.updates = state.updates.filter(u => 
          u.text.toLowerCase().indexOf(cleaned.toLowerCase()) === -1
        );
        state.staticInfo = state.staticInfo.filter(s => 
          s.text.toLowerCase().indexOf(cleaned.toLowerCase()) === -1
        );
        
        state.lastTs = Date.now();
        return sayTTS("Removed from memory.");
      }
    }

    // Quick status commands
    if (/\b(what('?| i)s new|any updates|latest|recent)\b/i.test(lower)) {
      const recent = state.updates.slice(-5);
      if (recent.length > 0) {
        const say = `Latest updates: ${recent.map(u => u.text).join('. ')}`;
        return sayTTS(say);
      } else {
        return sayTTS("No new updates right now. What questions do you have?");
      }
    }

    // Show what's been saved
    if (/^(what (do you have|did you save)|show me (what you have|updates)|list (updates|info))/i.test(lower)) {
      const allInfo = [
        ...state.updates.slice(-3).map(u => u.text),
        ...state.staticInfo.slice(-3).map(s => s.text)
      ];
      
      if (allInfo.length > 0) {
        const say = `Here's what I have: ${allInfo.join('. ')}`;
        return sayTTS(say);
      } else {
        return sayTTS("I don't have any information saved yet.");
      }
    }

    // Main conversation using all saved context
    const allContext = [
      ...state.staticInfo.map(x => `Policy/Info: ${x.text}`),
      ...state.updates.slice(-20).map(x => `Update: ${x.text}`)
    ].join("\n");

    const systemPrompt = [
      "You are Nora, a voice-first team assistant for businesses.",
      "Your role: Help team members with information their admin has saved.",
      "Key behaviors:",
      "- Be conversational and warm, like talking to a helpful colleague",
      "- Prioritize recent admin updates and policies when answering",
      "- If you don't have specific info, say so clearly and suggest they ask their admin",
      "- Keep responses concise (1-3 sentences) since this is voice-only",
      "- Never make up policies or information that wasn't provided",
      "- If someone asks for admin functions but isn't admin, guide them politely",
      "Voice style: Natural, friendly, efficient. Avoid corporate jargon."
    ].join(" ");

    const contextPrompt = [
      "Available information from admin:",
      allContext || "(No information saved yet)",
      "",
      "Team member asks:",
      userText
    ].join("\n");

    const reply = await chat(systemPrompt, contextPrompt);
    return sayTTS(reply || "I don't have that information yet. You might want to ask your admin to add it.");

  } catch (e) {
    console.error("Nora error:", e);
    return err(500, { error: "server_error" });
  }
};

// Helper functions
async function sayTTS(text) {
  return { audio: await tts(text), response: text };
}

async function stt(b64, mime) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 300) return ""; // Accept shorter audio clips
  
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("temperature", "0");
  fd.set("file", new Blob([buf], { type: mime || "application/octet-stream" }), "audio.webm");
  
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd
  });
  
  if (!r.ok) throw new Error(`STT ${r.status}`);
  const j = await r.json();
  return (j.text || "");
}

async function tts(text) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${OPENAI_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: String(text || "").slice(0, 4000),
      response_format: "mp3",
      speed: Math.max(0.8, Math.min(1.15, OPENAI_TTS_SPEED))
    })
  });
  
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${b64}`;
}

async function chat(system, user) {
  const r = await fetch(`${OPENAI_ROOT}/chat/completions`, {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${OPENAI_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.4,
      max_tokens: 200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  
  if (!r.ok) throw new Error(`CHAT ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}

function introText() {
  return "Hi, I'm Nora, your team's voice assistant. If you're the admin or manager, say 'admin mode' and I'll remember everything you tell me—updates, policies, procedures, anything your team needs to know. Team members can ask me questions about what you've shared. I'm always listening when I'm on, and you can interrupt me anytime. Press the button again to turn me off.";
}
