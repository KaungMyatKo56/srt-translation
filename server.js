import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import multer from "multer";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises"; // <--- ADD FS IMPORT

dotenv.config();

let isPaused = false; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123admin"; // CHANGE THIS! 

// Initialize Clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); // <--- NEW CLIENT

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static("."));

// No password gate - open access for all routes

const PORT = 8080;

/* ---------------- HEALTH CHECK ---------------- */
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------------- GET MEMORY (Used for Login Check) ---------------- */
app.get("/get-memory", (req, res) => {
  res.json({ ok: true, message: "Access granted" });
});

/* ---------------- PASSCODE SYSTEM ---------------- */
const PASSCODE_FILE = "passcodes.json";

// Helper: Read/Write Passcodes
async function getPasscodes() {
    try {
        return JSON.parse(await fs.readFile(PASSCODE_FILE, "utf-8"));
    } catch (e) { return []; }
}
async function savePasscodes(codes) {
    await fs.writeFile(PASSCODE_FILE, JSON.stringify(codes, null, 2));
}

// LOGIC: Check Code Validity
async function validateAndBurnCode(inputCode) {
    const codes = await getPasscodes();
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const matchIndex = codes.findIndex(c => c.code === inputCode);
    
    if (matchIndex === -1) throw new Error("Invalid Passcode");
    
    const ticket = codes[matchIndex];

    if (ticket.used) throw new Error("This code has already been used!");
    if (now - ticket.created > oneDayMs) throw new Error("Code expired (older than 24h)");

    // BURN IT (Mark as used)
    codes[matchIndex].used = true;
    await savePasscodes(codes);
    return true;
}

/* ---------------- TRANSLATE STREAM ---------------- */
const uploadMiddleware = upload.single("file");

app.post("/translate-srt-stream", uploadMiddleware, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    if (!req.file) {
      res.write(`data: ${JSON.stringify({ error: "No file uploaded" })}\n\n`);
      return res.end();
    }

    const { from = "en", to = "my", provider = "gemini", mergeLines, timeOffset, movieContext, glossary, vipPasscode } = req.body;

    // --- LOCK PREMIUM PROVIDERS ---
    const premiumModels = ["super_hybrid", "openai-full", "deepl"]; // locked list
    
    if (premiumModels.includes(provider)) {
        if (!vipPasscode) {
             res.write(`data: ${JSON.stringify({ error: "🔒 Premium Passcode Required for " + provider })}\n\n`);
             return res.end();
        }

        try {
            await validateAndBurnCode(vipPasscode);
        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: "⛔ " + err.message })}\n\n`);
            return res.end();
        }
    }
    
    let rawText = req.file.buffer.toString("utf-8");

    // CLEANUP: Fix common file issues
    rawText = rawText.replace(/^WEBVTT.*\n+/g, ""); // Remove WebVTT header
    rawText = rawText.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, "$1,$2"); // Fix dot timestamps
    const blocks = rawText.replace(/\r\n/g, "\n").split(/\n\n+/).filter(b => b.trim());
    
    const total = blocks.length;
    const startTime = Date.now();
    let translatedSrt = [];

    // BATCH LOOP
    const BATCH_SIZE = 5;
    isPaused = false; 

    // --- GENRE PROMPT LOGIC ---
    // Get the genre from the request (default to 'general')
    const genre = req.body.movieType || "general";
    
    let styleInstruction = "Style: Natural Spoken Burmese (စကားပြော).";
    
    if (genre === "action") {
        styleInstruction = "Style: Aggressive, rude, and slang-heavy (use 'မင်း', 'ငါ', 'ကွ'). Short, punchy sentences.";
    } else if (genre === "romance") {
        styleInstruction = "Style: Soft, emotional, and intimate. Use polite or sweet markers (ရှင်, ဗျာ).";
    } else if (genre === "historical") {
        styleInstruction = "Style: Royal/Ancient Burmese (နန်းတွင်းစကား). Use 'အရှင်ဘုရား', 'မယ်မယ်', 'ကိုယ်တော်'.";
    } else if (genre === "comedy") {
        styleInstruction = "Style: Very casual, funny, and witty. Use modern youth slang.";
    } else if (genre === "documentary") {
        styleInstruction = "Style: Formal, objective, and polite (စာဆန်သော စကားပြော). Accurate terminology.";
    } else if (genre === "horror") {
        styleInstruction = "Style: Tense, scary, and suspenseful. Use eerie and dark language.";
    }

    for (let i = 0; i < total; i += BATCH_SIZE) {
      
      // PAUSE CHECKER
      while (isPaused) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        res.write(": keep-alive\n\n");
      }

      const batch = blocks.slice(i, i + BATCH_SIZE);
      
      const batchPromises = batch.map(async (block, batchIndex) => {
        const globalIndex = i + batchIndex;
        const lines = block.split("\n");
        
        // Handle bad blocks
        if (lines.length < 3 || (!lines[1].includes("-->"))) {
             return { index: globalIndex + 1, time: "00:00:00,000 --> 00:00:05,000", text: lines.join(" "), raw: block };
        }

        const index = lines[0];
        let time = lines[1];
        if (timeOffset && timeOffset != 0) {
          try { time = shiftTimeLine(time, timeOffset); } catch (e) {}
        }
        
        const textLines = lines.slice(2);
        const text = (mergeLines === "true") ? textLines.join(" ") : textLines.join("\n");
        const cleanText = text.replace(/<[^>]+>/g, ""); 

        // --- CONTEXT LOGIC ---
        let previousContext = "";
        const useSmartContext = req.body.smartContext === "true";

        if (useSmartContext) {
            // OPTION A: SMART (Last 10 lines)
            const startCtx = Math.max(0, globalIndex - 10);
            const historyBlocks = blocks.slice(startCtx, globalIndex);
            
            previousContext = historyBlocks
                .map(block => {
                    const parts = block.split("\n");
                    // Take text only (lines 2+), remove HTML
                    if (parts.length >= 3) {
                        return parts.slice(2).join(" ").replace(/<[^>]+>/g, "").trim();
                    }
                    return "";
                })
                .filter(line => line.length > 0)
                .join(" | ");
        } else {
            // OPTION B: SIMPLE (Last 1 line only - Faster)
            const prevBlock = globalIndex > 0 ? blocks[globalIndex - 1] : "";
            previousContext = prevBlock.replace(/\n/g, " ").substring(0, 100);
        }

        let translatedText = "";

        // --- TRANSLATION LOGIC ---
        try {
            // A. SUPER HYBRID: The "Avengers" Strategy
            if (provider === "super_hybrid") {
                // 1. Run ALL FOUR in Parallel (Azure, Gemini, GPT, DeepL)
                const [azureResult, geminiResult, gptResult, deeplResult] = await Promise.allSettled([
                    // Task 1: Azure
                    fetch(
                        `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${from}&to=${to}`,
                        {
                            method: "POST",
                            headers: {
                                "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY,
                                "Ocp-Apim-Subscription-Region": process.env.AZURE_TRANSLATOR_REGION,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify([{ text: cleanText }])
                        }
                    ).then(r => r.json()).then(d => d[0]?.translations[0]?.text || ""),

                    // Task 2: Gemini
                    (async () => {
                        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                        const res = await model.generateContent(`Translate to ${to}: "${cleanText}"`);
                        return res.response.text().trim();
                    })(),

                    // Task 3: GPT-4o Mini (Fast draft)
                    (async () => {
                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [{ role: "user", content: `Translate to ${to}: "${cleanText}"` }],
                            temperature: 0.3,
                        });
                        return completion.choices[0].message.content.trim();
                    })(),

                    // Task 4: DeepL
                    fetch('https://api.deepl.com/v2/translate', {
                        method: 'POST',
                        headers: {
                            'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            text: [cleanText],
                            target_lang: to.toUpperCase(),
                            source_lang: from.toUpperCase()
                        })
                    }).then(r => r.json()).then(d => d.translations?.[0]?.text || "")
                ]);

                // Extract drafts (handle failures gracefully)
                const draftAzure = azureResult.status === "fulfilled" ? azureResult.value : "(Azure Failed)";
                const draftGemini = geminiResult.status === "fulfilled" ? geminiResult.value : "(Gemini Failed)";
                const draftGPT = gptResult.status === "fulfilled" ? gptResult.value : "(GPT Failed)";
                const draftDeepL = deeplResult.status === "fulfilled" ? deeplResult.value : "(DeepL Failed)";

                // 2. The Boss (GPT-4o) decides the final version from FOUR drafts
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o", // Must use the smart model for editing
                    messages: [
                        { 
                          role: "system", 
                          content: `You are a Chief Subtitle Editor.
                          
                          Task: Create the PERFECT Burmese translation by combining the strengths of four AI drafts.
                          
                          - Draft 1 (Azure) is usually literal and accurate with nouns.
                          - Draft 2 (Gemini) is usually natural and good with slang.
                          - Draft 3 (GPT) is usually balanced and creative.
                          - Draft 4 (DeepL) is usually smooth and professional.
                          
                          Goal: Output ONE final sentence that sounds like a native Myanmar speaker (Natural Spoken Style/စကားပြော).
                          ` 
                        },
                        { 
                          role: "user", 
                          content: `Original English: "${cleanText}"
                          
                          Draft 1 (Azure): "${draftAzure}"
                          Draft 2 (Gemini): "${draftGemini}"
                          Draft 3 (GPT): "${draftGPT}"
                          Draft 4 (DeepL): "${draftDeepL}"
                          
                          Final Polish:` 
                        }
                    ],
                    temperature: 0.2,
                });
                translatedText = completion.choices[0].message.content.trim();
            }

            // B. EXISTING PROVIDERS (Keep your old logic below for single usage)
            else if (provider === "azure") {
                 // ... (Copy your existing Azure code here)
                 const resp = await fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${from}&to=${to}`, {
                     method: "POST", headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY, "Ocp-Apim-Subscription-Region": process.env.AZURE_TRANSLATOR_REGION, "Content-Type": "application/json" },
                     body: JSON.stringify([{ text: cleanText }])
                 });
                 const d = await resp.json();
                 if(d[0]?.translations) translatedText = d[0].translations[0].text;
            }
            // 2. GOOGLE GEMINI 2.0 (Emotional Mode)
            else if (provider === "gemini") {
                // Use the new 2.0 Flash model
                const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                
                const prompt = `
                    You are a professional movie subtitle translator.
                    
                    Task: Translate the following subtitle line from ${from} to ${to}.
                    
                    ${styleInstruction}
                    
                    CRITICAL RULES:
                    1. **Capture the Emotion**: If the scene is angry, use aggressive words. If sad, use soft words.
                    2. **No Robotic Phrasing**: Do not translate word-for-word. Rewrite it how a real person would speak.
                    3. **Context**: Conversation History: "${previousContext}". Match that tone.
                    4. **Glossary**: Do not translate: ${glossary || "None"}.
                    
                    Input Text: "${cleanText}"
                    
                    Output ONLY the translation.
                `;

                const result = await model.generateContent(prompt);
                const response = await result.response;
                translatedText = response.text().trim();
            }
            else if (provider.startsWith("openai") || provider === "hybrid") {
                 // --- PROVIDER 3: OPENAI (With Auto-Retry) ---
                 const targetModel = (provider === "openai-full" || provider === "hybrid") ? "gpt-4o" : "gpt-4o-mini";
                 
                 let attempts = 0;
                 let success = false;
                 
                 while (!success && attempts < 3) {
                    try {
                        const completion = await openai.chat.completions.create({
                            model: targetModel,
                            messages: [
                                { 
                                  role: "system", 
                                  content: `You are an expert subtitle scriptwriter.
                                  
                                  Your Goal: Translate from ${from} to ${to} so it sounds like a blockbuster movie script.
                                  
                                  ${styleInstruction}
                                  
                                  Guidelines:
                                  - **Tone is King**: Match the emotion of the text. (e.g., "Get out!" -> "ထွက်သွားစမ်း" if angry).
                                  - **Spoken Style**: Use natural, casual spoken Burmese (စကားပြော). Avoid formal book language.
                                  - **Brevity**: Subtitles must be short and punchy.
                                  - **Glossary**: Keep these terms as is: ${glossary || "None"}.` 
                                },
                                { 
                                  role: "user", 
                                  content: `Previous Conversation History: "${previousContext}"
                                  
                                  Translate this line: "${cleanText}"` 
                                }
                            ],
                            temperature: (genre === "documentary") ? 0.1 : 0.3, // Lower creativity for documentaries
                        });
                        translatedText = completion.choices[0].message.content.trim();
                        success = true; // It worked!
                    } catch (err) {
                        if (err.status === 429) {
                            console.log(`⏳ Hit Rate Limit. Waiting 5 seconds... (Attempt ${attempts+1}/3)`);
                            await new Promise(r => setTimeout(r, 5000)); // Wait 5s
                            attempts++;
                        } else {
                            throw err; // Real error, stop trying
                        }
                    }
                 }
            }

        } catch (err) {
            console.error(`Error line ${globalIndex}:`, err);
            translatedText = cleanText; // Fail safe
        }

        return { index, time, text: translatedText };
      });

      const results = await Promise.all(batchPromises);

      for (const resData of results) {
          if (resData.raw) { translatedSrt.push(resData.raw); continue; }

          translatedSrt.push(`${resData.index}\n${resData.time}\n${resData.text}`);

          const currentCount = translatedSrt.length;
          let percent = Math.round((currentCount / total) * 100);
          if (percent >= 100) percent = 99;

          res.write(`data: ${JSON.stringify({
              type: "line",
              percent: percent,
              current: currentCount,
              total: total,
              timeLeft: "...",
              index: resData.index,
              time: resData.time,
              text: resData.text
          })}\n\n`);
      }

      // === NEW SPEED LIMITER ===
      // Wait 2 seconds before the next batch to prevent Error 429
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    res.write(`data: ${JSON.stringify({ type: "done", result: translatedSrt.join("\n\n") })}\n\n`);
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

/* ---------------- CONTROL ---------------- */
app.post("/control", (req, res) => {
  const { action } = req.body;
  isPaused = (action === "pause");
  res.json({ status: isPaused ? "paused" : "running" });
});

/* ---------------- SAVE SPECIFIC LINES (TRAINING) ---------------- */
const TRAINING_FILE = "training_data.json";

app.post("/save-line", async (req, res) => {
    try {
        const { original, translated } = req.body;
        
        // 1. Read existing file
        let currentData = [];
        try {
            const fileContent = await fs.readFile(TRAINING_FILE, "utf-8");
            currentData = JSON.parse(fileContent);
        } catch (e) {
            // File doesn't exist yet, start empty
            currentData = [];
        }

        // 2. Add the new line
        currentData.push({ 
            original, 
            translated, 
            date: new Date().toISOString() 
        });

        // 3. Save back to file
        await fs.writeFile(TRAINING_FILE, JSON.stringify(currentData, null, 2));
        
        console.log(`📝 Saved training line: "${original.substring(0, 20)}..."`);
        res.json({ success: true });
    } catch (e) {
        console.error("Save line failed:", e);
        res.status(500).json({ error: e.message });
    }
});

/* ---------------- ADMIN PANEL LOGIC (No Login Required) ---------------- */

// Admin-only middleware
const adminOnly = (req, res, next) => {
    const adminPass = req.headers["x-admin-password"];
    console.log("🔐 Admin check - Received:", adminPass, "Expected:", ADMIN_PASSWORD);
    if (adminPass === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(403).json({ error: "Admin Only" });
    }
};

// A. Get All Codes (For Dashboard)
app.get("/admin/codes", adminOnly, async (req, res) => {
    const codes = await getPasscodes();
    res.json(codes);
});

// B. Generate VIP Code (Admin only)
app.get("/generate-vip", adminOnly, async (req, res) => {
    const newCode = "VIP-" + Math.floor(1000 + Math.random() * 9000); 
    const codes = await getPasscodes();
    codes.push({
        code: newCode,
        created: Date.now(),
        used: false
    });
    
    await savePasscodes(codes);
    res.json({ new_code: newCode });
});

// C. Validate VIP Code (Check without burning)
app.get("/validate-vip/:code", async (req, res) => {
    const inputCode = req.params.code;
    const codes = await getPasscodes();
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const match = codes.find(c => c.code === inputCode);
    
    if (!match) {
        return res.json({ valid: false, reason: "Invalid code" });
    }
    if (match.used) {
        return res.json({ valid: false, reason: "Code already used" });
    }
    if (now - match.created > oneDayMs) {
        return res.json({ valid: false, reason: "Code expired" });
    }
    
    res.json({ valid: true });
});

/* ---------------- START ---------------- */
app.listen(PORT, () => {
  console.log(`✅ Server running on http://127.0.0.1:${PORT}`);
});

// Helper for time shift
function shiftTimeLine(timeLine, offsetMs) {
  if (!offsetMs || offsetMs == 0) return timeLine;

  // Function to convert "HH:MM:SS,mmm" to milliseconds
  const toMs = (str) => {
    const parts = str.split(/[:,]/); // Split by : or ,
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseInt(parts[2], 10);
    const ms = parseInt(parts[3], 10);
    return (h * 3600000) + (m * 60000) + (s * 1000) + ms;
  };

  // Function to convert milliseconds back to "HH:MM:SS,mmm"
  const fromMs = (ms) => {
    if (ms < 0) ms = 0; // Prevent negative time
    const h = Math.floor(ms / 3600000);
    ms %= 3600000;
    const m = Math.floor(ms / 60000);
    ms %= 60000;
    const s = Math.floor(ms / 1000);
    ms %= 1000;
    
    // Pad with zeros (e.g., 5 -> "05")
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  };

  // Split "start --> end"
  const [startStr, endStr] = timeLine.split(" --> ");
  
  // Calculate new times
  const newStart = fromMs(toMs(startStr.trim()) + parseInt(offsetMs));
  const newEnd = fromMs(toMs(endStr.trim()) + parseInt(offsetMs));

  return `${newStart} --> ${newEnd}`;
}
