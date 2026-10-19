# CLOUD — keep the app running 24/7 on a free cloud server

The app runs on a small free Linux server, and you open it from any device (Mac, Windows PC, phone) with one HTTPS link. The research loop keeps running when your computers are off.

**What you get:** an always-on app at `https://<server>.<your-tailnet>.ts.net`, a shell on the server in the app's Terminal, and your keys stored encrypted on the server.

**What it costs:** €0, if you stay inside the free limits below. Both providers ask for a payment card to verify your identity.

## Which free server (checked 2026-10-19)

| Provider | Free server | Public IPv4 | Catch |
|---|---|---|---|
| **Oracle Cloud Always Free** (recommended) | `VM.Standard.E2.1.Micro`: 1/8 OCPU, 1 GB RAM, up to two of them. Or Ampere `VM.Standard.A1.Flex`: 2 OCPU and 12 GB RAM in total. 200 GB block storage | Included | Oracle may reclaim an **idle** instance: one whose 95th-percentile CPU use, network use and (A1 only) memory use all stay under 20% for 7 days. A1 capacity is often "out of host capacity" in busy regions |
| Google Cloud Free Tier | One `e2-micro` in `us-west1`, `us-central1` or `us-east1`, 30 GB standard disk, 1 GB outbound traffic a month | **Not in the free list**: an external IPv4 is billed at about $0.005/hour (≈ $3.60/month), and the server needs one to reach the free model APIs | Not fully free. Use it only if Oracle refuses your sign-up |

Sources: [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features), [Google external IP pricing](https://cloud.google.com/vpc/pricing-announce-external-ips), [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (free on every plan).

Free hosts that stop when idle (Render, Hugging Face Spaces, GitHub Codespaces) do not fit: the loop needs a server that keeps running and keeps its files.

## How it is wired

```
your phone / PC / Mac ──HTTPS──► Tailscale Funnel ──► server: 127.0.0.1:4600 (the app)
                                 (no open ports)        keys: /etc/credstore.encrypted (systemd-creds)
```

No port is opened on the server. The app listens only on `127.0.0.1`. Tailscale Funnel gives it a public HTTPS address, and the app asks every visitor for the access token: it treats Funnel traffic as coming from the internet, never as "this computer" (`FRL_BEHIND_PROXY=1`).

## 1. Create the server (Oracle Cloud, about 10 minutes)

1. Sign up at https://signup.cloud.oracle.com. Pick a **home region** near you, for example **Germany Central (Frankfurt)**. It cannot be changed later.
2. In the console menu: **Compute → Instances → Create instance**.
3. **Name:** `frl`.
4. **Image and shape → Edit:**
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Change shape → Specialty and previous generation → VM.Standard.E2.1.Micro** (marked "Always Free-eligible"). If you prefer more power, choose **Ampere → VM.Standard.A1.Flex** with 1 OCPU and 6 GB.
5. **Networking:** keep "Create new virtual cloud network" and "Create new public subnet". Keep **Automatically assign public IPv4 address** on.
6. **Add SSH keys:** choose **Generate a key pair for me**, click **Save private key**. The file lands in your Downloads folder as `ssh-key-<date>.key`.
7. **Create.** Wait until the state is **Running**, then copy the **Public IP address**.

## 2. Log in to the server

On the Mac (in the app's Terminal or the macOS Terminal):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-<date>.key ubuntu@<public-ip>
```

On Windows (PowerShell has `ssh` built in):

```powershell
ssh -i $HOME\Downloads\ssh-key-<date>.key ubuntu@<public-ip>
```

Answer `yes` to the fingerprint question. Every command from here on runs **on the server**.

## 3. Install Node.js, Git and the app

The 1 GB server needs swap space for the install:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Node.js LTS, Git and the build tools for the real terminal:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3
node -v
```

`node -v` must print `v20` or higher. Then the app:

```bash
git clone https://github.com/bezgolovyponch/free-research-llm.git
cd free-research-llm
npm install --omit=dev
```

`--omit=dev` skips the test browsers, which the server does not need.

## 4. Move your keys to the server (encrypted)

On the Mac, in the app's Terminal, click **Export keys**:

```bash
node src/frl.mjs keys export
```

Choose a passphrase, copy the line that starts with `frl1.`. On the server:

```bash
node src/frl.mjs keys import
```

Paste the line and type the passphrase. On a server without a desktop, the keys are encrypted with `systemd-creds` into `/etc/credstore.encrypted/` and given to the app only while it runs. They are never written in plain text.

Check them:

```bash
node src/frl.mjs keys list
```

## 5. Run the app as a service

```bash
node src/frl.mjs install
```

This creates the access token, writes the systemd service `free-research-llm.service` (starts at boot, restarts within 5 seconds if it stops) and starts it. Check:

```bash
node src/frl.mjs status
```

After you import new keys later, run `node src/frl.mjs install` again, so the service loads them.

## 6. Publish it with one HTTPS link

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the login link it prints, sign in (Google, Microsoft, GitHub or Apple account). Then:

```bash
sudo tailscale funnel --bg 4600
tailscale funnel status
```

The first time, Tailscale prints a link to allow Funnel for your tailnet: open it, allow, and run the `funnel` command again. `--bg` keeps Funnel on after reboots. Now print your link:

```bash
node src/frl.mjs url
```

Use the line **anywhere, any device (HTTPS)**: `https://frl.<your-tailnet>.ts.net/?token=…`. Open it once on each device. Each browser then remembers the token. Keep the link private: it opens the app and its terminal on the server.

## 7. Day to day

| Task | In the app's Terminal on the server |
|---|---|
| Is it running? | `node src/frl.mjs status` |
| Update to the newest version | `node src/frl.mjs update`, then `node src/frl.mjs restart` |
| Add or change keys | `node src/frl.mjs keys import` or `node src/frl.mjs keys setup`, then `node src/frl.mjs install` |
| Log | `node src/frl.mjs logs` |
| New access token (old links stop working) | `node src/frl.mjs token --rotate`, then `node src/frl.mjs install` |
| Stop publishing | `sudo tailscale funnel reset` |

Your researches live in `~/free-research-llm/data/` on the server. Oracle includes five free boot-volume backups: **Storage → Block Storage → Boot Volume Backups**.

## Staying inside the free limits

- **Idle reclamation (Oracle):** a server that only waits is "idle" by Oracle's rule. Keep the improve loop running (History → **Improve all researches**), or upgrade the account to Pay As You Go (**Billing → Upgrade**). Upgrading keeps Always Free resources at €0. Oracle's page does not say whether upgraded accounts are exempt from reclamation, so set a budget alert either way: **Billing → Budgets → Create budget**, €1.
- **One server:** stay on one `E2.1.Micro` (or A1 within 2 OCPU / 12 GB). Do not add paid block volumes or load balancers.
- **The free model and search quotas are per key**, not per server. The server uses the same quotas as your Mac.
