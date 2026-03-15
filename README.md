# OpenAI-Compatible TTS API

Drop-in replacement for OpenAI's `/v1/audio/speech` endpoint — powered by **ElevenLabs** and **Cartesia** voices via the **Deepgram Agent API**.

**Repository:** [arakichanxd/Deepgram-Elevenlabs-TTS](https://github.com/arakichanxd/Deepgram-Elevenlabs-TTS)

Only needs a `DEEPGRAM_API_KEY`. No ElevenLabs or Cartesia key required!

## Features

- **True Real-Time Chunked Streaming**: Immediately pipes binary audio to the client as soon as Deepgram generates the first bytes. Drops Time-to-First-Byte (TTFB) latency by up to 210% for slower/multilingual models!
- **Multi-Provider Support**: Supports dynamic routing between ElevenLabs and Cartesia directly out of the box.
- **100% OpenAI Compatible**: Drop-in compatible with the official OpenAI SDK and standard REST endpoints. 
- **Caching Memory**: Caches recent audio hashes automatically.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/audio/speech` | Generate speech from text |
| `GET` | `/v1/models` | List available TTS models |
| `GET` | `/v1/models/:id` | Get model details |
| `GET` | `/v1/audio/files` | List cached audio files |
| `GET` | `/health` | Health check |

## Available Voices

We inherently support voices distributed across **ElevenLabs** and **Cartesia Sonic**.

| Voice Name | Provider | Description |
|------------|----------|-------------|
| `jessica` | ElevenLabs | Fast, natural female voice |
| `daniel` | ElevenLabs | Fast, natural male voice |
| `piper` | ElevenLabs | High-quality multilingual female |
| `mark` | ElevenLabs | High-quality multilingual male |
| `kentucky_man` | Cartesia | Southern US male |
| `helpful_woman` | Cartesia | Clear, professional female |

*(Pass any of the names above to the `voice` parameter in your request)*

## Quick Start

```bash
npm install

# Setup your keys
cp .env.example .env
# Edit .env and supply your keys:
# API_KEY=sk-your-custom-auth-key
# DEEPGRAM_API_KEY=your-deepgram-key

npm start
```

## Usage (OpenAI SDK)

```javascript
const OpenAI = require("openai");
const fs = require("fs");

const client = new OpenAI({
  baseURL: "http://localhost:3100/v1",
  apiKey: "sk-your-custom-auth-key",
});

const response = await client.audio.speech.create({
  model: "gpt-4o-mini-tts", // Ignored, kept for compatibility
  input: "Hello, how are you today?",
  voice: "piper", // Pick jessica, daniel, piper, mark, kentucky_man, helpful_woman
});

// The server supports progressive streaming automatically!
const buf = Buffer.from(await response.arrayBuffer());
fs.writeFileSync("output.wav", buf);
```

## cURL

```bash
curl -X POST http://localhost:3100/v1/audio/speech \
  -H "Authorization: Bearer sk-your-custom-auth-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini-tts","input":"Hello world","voice":"helpful_woman"}' \
  -o output.wav
```

## How It Works

```
[Client] → POST /v1/audio/speech → [Proxy] → Deepgram WebSocket → (ElevenLabs/Cartesia TTS) → [Client Chunked Stream]
```

The server opens a WebSocket to Deepgram's Agent API, maps your `voice` selection to the correct internal provider ID, sets the `greeting` to your input text, and immediately begins piping the `AgentAudio` chunks back to your HTTP response via `Transfer-Encoding: chunked`. 

### Latency Benchmarks
A benchmark script (`benchmark_stream.js`) is included. Testing multi-lingual voices like `Piper` on long texts demonstrated a drop from **~38 seconds (waiting for the whole file)** to just **~18 seconds (streaming TTS TTFB)**—a **2.1x speed improvement**.

## Testing Scripts

```bash
npm install openai dotenv

# Run standard test suite
npm test

# Run TTFB Benchmark
node benchmark_stream.js
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEEPGRAM_API_KEY` | ✅ | — | Deepgram API key |
| `API_KEY` | ✅ | `sk-test-key` | Client auth key (Bearer) |
| `PORT` | ❌ | `3100` | Server port |
| `WS_TIMEOUT_MS` | ❌ | `60000` | WebSocket timeout |
| `MAX_CACHE_FILES` | ❌ | `10` | Max cached audio files |

## Deploy to Render

1. Create a new **Web Service** on Render
2. Set environment: `Docker`
3. Add env vars: `API_KEY`, `DEEPGRAM_API_KEY`
4. Deploy — health check hits `GET /`

## License

MIT
