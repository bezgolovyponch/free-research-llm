# FREE ROUTING: keep the models going in a circle

**The problem:** one free provider runs out (HTTP 429 per minute or per day, Groq HTTP 413 at 8000 tokens per minute, an empty Pollinations reply) and the loop or the coder stops.

**The existing open-source fix:** [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT). It is one OpenAI-compatible endpoint in front of the free tiers of 34 providers. It keeps a counter per key for requests and tokens per minute and per day. It skips a key before it hits its limit. On 429 or 5xx it cools that key and moves to the next model in the fallback chain. This app talks to it as its `custom` provider. Its own router stays behind it as the second line.

A smaller alternative is [freelm](https://github.com/shihabshahrier/freelm) (MIT, `pip install freelm` or `npm install freelm`, `freelm serve` on `http://127.0.0.1:4000/v1`, model `auto`). It does the same thing with environment-variable keys. The steps below use FreeLLMAPI.

## 1 · Install FreeLLMAPI

**macOS or Linux** (needs Docker Desktop running):

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

It sets up `~/freellmapi` and starts the router at `http://localhost:3001`. It listens on this computer only.

**Windows:** download the desktop `.exe` installer from https://github.com/tashfeenahmed/freellmapi/releases and run it.

## 2 · Give it your free keys

1. Open http://localhost:3001.
2. **Keys** page: paste every free key you have. Free signup links are in [KEYS.md](KEYS.md): Gemini, Groq, Cerebras, Mistral, NVIDIA, SambaNova, OpenRouter, Cloudflare, Cohere. Every extra key adds to the circle.
3. **Fallback Chain:** put the fast providers first (Cerebras, Groq), then Gemini and Mistral, then the rest.
4. Copy the unified key (`freellmapi-…`) from the header of the **Keys** page.

## 3 · Point this app at it

Run these in the app's **Terminal** (or a terminal in the app folder). Each one asks for one value, which goes into the system key store, never into a file.

```bash
node src/frl.mjs keys set CUSTOM_LLM_BASE_URL
node src/frl.mjs keys set CUSTOM_LLM_MODEL
node src/frl.mjs keys set CUSTOM_LLM_API_KEY
node src/frl.mjs keys set FRL_PROVIDER_ORDER
node src/frl.mjs restart
```

Type these values when asked:

| Setting | Value |
|---|---|
| `CUSTOM_LLM_BASE_URL` | `http://localhost:3001/v1` |
| `CUSTOM_LLM_MODEL` | `auto` |
| `CUSTOM_LLM_API_KEY` | the unified `freellmapi-…` key (input is hidden) |
| `FRL_PROVIDER_ORDER` | `custom,pollinations` |

`custom,pollinations` means: every call goes to FreeLLMAPI first. If even that has nothing left, the keyless Pollinations takes the call. To keep the app's direct keys as well, list them after it: `custom,cerebras,groq,gemini,mistral,openrouter,pollinations`.

`restart` works when the app runs as the always-on service (`node src/frl.mjs install`). Otherwise stop the app and start it again.

## 4 · Check it

```bash
node src/frl.mjs status
```

**Setup & keys** in the app must show `custom` as ready. FreeLLMAPI's dashboard shows each request and the provider that answered it.

## 5 · Keep the loop running

1. Make the app always on, so it survives restarts and sleep: `node src/frl.mjs install`.
2. Open the research, then choose **Improve loop ▾ → Entire research…** or **Selected pieces…**. Set the hours (up to 72) and press **Start**.
3. When the app restarts, it resumes the loop with the hours that were left, and keeps the same selection and exclusions.
4. To run every research in turn, use **Improve all researches** on the home page.

## What the app already does without FreeLLMAPI

The app's own router (`src/llm/router.mjs`) also goes in a circle: it tries the providers in `FRL_PROVIDER_ORDER`, puts a provider on a cooldown after a 429, and moves to the next. What FreeLLMAPI adds:

- It counts each key's daily quota, so no call is wasted on a provider that is already spent. The 2026-10-19 loop wasted 71 Gemini and 78 OpenRouter calls that way.
- It rotates several keys of the same provider.
- It covers 34 providers instead of 13.
