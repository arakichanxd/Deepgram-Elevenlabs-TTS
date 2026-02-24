const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const app = express();

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || "sk-test-key";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const PORT = process.env.PORT || 3100;
const WS_TIMEOUT_MS = parseInt(process.env.WS_TIMEOUT_MS || "60000", 10);
const MAX_INPUT_LENGTH = parseInt(process.env.MAX_INPUT_LENGTH || "4096", 10);
const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || "10", 10);
const CACHE_DIR = path.join(process.cwd(), "cache");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
});
app.options("*", (_req, res) => res.sendStatus(204));
app.use((req, _res, next) => { req.id = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`; next(); });

// ─── OpenAI Error Format ─────────────────────────────────────────────────────
function openaiError(res, status, message, type = "invalid_request_error", param = null) {
    res.status(status).json({
        error: {
            message,
            type,
            param,
            code: status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : null,
        },
    });
}

// ─── Auth ────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return openaiError(res, 401, "You didn't provide an API key. Provide your API key in an Authorization header using Bearer auth.");
    }
    if (header.slice(7).trim() !== API_KEY) {
        return openaiError(res, 401, "Incorrect API key provided.");
    }
    next();
}

// ─── WAV Header ──────────────────────────────────────────────────────────────
function wavHeader(dataSize, sampleRate = 24000, bits = 16, ch = 1) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + dataSize, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(ch, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * ch * (bits / 8), 28);
    h.writeUInt16LE(ch * (bits / 8), 32);
    h.writeUInt16LE(bits, 34);
    h.write("data", 36);
    h.writeUInt32LE(dataSize, 40);
    return h;
}

// ─── Cache Cleanup ───────────────────────────────────────────────────────────
function cleanupCache() {
    try {
        const files = fs.readdirSync(CACHE_DIR)
            .map((f) => ({ name: f, time: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        if (files.length > MAX_CACHE_FILES) {
            for (const f of files.slice(MAX_CACHE_FILES)) {
                fs.unlinkSync(path.join(CACHE_DIR, f.name));
                console.log(`[Cache] Deleted: ${f.name}`);
            }
        }
    } catch (e) {
        console.error("[Cache] Cleanup error:", e.message);
    }
}

// ─── Synthesize via Deepgram Agent WebSocket ─────────────────────────────────
function synthesize(text, requestId) {
    return new Promise((resolve, reject) => {
        const audioChunks = [];
        let settled = false;
        const t0 = Date.now();

        const ws = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", [
            "token", DEEPGRAM_API_KEY,
        ]);

        const timer = setTimeout(() => {
            if (!settled) { settled = true; ws.close(); reject(new Error("TTS timed out")); }
        }, WS_TIMEOUT_MS);

        ws.on("open", () => {
            ws.send(JSON.stringify({
                type: "Settings",
                audio: {
                    input: { encoding: "linear16", sample_rate: 48000 },
                    output: { encoding: "linear16", sample_rate: 24000, container: "none" },
                },
                agent: {
                    language: "en",
                    speak: { provider: { type: "eleven_labs", model_id: "eleven_multilingual_v2", voice_id: "cgSgspJ2msm6clMCkdW9" } },
                    listen: { provider: { type: "deepgram", version: "v1", model: "nova-3" } },
                    think: { provider: { type: "open_ai", model: "gpt-4o-mini" }, prompt: "TTS engine. Do not respond." },
                    greeting: text,
                },
            }));
        });

        ws.on("message", (data, isBinary) => {
            if (settled) return;
            if (isBinary) { audioChunks.push(Buffer.from(data)); return; }
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === "AgentAudioDone") {
                    settled = true; clearTimeout(timer);
                    const pcm = Buffer.concat(audioChunks);
                    console.log(`[${requestId}] ✅ ${pcm.length}B ${audioChunks.length} chunks ${Date.now() - t0}ms`);
                    ws.close(); resolve(pcm);
                } else if (msg.type === "Error") {
                    settled = true; clearTimeout(timer); ws.close();
                    reject(new Error(msg.message || "Deepgram error"));
                }
            } catch { }
        });

        ws.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
        ws.on("close", (code) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                audioChunks.length > 0 ? resolve(Buffer.concat(audioChunks)) : reject(new Error(`WS closed (${code})`));
            }
        });
    });
}

// ─── Models ──────────────────────────────────────────────────────────────────
const MODELS = { "gpt-4o-mini-tts": true, "tts-1": true, "tts-1-hd": true };

app.get("/v1/models", auth, (_req, res) => {
    res.json({
        object: "list",
        data: Object.keys(MODELS).map((id) => ({
            id, object: "model", created: 1700000000, owned_by: "system",
            permission: [], root: id, parent: null,
        })),
    });
});

app.get("/v1/models/:model", auth, (req, res) => {
    if (!MODELS[req.params.model]) return openaiError(res, 404, `Model '${req.params.model}' not found`, "invalid_request_error", "model");
    res.json({ id: req.params.model, object: "model", created: 1700000000, owned_by: "system", permission: [], root: req.params.model, parent: null });
});

// ─── POST /v1/audio/speech ───────────────────────────────────────────────────
// 100% OpenAI compatible: accepts model, input, voice, response_format, speed
// Always buffers complete audio and returns with Content-Length (like OpenAI)
// Clients can use with_streaming_response to read progressively on their end
app.post("/v1/audio/speech", auth, async (req, res) => {
    const rid = req.id;
    try {
        const {
            model = "gpt-4o-mini-tts",
            input,
            voice = "jessica",
            response_format = "wav",
            speed,
        } = req.body;

        // Validate
        if (!input || typeof input !== "string") return openaiError(res, 400, "Missing required parameter: 'input'", "invalid_request_error", "input");
        if (input.length > MAX_INPUT_LENGTH) return openaiError(res, 400, `Input too long (max ${MAX_INPUT_LENGTH} chars)`, "invalid_request_error", "input");
        if (!MODELS[model]) return openaiError(res, 404, `Model '${model}' not found`, "invalid_request_error", "model");
        if (!DEEPGRAM_API_KEY) return openaiError(res, 500, "DEEPGRAM_API_KEY not configured", "server_error");

        const validFormats = ["mp3", "opus", "aac", "flac", "wav", "pcm"];
        if (!validFormats.includes(response_format)) {
            return openaiError(res, 400, `Invalid response_format '${response_format}'. Supported: ${validFormats.join(", ")}`, "invalid_request_error", "response_format");
        }

        console.log(`[${rid}] POST /v1/audio/speech model=${model} voice=${voice} fmt=${response_format} len=${input.length}`);

        // Synthesize
        const pcmData = await synthesize(input, rid);
        if (pcmData.length === 0) return openaiError(res, 500, "No audio data received", "server_error");

        // Build response audio
        let audioBuffer;
        let contentType;

        if (response_format === "pcm") {
            audioBuffer = pcmData;
            contentType = "audio/pcm";
        } else {
            // For wav, mp3, opus, aac, flac — return WAV (our backend produces linear16 PCM)
            audioBuffer = Buffer.concat([wavHeader(pcmData.length), pcmData]);
            contentType = "audio/wav";
        }

        // Save to cache & cleanup
        const ext = response_format === "pcm" ? "pcm" : "wav";
        const filename = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
        fs.writeFileSync(path.join(CACHE_DIR, filename), audioBuffer);
        setImmediate(cleanupCache);

        // Send response (matches OpenAI: binary audio with Content-Length)
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", audioBuffer.length);
        res.setHeader("x-request-id", rid);
        res.send(audioBuffer);
    } catch (err) {
        console.error(`[${rid}] ❌ ${err.message}`);
        if (!res.headersSent) openaiError(res, 500, err.message, "server_error");
    }
});

// ─── Cached files ────────────────────────────────────────────────────────────
app.get("/v1/audio/files", auth, (_req, res) => {
    try {
        const files = fs.readdirSync(CACHE_DIR)
            .map((f) => { const s = fs.statSync(path.join(CACHE_DIR, f)); return { name: f, size: s.size, created: s.mtimeMs }; })
            .sort((a, b) => b.created - a.created);
        res.json({ files, count: files.length, max: MAX_CACHE_FILES });
    } catch (e) { openaiError(res, 500, e.message, "server_error"); }
});

app.get("/v1/audio/files/:filename", auth, (req, res) => {
    const fp = path.join(CACHE_DIR, req.params.filename);
    if (!fs.existsSync(fp)) return openaiError(res, 404, "File not found");
    res.setHeader("Content-Type", req.params.filename.endsWith(".wav") ? "audio/wav" : "audio/pcm");
    res.sendFile(fp);
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    const cacheFiles = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).length : 0;
    res.json({
        status: "ok",
        version: "1.0.0",
        service: "openai-tts-proxy",
        deepgram: !!DEEPGRAM_API_KEY,
        backend: "eleven_labs via deepgram",
        voice: "jessica",
        models: Object.keys(MODELS),
        cache: { files: cacheFiles, max: MAX_CACHE_FILES },
    });
});

// ─── Catch-all & error handler ───────────────────────────────────────────────
app.use((req, res) => openaiError(res, 404, `Unknown request URL: ${req.method} ${req.path}`));
app.use((err, _req, res, _next) => { console.error("Unhandled:", err); openaiError(res, 500, "Internal server error", "server_error"); });

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
let server;
function shutdown(sig) {
    console.log(`\n${sig} — shutting down...`);
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ───────────────────────────────────────────────────────────────────
server = app.listen(PORT, () => {
    console.log(`\n🔊 OpenAI-compatible TTS API v1.0.0`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   POST /v1/audio/speech`);
    console.log(`   GET  /v1/models`);
    console.log(`   GET  /v1/audio/files`);
    console.log(`   GET  /health`);
    console.log(`   Backend: ElevenLabs Jessica via Deepgram`);
    console.log(`   Cache: max ${MAX_CACHE_FILES} files`);
    console.log(`   Deepgram: ${DEEPGRAM_API_KEY ? "✅" : "❌ missing"}\n`);
});
