# WINDOWS — run Free Research LLM on a Windows PC

There are two ways. Pick one.

| Way | Use it when | What runs on the PC |
|---|---|---|
| **A. Open the Mac's app from the PC** | The Mac is on, and both are on the same Wi-Fi (or both have Tailscale) | Only a browser. Research, keys and the terminal stay on the Mac |
| **B. Install the app on the PC** | The PC must work on its own, also when the Mac is off | The whole app, with its own keys |

Tested target: Windows 10 (version 1809 or newer) or Windows 11, 64-bit. Every command below is typed in **PowerShell**: press **Start**, type `PowerShell`, press **Enter**.

## A. Open the Mac's app from the PC (no install)

1. On the Mac, open the app: **http://127.0.0.1:4600**.
2. Click **Terminal** in the sidebar, then the **Install always-on** button. It runs:

   ```bash
   node src/frl.mjs install
   ```

   The app now starts at login, restarts if it stops, and accepts other devices that bring the access token.
3. Click the **Links for other devices** button. It runs:

   ```bash
   node src/frl.mjs url
   ```

4. Copy the line **same Wi-Fi (phone, other PC)**. It looks like `http://192.168.x.x:4600/?token=…`. Send it to the PC privately (for example in a note to yourself, never in a public chat).
5. On the PC, open the link in Edge or Chrome. The browser remembers the token, so next time `http://192.168.x.x:4600` is enough.
6. Everything works from the PC, the Terminal too: it is the Mac's shell, shared live between both screens.

Away from home: install Tailscale on the Mac and the PC from https://tailscale.com/download, sign in to the same account on both, run **Links for other devices** again, and use the line **anywhere, via Tailscale**.

## B. Install the app on the PC

### 1. Install Node.js and Git

```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
```

If `winget` is missing, install Node.js LTS from https://nodejs.org/en/download and Git from https://git-scm.com/download/win with the default options.

**Close PowerShell and open it again**, then check both:

```powershell
node -v
git --version
```

`node -v` must print `v20` or higher.

### 2. Download the app

```powershell
cd $HOME
git clone https://github.com/bezgolovyponch/free-research-llm.git
cd free-research-llm
npm.cmd install
```

Use `npm.cmd`, not `npm`: a fresh Windows blocks `npm` in PowerShell with "running scripts is disabled on this system". `npm.cmd` is the same program without that block.

The app folder is now `C:\Users\<your name>\free-research-llm`.

### 3. Add the keys

Pick one.

**Copy them from the Mac (fastest).** On the Mac, in the app's Terminal, click **Export keys**:

```bash
node src/frl.mjs keys export
```

Choose a passphrase (10+ characters) and copy the long line that starts with `frl1.`. On the PC:

```powershell
node src/frl.mjs keys import
```

Paste the line, type the passphrase. Send the line and the passphrase to the PC separately.

**Or paste them one by one** (links to every free key are in [KEYS.md](KEYS.md)):

```powershell
node src/frl.mjs keys setup
```

On Windows the keys are saved as your user environment variables (`HKCU\Environment`), never in a file. **Close PowerShell and open it again** after saving keys, so new windows see them. Check them:

```powershell
node src/frl.mjs keys list
```

### 4. Start the app

Double-click **`start.cmd`** in the app folder (File Explorer → `C:\Users\<your name>\free-research-llm`). Or in PowerShell:

```powershell
node src/frl.mjs start
```

Open **http://127.0.0.1:4600**. The **Terminal** button opens PowerShell inside the app.

### 5. Keep it always on (optional)

```powershell
node src/frl.mjs install
```

This adds the Windows logon task **FreeResearchLLM**: the app starts hidden when you log in and restarts within 5 seconds if it stops. When Windows Firewall asks about Node.js, allow **Private networks** only. Then:

```powershell
node src/frl.mjs status
node src/frl.mjs url
```

`node src/frl.mjs url` prints the links for your phone and other computers. Remove the task with:

```powershell
node src/frl.mjs uninstall
```

### 6. Update later

```powershell
node src/frl.mjs update
node src/frl.mjs restart
```

`restart` works when the always-on task is installed. Without it, close the app window and start it again.

## Troubleshooting

| You see | Do this |
|---|---|
| `node` is not recognized | Close and reopen PowerShell after installing Node.js. Still missing: reinstall from https://nodejs.org/en/download |
| `running scripts is disabled on this system` | Type `npm.cmd` instead of `npm` |
| Setup shows "○ no key" after adding keys | Open a new PowerShell window, then `node src/frl.mjs restart` (or start the app again) |
| The phone or Mac cannot open the PC's link | Run `node src/frl.mjs install` (it turns remote access on), allow Node.js on Private networks in Windows Firewall, and make sure the Wi-Fi is set to **Private** in Windows settings |
| Terminal says "basic shell (node-pty missing)" | Run `npm.cmd install` again in the app folder. Basic mode still runs commands, but full-screen programs need the real shell |
| `git pull` fails during update | You changed files in the folder. Run `git status` to see them, then `git stash` and update again |
