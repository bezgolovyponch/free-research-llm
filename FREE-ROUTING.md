# FREE ROUTING: keep the models going in a circle

**The problem:** one free provider runs out (HTTP 429 per minute or per day, Groq HTTP 413 at 8000 tokens per minute, an overloaded Gemini model, an empty Pollinations reply) and the loop or the coder stops.

**The fix lives in the app.** The router (`src/llm/router.mjs`) needs no other program, so it works on every computer the app runs on. Your keys travel with `keys export` / `keys import`. For each call it does this:

1. **Order.** It tries the providers in `FRL_PROVIDER_ORDER` (or the built-in order) and skips any provider that is resting.
2. **A busy model** (HTTP 503, or a 429 that says "overloaded" / "high traffic" / "Provider returned error") rests for 10 minutes. The same call goes on with the provider's next model. One busy Gemini model no longer benches all of Gemini.
3. **A model that used its own daily quota, or was withdrawn,** is set aside until the quota resets (or for good). The same call goes on with the next model.
4. **A key that hit a limit** (429, 402, 401/403) rests. The same call goes on with the provider's next key. The provider rests only when every key rests, and it comes back when the first key is free again.
5. **Daily resets** are taken from each provider. Gemini resets at midnight Pacific time ([Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)); the others reset at midnight UTC.
6. One call makes at most 3 model or key switches inside one provider. Then the call moves on to the next provider.

## 1 · More capacity: more providers, more keys

Capacity grows only with free quota. Add every provider in [KEYS.md](KEYS.md). Two of them have **no daily cap**:

| Provider | Free limit | Key |
|---|---|---|
| NVIDIA (build.nvidia.com) | about 40 requests per minute, no daily cap | `NVIDIA_API_KEY` |
| Mistral (free Experiment plan) | 1 request per second, about 1 billion tokens per month; your data may be used for training | `MISTRAL_API_KEY` |

**Several keys for one provider:** paste them separated by commas, in one value:

```bash
node src/frl.mjs keys set GEMINI_API_KEY      # paste: AIza...first,AIza...second
```

`keys check` tests each key and names the one that fails. Use only keys you are allowed to hold under each provider's terms.

## 2 · Another computer, same keys

```bash
node src/frl.mjs keys export     # on this computer: choose a passphrase, copy the encrypted line
node src/frl.mjs keys import     # on the other computer: paste the line, type the passphrase
node src/frl.mjs install         # always on there too
```

## 3 · Check it

```bash
node src/frl.mjs keys check
node src/frl.mjs status
```

`/api/status` lists every provider with `keys`, `keysResting` and the reason it rests (`coolingReason`).

## Optional: a separate gateway in front

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT) is one OpenAI-compatible endpoint in front of the free tiers of 34 providers, with a counter per key. The app talks to it as its `custom` provider. Use it only when you want those extra providers without adding them here. It is one more program to install and keep running on each computer, and it keeps its own copy of the keys (encrypted).

- **macOS:** the `.dmg` from its Releases page (menu-bar app, no Docker).
- **Windows:** the `.exe` installer.
- **Linux:** `docker compose`.

Then save four values: `CUSTOM_LLM_BASE_URL` (its address plus `/v1`, as its dashboard shows), `CUSTOM_LLM_MODEL` = `auto`, `CUSTOM_LLM_API_KEY` (its unified key), and `FRL_PROVIDER_ORDER`. `FRL_PROVIDER_ORDER` is the list of providers the app uses, so keep the direct ones after it:

```
custom,cerebras,groq,gemini,nvidia,mistral,sambanova,openrouter,pollinations
```

## Keep the loop running

1. `node src/frl.mjs install` makes the app always on, so it survives restarts.
2. Open the research. Choose **Improve loop ▾ → Entire research…** or **Selected pieces…**, set the hours (up to 72) and press **Start**.
3. After a restart the loop resumes with the hours that were left.
