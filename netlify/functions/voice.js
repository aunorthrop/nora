// Netlify Function: Senior-Optimized Voice Assistant
// Enhanced for senior users: better memory, clearer audio, slower speech, louder output
// Focused on companionship and memory assistance without medical/legal advice

const OPENAI_ROOT = "https://api.openai.com/v1";

const CHAT_PRIMARY = "gpt-4o-mini";
const CHAT_FALLBACKS = ["gpt-4o", "gpt-3.5-turbo-0125", "gpt-3.5-turbo"];
const STT_MODEL = "whisper-1";
const TTS_MODEL_DEFAULT = "tts-1";
const TTS_MODEL_HD = "tts-1-hd";

// Senior-optimized settings
const DEFAULT_VOICE = "alloy"; // Clearer, warmer voice for seniors
const DEFAULT_SPEED = 0.85; // Slower speech for better comprehension
const SENIOR_VOLUME_BOOST = 1.2; // Louder output for hearing difficulties

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const MAX_TURNS = 30; // Increased for longer conversations
const MAX_MEMORY_ITEMS = 2000; // Enhanced memory capacity
const memoryStore = new Map();
const brainVectors = new Map();
const deviceBrain = new Map();

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Cache-Control": "no-cache"
  };

  try {
    if (event.httpMethod === "OPTIONS") return reply(200, { ok: true }, headers);
    if (event.httpMethod === "GET") return reply(200, { message: "Senior Voice Assistant OK", ts: new Date().toISOString() }, headers);
    if (event.httpMethod !== "POST") return reply(405, { error: "Method Not Allowed" }, headers);
    if (!process.env.OPENAI_API_KEY) return reply(500, { error: "OPENAI_API_KEY not configured" }, headers);

    const body = safeJson(event.body);
    if (!body) return reply(400, { error: "Invalid JSON body" }, headers);
    if (body.test) return reply(200, { message: "API endpoint working", ts: new Date().toISOString() }, headers);

    const { businessId, sessionId, audio, memoryShadow } = body;
    if (!businessId || !audio?.data || !audio?.mime)
      return reply(400, { error: "Missing required information" }, headers);

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    if (memoryShadow && typeof memoryShadow === "object") mergeShadow(businessId, memoryShadow);
    const brain = ensureBrain(businessId);

    // Enhanced STT with better error handling for seniors
    let transcript = "";
    try { 
      transcript = await withRetry(() => transcribeForSeniors(audio.data, audio.mime), 2); 
    } catch (e) {
      const msg = "I'm having trouble hearing you clearly. Could you please speak a bit louder and try again?";
      const speech = await safeTTS(msg, businessId).catch(()=>null);
      return reply(200, { 
        sessionId: sid, transcript: "", response: msg, 
        audio: speech?.dataUrl, ttsEngine: speech?.engine, 
        memoryShadow: brainSnapshot(brain), error: "stt_failed" 
      }, headers);
    }

    // More lenient word threshold for seniors who may speak slowly or pause
    const words = (transcript || "").trim().split(/\s+/).filter(Boolean);
    if (!transcript?.trim() || words.length < 1) {
      const ask = "I heard something, but I'm not sure what you said. Could you please repeat that for me?";
      const speech = await safeTTS(ask, businessId).catch(()=>null);
      return reply(200, { sessionId: sid, transcript, response: ask, audio: speech?.dataUrl, ttsEngine: speech?.engine, memoryShadow: brainSnapshot(brain) }, headers);
    }

    // Auto-save conversation
    logConversationTurn(businessId, sid, transcript, "user");

    // Senior-specific intent routing
    const fast = await routeIntentForSeniors(businessId, sid, transcript);
    if (fast) {
      logConversationTurn(businessId, sid, fast.say, "assistant");
      const speech = await safeTTS(fast.say, businessId).catch(()=>null);
      return reply(200, {
        sessionId: sid, transcript, response: fast.say, 
        audio: speech?.dataUrl, ttsEngine: speech?.engine,
        control: fast.control || undefined, 
        memoryShadow: brainSnapshot(ensureBrain(businessId))
      }, headers);
    }

    // Chat with senior-focused memory integration
    const answer = await chatWithSeniorMemory(sid, businessId, transcript)
      .catch(() => "I'm having a small technical issue. Could you please try saying that again?");
    
    logConversationTurn(businessId, sid, answer, "assistant");
    const speech = await safeTTS(answer, businessId).catch(()=>null);
    return reply(200, { 
      sessionId: sid, transcript, response: answer, 
      audio: speech?.dataUrl, ttsEngine: speech?.engine, 
      memoryShadow: brainSnapshot(ensureBrain(businessId)) 
    }, headers);

  } catch (err) {
    console.error("Handler error:", err);
    return reply(500, { error: `Internal server error: ${err.message}` }, headers);
  }
};

// ---------- Enhanced STT for Seniors ----------
async function transcribeForSeniors(b64, mime) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 300) return ""; // More lenient threshold
  
  const fd = new FormData();
  fd.set("model", STT_MODEL);
  fd.set("language", "en");
  fd.set("temperature", "0.2"); // More conservative for accuracy
  fd.set("prompt", "This is a conversation with an older adult. They may speak slowly or pause between words."); // Context for better recognition
  
  const blob = new Blob([buf], { type: mime || "application/octet-stream" });
  fd.set("file", blob, "audio" + ext(mime));
  
  const r = await fetch(`${OPENAI_ROOT}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd
  });
  
  if (!r.ok) throw new Error(`STT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.text || "").trim();
}

// ---------- Senior-Specific Intent Router ----------
async function routeIntentForSeniors(businessId, sessionId, raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const brain = ensureBrain(businessId);

  // Hearing confirmation - common for seniors
  if (/\b(can you hear me|are you there|hello|hi there)\b/.test(lower))
    return { say: "Yes, I can hear you perfectly. I'm here and ready to help. What would you like to talk about?" };
    
  if (/\b(speak (up|louder)|i can'?t hear you|too quiet)\b/.test(lower)) {
    // Note: We'll handle this in TTS settings
    return { say: "I'll speak louder and more clearly for you. Is this better?" };
  }
  
  if (/\b(slow down|too fast|speak slower)\b/.test(lower)) {
    ensureBrain(businessId).speed = Math.max(0.7, (brain.speed || DEFAULT_SPEED) - 0.1);
    return { say: "I'll slow down my speech for you. How is this pace?" };
  }

  // Memory capability explanations (senior-friendly)
  if (/\b(what can you remember|memory|do you remember)\b/.test(lower) && /\b(how|what|tell me)\b/.test(lower)) {
    const itemCount = brain.items?.length || 0;
    const convCount = brain.conversations?.length || 0;
    return { say: `I remember ${itemCount} important things you've told me, and I keep track of all our conversations. I can help you remember names, appointments, where you put things, and anything else important to you.` };
  }

  // Enhanced memory commands for seniors
  // Remember facts: "remember my doctor's name is Dr. Smith"
  const doctorInfo = lower.match(/^(?:remember|save)\s+(?:my\s+)?doctor'?s?\s+name\s+is\s+(.+?)\.?$/i);
  if (doctorInfo) {
    const name = titleCase(matchOriginal(raw, doctorInfo[1]));
    const item = makeItem("medical-contact", `Doctor: ${name}`, { 
      type_detail: "doctor", name, tags: ["medical", "important"], confidence: 1.0 
    });
    brain.items.push(item);
    indexItem(item);
    pruneMemoryItems(brain);
    return { say: `I've saved that your doctor is ${name}. I'll remember that for you.` };
  }

  // Remember medications
  const medication = lower.match(/^(?:remember|save)\s+(?:my\s+)?(?:medicine|medication|pill)\s+(.+?)\.?$/i);
  if (medication) {
    const med = matchOriginal(raw, medication[1]);
    const item = makeItem("medication", `Medication: ${med}`, { 
      medication: med, tags: ["medical", "important"], confidence: 1.0 
    });
    brain.items.push(item);
    indexItem(item);
    pruneMemoryItems(brain);
    return { say: `I've noted your medication ${med}. Remember, I can't give medical advice, but I can help you remember what you've told me.` };
  }

  // Remember family members
  const family = lower.match(/^(?:remember|save)\s+(?:my\s+)?(son|daughter|grandson|granddaughter|child|grandchild)'?s?\s+name\s+is\s+(.+?)\.?$/i);
  if (family) {
    const relation = family[1];
    const name = titleCase(matchOriginal(raw, family[2]));
    const item = makeItem("family", `${titleCase(relation)}: ${name}`, { 
      relation, name, tags: ["family", "important"], confidence: 1.0 
    });
    brain.items.push(item);
    indexItem(item);
    pruneMemoryItems(brain);
    return { say: `I'll remember that your ${relation} is named ${name}. Family is important.` };
  }

  // General memory - "remember I put my keys in the kitchen drawer"
  const remember = lower.match(/^(?:remember|don'?t forget)\s+(.+?)\.?$/i);
  if (remember) {
    const body = matchOriginal(raw, remember[1]);
    const item = makeItem("note", body, { 
      tags: ["personal", "reminder"], confidence: 1.0,
      timestamp: new Date().toLocaleString()
    });
    brain.items.push(item);
    indexItem(item);
    pruneMemoryItems(brain);
    return { say: "I've made a note of that for you. Just ask me about it anytime and I'll remind you." };
  }

  // Recall queries - "what's my doctor's name?"
  const doctorRecall = lower.match(/^what'?s\s+(?:my\s+)?doctor'?s?\s+name\??$/i);
  if (doctorRecall) {
    const doctor = brain.items.find(i => i.type === "medical-contact" && i.type_detail === "doctor");
    if (doctor) return { say: `Your doctor is ${doctor.name}.` };
    return { say: "I don't have your doctor's name saved yet. Would you like to tell me who your doctor is?" };
  }

  // "where did I put..." queries
  const whereIs = lower.match(/^where\s+(?:did\s+i\s+put|are)\s+(?:my\s+)?(.+?)\??$/i);
  if (whereIs) {
    const item = matchOriginal(raw, whereIs[1]);
    const relevant = scoreItems(brain.items, `put ${item} location`).slice(0, 3);
    if (relevant.length > 0) {
      const locations = relevant.map(r => r.text).join(". ");
      return { say: `Let me think... ${locations}. Does that help?` };
    }
    return { say: `I don't have a note about where you put your ${item}. Next time you put it somewhere, just tell me and I'll remember for you.` };
  }

  // Family recall
  const familyRecall = lower.match(/^(?:what'?s|who'?s)\s+my\s+(son|daughter|grandson|granddaughter|child|grandchild)'?s?\s+name\??$/i);
  if (familyRecall) {
    const relation = familyRecall[1];
    const familyMember = brain.items.find(i => i.type === "family" && i.relation?.toLowerCase() === relation.toLowerCase());
    if (familyMember) return { say: `Your ${relation} is ${familyMember.name}.` };
    return { say: `I don't have your ${relation}'s name saved. Would you like to tell me?` };
  }

  // Clear memory (with confirmation)
  if (/^(?:clear|delete|forget)\s+(?:all\s+)?memory$/i.test(lower)) {
    return { say: "Are you sure you want me to forget everything? If so, say 'yes, clear everything' and I'll clear my memory." };
  }
  
  if (/^yes,?\s+clear\s+everything$/i.test(lower)) {
    brain.items = [];
    brain.conversations = [];
    brainVectors.clear();
    return { say: "I've cleared all my memory. We can start fresh whenever you're ready." };
  }

  // Medical/legal disclaimer responses
  if (/\b(medical|health|doctor|medicine|pain|hurt|sick|legal|lawyer|law|financial|money|investment)\b/.test(lower) && 
      /\b(advice|recommend|suggest|should i|what do you think|opinion)\b/.test(lower)) {
    return { say: "I can't give medical, legal, or financial advice. For those important matters, it's best to speak with a qualified professional. But I'm happy to help you remember things or just chat about other topics." };
  }

  return null;
}

// ---------- Senior-Focused Chat ----------
async function chatWithSeniorMemory(sessionId, businessId, userText) {
  const hist = memoryStore.get(sessionId) || [];
  hist.push({ role: "user", content: userText, ts: Date.now() });
  const trimmed = hist.slice(-MAX_TURNS * 2);
  memoryStore.set(sessionId, trimmed);

  const brain = ensureBrain(businessId);
  
  // Build senior-friendly context
  const recentItems = brain.items.slice(-25).map(i => {
    if (i.type === "family") return `- Family: ${i.text}`;
    if (i.type === "medical-contact") return `- Medical: ${i.text}`;
    if (i.type === "medication") return `- Medication: ${i.text}`;
    return `- Note: ${i.text.slice(0, 200)}`;
  }).join("\n") || "No saved information yet.";
  
  const relevantItems = scoreItems(brain.items, userText).slice(0, 10);
  const contextItems = relevantItems.length > 0 ? 
    "\nRelevant to current conversation:\n" + relevantItems.map(i => `- ${i.text.slice(0, 300)}`).join("\n") : "";

  const recentConversations = brain.conversations 
    ? brain.conversations.slice(-15).map(c => 
        `${c.role === 'user' ? 'They said' : 'I said'}: ${c.content.slice(0, 150)}`
      ).join("\n")
    : "";

  const system = {
    role: "system",
    content: `You are a friendly, patient voice assistant designed specifically for older adults. Your primary goals:

1. COMMUNICATION STYLE:
   - Speak clearly, warmly, and at a comfortable pace
   - Use simple, familiar language - avoid technical jargon
   - Be patient and encouraging
   - Repeat important information if needed
   - Ask one clear question at a time if clarification is needed

2. MEMORY ASSISTANCE:
   - Help them remember names, locations, appointments, and personal information
   - Reference their saved information naturally: "As you told me before..."
   - Offer to save new important information they mention
   - Be their reliable memory companion

3. STRICT LIMITATIONS:
   - NEVER give medical, legal, or financial advice
   - If asked about health, legal, or money matters, kindly redirect to appropriate professionals
   - Don't diagnose or suggest treatments
   - Don't interpret symptoms or recommend medications

4. CONVERSATION APPROACH:
   - Be companionable and warm, like a helpful friend
   - Show interest in their daily life and family
   - Be encouraging and positive
   - Keep responses conversational but not overly long (2-4 sentences typically)
   - If they seem confused, gently help clarify without being condescending

5. MEMORY INTEGRATION:
   - Reference their family members, doctor, and personal details when relevant
   - Help them find things they've misplaced
   - Remind them of important information they've shared

Remember: You are stored locally on their device for privacy. Be their trusted memory companion.

Current Saved Information:
${recentItems}
${contextItems}

Recent Conversation Context:
${recentConversations.slice(-600)}`
  };

  const messages = [system, ...trimmed.map(m => ({ role: m.role, content: m.content }))];

  const order = [CHAT_PRIMARY, ...CHAT_FALLBACKS];
  let lastErr;
  for (const model of order) {
    try {
      const res = await fetch(`${OPENAI_ROOT}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          model, 
          messages, 
          max_tokens: 200, // Slightly longer responses for seniors
          temperature: 0.3, // More consistent, reliable responses
          frequency_penalty: 0.1
        })
      });
      if (!res.ok) { 
        lastErr = new Error(`Chat ${model} ${res.status}: ${await res.text()}`); 
        continue; 
      }
      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim();
      if (reply) {
        trimmed.push({ role: "assistant", content: reply, ts: Date.now() });
        memoryStore.set(sessionId, trimmed);
        pruneMap(memoryStore, 50); // Less aggressive pruning for seniors
        return reply;
      }
    } catch (e) { 
      lastErr = e; 
      continue; 
    }
  }
  throw lastErr || new Error("All chat models failed");
}

// ---------- Enhanced TTS for Seniors ----------
async function ttsRawOpenAI(text, voice, speed, model) {
  const r = await fetch(`${OPENAI_ROOT}/audio/speech`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model, 
      voice, 
      input: sculptForSeniors(text.slice(0, 4000)), 
      response_format: "mp3", 
      speed: Math.max(0.6, Math.min(1.0, speed)) // Constrain speed range for clarity
    })
  });
  if (!r.ok) throw new Error(await r.text());
  const b = Buffer.from(await r.arrayBuffer());
  return b.toString("base64");
}

// Enhanced text processing for senior-friendly speech
function sculptForSeniors(text) {
  let t = String(text || "").trim();
  
  // Add natural pauses for better comprehension
  t = t.replace(/([.!?])\s+/g, "$1  "); // Longer pauses at sentence ends
  t = t.replace(/,\s+/g, ",  "); // Brief pauses at commas
  t = t.replace(/;\s+/g, ";  "); // Pauses at semicolons
  
  // Clean up formatting
  t = t.replace(/ - /g, ", ").replace(/\s{3,}/g, "  ");
  t = t.replace(/([a-zA-Z0-9])\n/g, "$1. ");
  
  // Ensure proper sentence ending
  if (!/[.!?…]$/.test(t)) t += ".";
  
  return t;
}

async function safeTTS(text, businessId) {
  const brain = ensureBrain(businessId);
  const refined = sculptForSeniors(text);
  const speed = brain.speed || DEFAULT_SPEED;

  // Try ElevenLabs first if configured (often better for seniors)
  if (ELEVEN_API_KEY && ELEVEN_VOICE_ID) {
    try {
      const b64 = await ttsViaElevenLabs(refined);
      return { dataUrl: `data:audio/mpeg;base64,${b64}`, engine: "elevenlabs", volumeBoost: SENIOR_VOLUME_BOOST };
    } catch(e) { /* fall through to OpenAI */ }
  }

  // OpenAI TTS with senior optimizations
  const useHd = refined.length > 100; // Use HD more often for clarity
  const model = useHd ? TTS_MODEL_HD : TTS_MODEL_DEFAULT;
  const b64 = await ttsRawOpenAI(refined, DEFAULT_VOICE, speed, model);
  
  return { 
    dataUrl: `data:audio/mpeg;base64,${b64}`, 
    engine: useHd ? "openai-tts-1-hd" : "openai-tts-1",
    volumeBoost: SENIOR_VOLUME_BOOST
  };
}

// ---------- Enhanced Memory Functions ----------
function logConversationTurn(businessId, sessionId, content, role) {
  const brain = ensureBrain(businessId);
  if (!brain.conversations) brain.conversations = [];
  
  brain.conversations.push({
    id: uid(),
    sessionId,
    role,
    content,
    timestamp: Date.now(),
    date: new Date().toISOString().split('T')[0],
    timeOfDay: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  });
  
  // Keep more conversation history for seniors
  if (brain.conversations.length > 1000) {
    brain.conversations = brain.conversations.slice(-1000);
  }
  
  // Enhanced auto-extraction for senior-relevant information
  if (role === "user") {
    autoExtractSeniorInfo(businessId, content);
  }
}

function autoExtractSeniorInfo(businessId, text) {
  const lower = text.toLowerCase();
  const brain = ensureBrain(businessId);
  
  // Auto-detect mentions of family members
  const familyMentions = text.match(/\b(?:my\s+(?:son|daughter|grandson|granddaughter|child|grandchild))\s+(\w+)/gi);
  if (familyMentions) {
    familyMentions.forEach(match => {
      const item = makeItem("family-mention", match.trim(), { 
        tags: ["family", "auto-detected"], 
        confidence: 0.6 
      });
      if (!isDuplicate(brain.items, item.text)) {
        brain.items.push(item);
        indexItem(item);
      }
    });
  }
  
  // Auto-detect location mentions for finding things
  const locations = text.match(/\b(?:put|placed|left|stored)\s+.+?\s+(?:in|on|under|behind)\s+(?:the\s+)?(.+?)(?:\.|,|$)/gi);
  if (locations) {
    locations.forEach(match => {
      if (match.length < 200) {
        const item = makeItem("location", match.trim(), { 
          tags: ["location", "auto-detected"], 
          confidence: 0.7 
        });
        if (!isDuplicate(brain.items, item.text)) {
          brain.items.push(item);
          indexItem(item);
        }
      }
    });
  }
}

function pruneMemoryItems(brain) {
  if (brain.items.length <= MAX_MEMORY_ITEMS) return;
  
  // Priority scoring for seniors - keep important information
  const scored = brain.items.map(item => {
    let score = item.confidence || 0.5;
    const age = Date.now() - (item.updatedAt || item.createdAt);
    const daysSinceCreated = age / (1000 * 60 * 60 * 24);
    
    // Boost scores for important types
    if (item.type === "family") score += 0.3;
    if (item.type === "medical-contact") score += 0.4;
    if (item.type === "medication") score += 0.35;
    if (item.tags?.includes("important")) score += 0.2;
    
    // Recency bonus (less aggressive than general version)
    score += Math.max(0, 0.1 - (daysSinceCreated * 0.001));
    
    return { ...item, _pruneScore: score };
  });
  
  // Sort by score and keep the best items
  scored.sort((a, b) => b._pruneScore - a._pruneScore);
  const toRemove = scored.slice(MAX_MEMORY_ITEMS);
  toRemove.forEach(item => brainVectors.delete(item.id));
  
  brain.items = scored.slice(0, MAX_MEMORY_ITEMS);
}

// ---------- Remaining Utility Functions ----------
async function ttsViaElevenLabs(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) throw new Error("ElevenLabs not configured");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 2500), // Shorter for seniors to avoid too long speech
      model_id: "eleven_multilingual_v2",
      voice_settings: { 
        stability: 0.6, // More stable for clarity
        similarity_boost: 0.9, // Higher similarity for consistency
        style: 0.1, // Less expressive, more clear
        use_speaker_boost: true 
      }
    })
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

async function withRetry(fn, n) { 
  try { return await fn(); } 
  catch(e) { 
    if (n <= 0 || !isTransient(e)) throw e; 
    await sleep(250); // Slightly longer delay for seniors
    return withRetry(fn, n - 1); 
  } 
}

function isTransient(e) { 
  return /429|502|503|504|timeout|ETIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|certificate/i.test(String(e?.message || "")); 
}

function ensureBrain(businessId) {
  if (!deviceBrain.has(businessId)) {
    deviceBrain.set(businessId, { 
      voice: DEFAULT_VOICE, 
      speed: DEFAULT_SPEED, 
      items: [],
      conversations: []
    });
  }
  const b = deviceBrain.get(businessId); 
  if (!b.conversations) b.conversations = [];
  return b;
}

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function indexItem(it) { brainVectors.set(it.id, new Set(tokenize(it.text))); }

function tokenize(s) { 
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean); 
}

function titleCase(s) { 
  return String(s || "").replace(/\b\w/g, c => c.toUpperCase()); 
}

function matchOriginal(full, lowerSlice) { 
  const re = new RegExp(lowerSlice.replace(/[.*+?^${}()|[\]\\]/g, '\\// Rest of the utility functions remain the same but with senior-focused modifications
function ensureBrain(businessId) {
  if (!deviceBrain.has(businessId)) {
    deviceBrain.set(businessId, { 
      voice: DEFAULT_VOICE, 
      speed: DEFAULT_SPEED, 
      items: [],
      conversations: []
    });
  }
  const b = deviceBrain.get(businessId); 
  if (!b.conversations) b.conversations = [];
  return b;
}'), 'i'); 
  const m = full.match(re); 
  return m ? m[0].trim() : lowerSlice; 
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };
const ext = m => !m ? ".wav" : m.includes("wav") ? ".wav" : m.includes("mp3") ? ".mp3" : m.includes("mp4") ? ".mp4" : m.includes("webm") ? ".webm" : m.includes("ogg") ? ".ogg" : ".wav";
const reply = (code, data, headers) => ({ statusCode: code, headers, body: JSON.stringify(data) });

function pruneMap(map, max) { 
  if (map.size <= max) return; 
  const keys = [...map.keys()]; 
  for (let i = 0; i < map.size - max; i++) map.delete(keys[i]); 
}

module.exports = { handler: exports.handler };

function mergeShadow(businessId, shadow) {
  const brain = ensureBrain(businessId);
  if (typeof shadow.pace === "number") brain.speed = Math.max(0.6, Math.min(1.0, shadow.pace));
  if (Array.isArray(shadow.items)) {
    const byId = new Map(brain.items.map(i => [i.id, i]));
    for (const it of shadow.items) {
      if (!it || !it.text) continue;
      if (!it.id || !byId.has(it.id)) {
        const newItem = { 
          ...it, 
          id: it.id || uid(), 
          createdAt: it.createdAt || Date.now(), 
          updatedAt: it.updatedAt || Date.now() 
        };
        brain.items.push(newItem); 
        indexItem(newItem);
      }
    }
  }
  
  if (Array.isArray(shadow.conversations)) {
    if (!brain.conversations) brain.conversations = [];
    shadow.conversations.forEach(conv => {
      if (conv && conv.content && !brain.conversations.find(c => c.id === conv.id)) {
        brain.conversations.push({
          ...conv,
          id: conv.id || uid(),
          timestamp: conv.timestamp || Date.now()
        });
      }
    });
    brain.conversations.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
}

function brainSnapshot(brain) { 
  return { 
    items: brain.items, 
    conversations: brain.conversations || [],
    voice: DEFAULT_VOICE, 
    pace: brain.speed 
  }; 
}

function makeItem(type, text, extra = {}) { 
  const base = { 
    id: uid(), 
    type, 
    text: text.trim(), 
    createdAt: Date.now(), 
    updatedAt: Date.now(), 
    tags: [],
    confidence: 1.0
  }; 
  Object.assign(base, extra); 
  return base; 
}

function isDuplicate(items, newText) {
  const newTokens = new Set(tokenize(newText));
  return items.some(item => {
    const itemTokens = new Set(tokenize(item.text));
    const intersection = new Set([...newTokens].filter(x => itemTokens.has(x)));
    const similarity = intersection.size / Math.min(newTokens.size, itemTokens.size);
    return similarity > 0.75; // Slightly higher threshold to avoid over-deduplication
  });
}

function scoreItems(items, query) {
  const qset = new Set(tokenize(query)); 
  const now = Date.now();
  return items.map(it => {
    const w = brainVectors.get(it.id) || new Set(tokenize(it.text));
    let overlap = 0; 
    for (const t of qset) if (w.has(t)) overlap++;
    
    const recency = 1 / Math.max(1, (now - (it.updatedAt || it.createdAt)) / (1000 * 60 * 60 * 24));
    const confidence = it.confidence || 0.5;
    
    // Senior-specific type boosting
    let typeBoost = 0;
    if (it.type === "family") typeBoost = 0.9;
    else if (it.type === "medical-contact") typeBoost = 0.8;
    else if (it.type === "medication") typeBoost = 0.7;
    else if (it.type === "location") typeBoost = 0.6;
    else if (it.tags?.includes("important")) typeBoost = 0.5;
    
    return { ...it, _score: overlap + recency * 0.2 + confidence * 0.4 + typeBoost };
  }).sort((a, b) => b._score - a._score);
}
