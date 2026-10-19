# LOCAL GPU: run a model on your Windows PC for the research app

Ready-to-run steps. You get a local model with no quota and no rate limits, which the router uses next to the free cloud models. Background and measurements: [LOCAL-GPU-PLAN.md](LOCAL-GPU-PLAN.md).

**Before you start:** the app runs on this PC ([WINDOWS.md](WINDOWS.md)), and your graphics driver is up to date (NVIDIA, AMD or Intel). Run every command in **PowerShell** inside the app folder, or press the buttons in the app's **Terminal** (group **Local GPU**).

## 1 · Find out how much GPU memory you have

NVIDIA:

```powershell
nvidia-smi --query-gpu=name,memory.total --format=csv
```

AMD or Intel: press Win+R, type `dxdiag`, and on the **Display** tab read **Display Memory (VRAM)**.

## 2 · Install llama.cpp

```powershell
node src/frl.mjs local install
```

This downloads the official Vulkan build (works on NVIDIA, AMD and Intel GPUs) from github.com/ggml-org/llama.cpp, checks its sha256, and unpacks it into `data\llama\`. For an NVIDIA card you can use CUDA instead (a larger download, often faster):

```powershell
node src/frl.mjs local install cuda
```

No GPU, or it fails to start: `node src/frl.mjs local install cpu`.

## 3 · Pick the model that fits

```powershell
node src/frl.mjs local models --vram 16
```

Replace `16` with your GB from step 1. The table, checked on 2026-10-19:

| GPU memory | Model | File |
|---|---|---|
| 4 GB+ | `ggml-org/Qwen3-4B-GGUF:Q4_K_M` | 2.3 GB |
| 11 GB+ | `ggml-org/Qwen3-14B-GGUF:Q4_K_M` | 8.4 GB |
| 14 GB+ | `ggml-org/gpt-oss-20b-GGUF` | 11.3 GB |
| 19 GB+ | `ggml-org/gemma-3-27b-it-GGUF:Q4_K_M` | 15.4 GB |
| 22 GB+ | `ggml-org/Qwen3-32B-GGUF:Q4_K_M` | 18.4 GB |

## 4 · Start it

Open a second PowerShell window (or a **+ New session** in the app's Terminal) and run, with your model from step 3:

```powershell
node src/frl.mjs local start --model ggml-org/gpt-oss-20b-GGUF
```

The first start downloads the model file once. Leave the window open: the model runs while it is open. The server listens on `127.0.0.1:8090`, this PC only. The command saves that address in the key store and tells the running app to reload.

## 5 · Check it

In the first window:

```powershell
node src/frl.mjs local bench
```

It prints, for example, `prefill (reading): … tokens/s · decode (writing): … tokens/s`. In the app, open **Models & router** (the **+** next to the models indicator): **llama.cpp on this PC** shows **Works**, with its place in the Deep and Fast lists and the reason for it. If it does not appear, restart the app once:

```powershell
node src/frl.mjs restart
```

## 6 · Optional: add a second device for a bigger model

This is the idea from the Reddit post: a second device lends its GPU memory, and the model's layers are split across both. Any of these can be the helper: another Windows PC, a Linux PC, a Mac, or an Android phone. **An iPhone cannot help a Windows PC:** that needs Backburner, which runs only on a Mac.

Use a cable or good Wi-Fi: every token crosses the network. The helper has **no password**, so keep it on your home network or Tailscale and never forward its port.

**On the helper device** (a second PC or Mac with this app installed):

```powershell
node src/frl.mjs local install
node src/frl.mjs local helper --host 192.168.1.20
```

Replace `192.168.1.20` with that device's own LAN address (`ipconfig` on Windows, `ipconfig getifaddr en0` on a Mac). On a Windows helper, allow the port once in an **administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "llama.cpp helper" -Direction Inbound -Protocol TCP -LocalPort 50052 -RemoteAddress LocalSubnet -Action Allow
```

**Android helper** (not yet tested on a real phone): install Termux. Download `llama-<version>-bin-android-arm64.tar.gz` from https://github.com/ggml-org/llama.cpp/releases, unpack it, and run `LD_LIBRARY_PATH=. ./ggml-rpc-server -H <phone LAN IP> -p 50052` in that folder.

**On the main PC**, stop the server (Ctrl+C), then start it with the helper and a model that fits both devices together:

```powershell
node src/frl.mjs local start --model ggml-org/Qwen3-32B-GGUF:Q4_K_M --helpers 192.168.1.20:50052
```

Several helpers: `--helpers 192.168.1.20:50052,192.168.1.21:50052`. llama.cpp splits the layers by each device's free memory. To set the split yourself (for example 3 parts here, 1 part on the helper): `--split 3,1`.

## 7 · Choose how the router uses it

**Models & router → Routing strategy:**

- **Balanced** (recommended): the cloud models stay first while they work. The local model moves up when they rate-limit or slow down. Its capability rating comes from its size: 32B is 4/5, 20B is 3/5, 4B is 2/5.
- **Fastest:** the local model usually comes first, because it never waits for a quota.
- **Custom:** put **llama.cpp on this PC** first, so every call is local and nothing is sent to cloud providers.

Untick **use** on the card to stop using it without stopping the server.

## 8 · Keep it running

The model runs while its window is open. To start it with Windows, create a shortcut in `shell:startup` whose target is:

```
powershell -NoExit -Command "cd '<app folder>'; node src/frl.mjs local start --model ggml-org/gpt-oss-20b-GGUF"
```

## Troubleshooting

| You see | Do |
|---|---|
| `llama.cpp is not installed yet` | step 2 |
| `server on port 8090: not running` | the window from step 4 is closed or still loading; wait for `listening on` |
| the model loads very slowly or crashes | it does not fit: pick the next smaller one in step 3 |
| Vulkan errors | update the GPU driver, or `local install cuda` (NVIDIA) or `local install cpu` |
| helper refused | `--host` must be a private address (192.168.x.x, 10.x.x.x, 172.16–31.x.x, or a Tailscale 100.x address) |
| the main PC cannot reach the helper | firewall rule above; both devices on the same network; `Test-NetConnection 192.168.1.20 -Port 50052` |
