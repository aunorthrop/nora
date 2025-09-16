import {
  addDirective, listDirectives, removeLastDirective, removeDirectiveContaining, clearDirectives,
  addUpdate, addStatic, removeLast, removeContaining, clearAll,
  searchRelevant, snapshot, getSettings, setAdminPass
} from "./_shared/store.js";

const OPENAI_ROOT = "https://api.openai.com/v1";
const CHAT_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const STT_MODEL = "whisper-1";
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE || "shimmer");
const DEFAULT_TONE = (process.env.DEFAULT_TONE || "neutral").toLowerCase();

const MAX_TURNS = 30;
const memoryStore = new Map();
const sessionState = new Map();

const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST, OPTIONS, GET",
  "Cache-Control":"no-cache"
};

export const handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:hdrs, body: JSON.stringify({ ok:true }) };
    if (event.httpMethod === "GET")     return { statusCode:200, headers:hdrs, body: JSON.stringify({ message:"Nora OK", ts:new Date().toISOString() }) };
    if (event.httpMethod !== "POST")    return { statusCode:405, headers:hdrs, body: JSON.stringify({ error:"Method Not Allowed" }) };
    if (!process.env.OPENAI_API_KEY)    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:"OPENAI_API_KEY not configured" }) };

    const body = JSON.parse(event.body || "{}");
    const { businessId, sessionId, audio } = body;
    if (!businessId) return reply(400, { error:"Missing businessId" });
    if (!audio?.data || !audio?.mime) return reply(400, { error:"Missing audio" });

    const sid = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    // STT
    const transcript = await transcribe(audio.data, audio.mime).catch(()=> "");
    if (!transcript.trim())
      return speakText(200, sid, businessId, "I heard you, but I couldn’t catch the words—try a touch closer to the mic.", { tone:DEFAULT_TONE, max_speak_ms:5000 });

    logHistory(sid, { role:"user", content:transcript });

    const state = ensureSession(sid);
    const lower = transcript.toLowerCase().trim();

    // === Onboarding role detection ===
    if (/^(?:i'?m|i am|we are|we're)?\s*(the\s*)?admin\b/.test(lower) || /^admin$/.test(lower)) {
      const settings = getSettings(businessId);
      if (!settings.adminPass) {
        return speakText(200, sid, businessId,
          "Great. Say “activate admin mode” to set the admin password and start adding updates.",
          { tone:"serious", max_speak_ms:6500 });
      }
      return speakText(200, sid, businessId,
        "You can say “activate admin mode” to enter admin mode and manage updates.",
        { tone:"serious", max_speak_ms:6000 });
    }
    if (/\b(employee|staff)\b/.test(lower) || /^employee$/.test(lower)) {
      return speakText(200, sid, businessId,
        "Got it. I’ll share updates when there are any. You can ask questions like “What’s today’s schedule?” or “Remind me of the policy on breaks.”",
        { tone:"neutral", max_speak_ms:7500 });
    }

    // === Admin mode flow ===
    if (/^activate\b.*admin\b.*mode\b/.test(lower)) {
      const settings = getSettings(businessId);
      if (settings.adminPass) {
        state.awaitingPassword = true;
        return speakText(200, sid, businessId, "Speak the admin password.", { tone:"serious", max_speak_ms:4000 });
      } else {
        state.awaitingNewPass = true;
        return speakText(200, sid, businessId, "No admin password is set. Say: “new password is …”.", { tone:"serious", max_speak_ms:5000 });
      }
    }

    if (state.awaitingPassword) {
      const ok = passwordMatches(getSettings(businessId).adminPass, transcript);
      state.awaitingPassword = false;
      if (!ok) return speakText(200, sid, businessId, "That password didn’t match. Say “activate admin mode” to try again.", { tone:"serious", max_speak_ms:5000 });
      state.isAdmin = true;
      return speakText(200, sid, businessId, "Admin mode activated. You can say update, static, forget, or change admin password.", { tone:"serious", max_speak_ms:6000 });
    }

    if (/^change\b.*admin\b.*password\b/.test(lower)) {
      if (!state.isAdmin) return speakText(200, sid, businessId, "You need admin mode to change the password. Say “activate admin mode”.", { tone:"serious", max_speak_ms:6000 });
      state.awaitingNewPass = true;
      return speakText(200, sid, businessId, "Ready. Say: “new password is …”.", { tone:"serious", max_speak_ms:5000 });
    }

    if (state.awaitingNewPass) {
      const m = transcript.match(/new\s+password\s+is\s+(.+)/i);
      const pass = (m ? m[1] : transcript).trim();
      if (!pass || pass.length < 3) return speakText(200, sid, businessId, "Please say a longer password.", { tone:"serious", max_speak_ms:4000 });
      setAdminPass(businessId, pass);
      state.awaitingNewPass = false;
      state.isAdmin = true;
      return speakText(200, sid, businessId, "Admin password saved. You’re in admin mode.", { tone:"serious", max_speak_ms:5000 });
    }

    if (/^exit\b.*admin\b.*mode\b/.test(lower)) {
      state.isAdmin = false;
      return speakText(200, sid, businessId, "Exiting admin mode.", { tone:"neutral", max_speak_ms:3000 });
    }

    // Admin CRUD
    if (state.isAdmin) {
      const out = handleAdminCRUD(businessId, transcript);
      if (out) return speakText(200, sid, businessId, out, { tone:"serious", max_speak_ms:7000 });
    }

    // Employee Q&A (unchanged)
    const hits = searchRelevant(businessId, transcript, { kUpdates:3, kStatics:3 });
    const sys = buildSystemPrompt(businessId);
    const context = buildContext(hits);
    const messages = [
      { role:"system", content: sys + `\n\nCONTEXT:\n${context}` },
      ...getHistory(sid).map(m=>({ role:m.role, content:m.content })).slice(-MAX_TURNS*2),
      { role:"user", content: transcript }
    ];

    const out = await chatJSON(messages).catch(()=>({
      say:"I hit a snag. Mind asking that again?",
      tone:DEFAULT_TONE, can_interrupt:true, max_speak_ms:4500,
      confidence:0.6, receipt:null, interrupt_now:false, interrupt_reason:null, follow_up:null, humor_level:0
    }));

    let sayNow = out.say;
    if (out.interrupt_now && out.follow_up) sayNow = out.follow_up;
    else if (out.receipt && out.receipt.trim()) sayNow = `${sayNow.trim()}  ${out.receipt.trim()}`;

    logHistory(sid, { role:"assistant", content:sayNow });
    return speakText(200, sid, businessId, sayNow, out);

  }catch(err){
    console.error("voice handler error:", err);
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error:`Internal server error: ${err.message}` }) };
  }
};

// --- remainder of file (STT, CRUD helpers, prompts, TTS, history) stays the same as your last version ---
