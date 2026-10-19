# LOCAL GPU: analysis and plan

How the "iPhone as a second GPU" idea applies to this app on a Windows PC. The step-by-step guide is [LOCAL-GPU.md](LOCAL-GPU.md).

## 1 · What the Reddit post does

The post on r/LocalLLaMA ("I made my iPhone a second GPU for my 24 GB …", October 2026) presents **Backburner** by StayLameBro (MIT license). Reddit blocks automated readers, so the facts below come from the project's coverage and repository links. Sources are listed at the end, read on 2026-10-19.

| Item | Backburner |
|---|---|
| Hardware | MacBook Pro M4 Pro, 24 GB, macOS 26.2, plus an iPhone 17 Pro Max (A19 Pro) or 16 Pro Max (A18 Pro) |
| Link | 10 Gb/s USB-C cable. Wi-Fi is off for security |
| Engine | a fork of llama.cpp with extra Metal and SME2 kernels |
| Model | Qwen3.8-27B, IQ4_XS |
| Split | **pipeline split**: the Mac runs layers 1–40 for each batch of 256 prompt tokens and streams the residual to the phone. The phone runs layers 41–64 while the Mac starts the next batch |
| Reading speed (prefill) | 16k context: 109 → 157 tok/s (+44%) · 32k: 101 → 130 (+29%) · 48k: 87 → 113 (+30%) |
| Writing speed (decode) | 25.0 → 25.1 tok/s: **no gain** |
| Extra context | the phone holds the oldest KV pages. 64k on the Mac alone becomes 196k–229k at 8-bit |
| Limits | the phone joins only reads longer than about 512 tokens; one request at a time; author-measured, not yet reproduced elsewhere; Mac and iPhone only |

**Why it works:** reading a long prompt is compute-bound and can be pipelined in large batches, so a second device adds throughput. Writing one token at a time is latency-bound: every token must cross the link, so a second device does not help. This matters for us because **research is reading-heavy**: every piece reads several fetched pages, and reviews, roll-ups and memos read whole sub-trees.

## 2 · What transfers to a Windows PC

| Part of the idea | On Windows | How |
|---|---|---|
| Run the model on your own GPU | **yes** | official llama.cpp builds for Windows (Vulkan for NVIDIA, AMD and Intel; CUDA for NVIDIA). They include `llama-server.exe`, an OpenAI-compatible server |
| Split the model across a second device (pipeline split) | **yes** | llama.cpp's RPC backend: `ggml-rpc-server` on the helper, `--rpc host:port` on the main PC. Layers are spread across devices in proportion to their free memory; `--tensor-split` overrides that |
| Helper devices | another Windows/Linux PC, a Mac (Metal), an Android phone (the official `android-arm64` build includes `ggml-rpc-server`) | network: Ethernet or Wi-Fi |
| The iPhone as the helper | **no** | Backburner needs a macOS host, Metal and its own iOS app. Stock llama.cpp has no iOS RPC helper. With a Mac in the house you can run Backburner there and point this app at that Mac |
| Backburner's kernel speed-ups (SME2, Metal 4 tensor ops) | no | Apple-only hardware features |

Checked on 2026-10-19: release `b11738` ships `llama-b11738-bin-win-vulkan-x64.zip` (30 MB) and `llama-b11738-bin-win-cuda-12.4-x64.zip` (255 MB) plus `cudart-llama-bin-win-cuda-12.4-x64.zip`, each with a published sha256. The Windows zip contains `llama-server.exe` and `ggml-rpc-server.exe`.

**Security:** llama.cpp's own README says of the RPC backend: "the functionality is fragile and insecure. Never run the RPC server on an open network or in a sensitive environment!" The helper has no password. This app refuses to start a helper on anything but a private LAN or Tailscale address.

## 3 · Why this improves our research model

From the last 24 h of this app's own call log (Models & router page, 2026-10-19):

- 3,760 model calls, 66% worked, **159 rate-limited**. OpenRouter used 457 of its 50 free daily requests; Cerebras used 830K of 1M daily tokens.
- Pollinations carried 39% of all calls at **26–28 s** each because the faster free providers ran out.

A local model removes that ceiling: **no daily quota, no 429, no waiting**. Prefill is the cheap part on a local GPU, and our calls are mostly prefill: long evidence in, short JSON out. The free cloud models stay first for deep work (trees, memos), where capability matters most. The local model takes over volume when they cool down.

## 4 · Plan

| Phase | What | Done when |
|---|---|---|
| 1 · Local server | Install the official llama.cpp build on the Windows PC; run one model that fits the GPU on `127.0.0.1:8090` | `node src/frl.mjs local bench` prints prefill and decode speeds; **Models & router** shows **llama.cpp on this PC** as *Works* |
| 2 · Router integration | The app treats it as the `llamacpp` provider. Capability is rated by model size (32B → 4/5, 20B → 3/5, 4B → 2/5, under 1B → kept last). The router places it by measured reliability and speed | it appears in both role lists with its reason; research keeps running when every cloud quota is spent |
| 3 · Helper devices (optional) | A second PC, Mac or Android phone runs `local helper`; the main PC starts with `--helpers ip:port` to fit a bigger model | `llama-server --list-devices` shows `RPC0`; the bigger model loads |
| 4 · Measure | Compare one research run with and without the local model: rate-limited count, run time, pieces passing | numbers in **Gates & logs** and **Models & router** |

## 5 · What was built

| Part | File |
|---|---|
| Installer: picks the right official build (Vulkan/CUDA/CPU on Windows, Metal on macOS), downloads it, checks sha256, unpacks, records the binaries | `src/local/llamacpp.mjs` (`LlamaCppInstaller`) |
| Server and helper commands, model table by GPU memory, helper address guard, speed parser | `src/local/llamacpp.mjs` |
| `node src/frl.mjs local install / models / start / helper / status / bench` | `src/frl.mjs` |
| Router provider `llamacpp` (keyless, `LLAMACPP_BASE_URL`, default `http://127.0.0.1:8090/v1`) | `src/llm/presets.mjs` |
| Size-based capability; tiny models kept last | `src/llm/ranking.mjs` |
| Terminal buttons: Install llama.cpp, Which model fits, Local model status, Local speed test | `src/terminal/catalog.mjs` |
| Tests | `tests/local/llamacpp.test.ts`, `tests/llm/ranking.test.ts` |

**Verified on this Mac (2026-10-19):** `local install` downloaded b11739 (Metal) and its sha256 matched. `local helper --host 127.0.0.1` and `local start --model ggml-org/gemma-3-270m-it-GGUF --helpers 127.0.0.1:50052` ran together, and `--list-devices` showed `RPC0: 127.0.0.1:50053`. `local bench` measured 518.5 tok/s prefill and 82.2 tok/s decode. After a restart the router listed `llamacpp` as ready and kept the tiny model last.

**Not verified:** a real Windows PC, CUDA, an Android helper, and a helper over Wi-Fi. They use the same commands, but nobody has run them yet.

## Sources

- Backburner coverage: https://traictory.com/news/2026-10-04-iphone-second-gpu-backburner
- Backburner repository: https://github.com/StayLameBro/backburner
- llama.cpp RPC: https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md
- llama.cpp releases: https://github.com/ggml-org/llama.cpp/releases
