# GemmaVault

Offline-first, self-sustaining coding workbench powered by locally installed **Google Gemma** open-weight models (`gemma4`, `gemma3`, `gemma2`, `codegemma`) with an encrypted **IndexedDB** local database for code snippets, project documentation, and chat history.

## Features

- **100% Offline & Local AI**: Connects exclusively to loopback inference servers (`127.0.0.1` / `localhost`) via Ollama or OpenAI-compatible runtimes (`llama.cpp`, LM Studio). No cloud API keys or paid subscriptions required.
- **Automatic Gemma Ranking**: Detects locally installed models and auto-selects the most capable one by blending generation and size (newest generation wins at equal size; Gemma 4 12B ≈ Gemma 3 27B class, so a large older model can still beat a tiny new one). Embedding/safety variants (`embeddinggemma`, `shieldgemma`) are never auto-selected, and future `gemma5+` tags rank automatically.
- **Encrypted Local Database**: Stores snippets, Markdown docs, projects, and chat sessions in IndexedDB with optional **AES-256-GCM** encryption (`PBKDF2-SHA256`, 600,000 iterations, strict v2 per-record AAD binding, auto-lock timeout, passphrase rotation, and `.gvbackup` portable backups).
- **Live Local-LLM Status Bar**: A bar under the header on every tab says whether the local LLM is up, starting, installing, or down, with the model name and Ollama version, so a loaded web page is never mistaken for a working AI. See [Is the local LLM up?](#is-the-local-llm-up).
- **Responsive Desktop & Mobile PWA**: Installable standalone Progressive Web App with bundled offline fonts (`Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono`), dual light/dark themes, and adaptive layouts for desktop monitors and mobile viewports.

## Quick start

Pick the row that matches your situation. Every command below is safe to re-run: nothing that is already installed is downloaded again (details in [What `setup:gemma` does](#what-setupgemma-does-and-does-not-download)).

| Situation | What to run |
| --- | --- |
| **First time, Windows** | Double-click `setup-and-start.bat`. It installs npm packages, sets up Ollama + a Gemma model, builds, starts the server and opens the browser. |
| **First time, macOS / Linux** | Install Ollama yourself (the setup script prints the exact command), then:<br>`npm install` → `npm run setup:gemma` → `npm run build` → `npm start` |
| **Every later run** | `npm start` (then open <http://localhost:3000>). Ollama and the model are already installed, so no setup and no build are needed unless the code changed. |
| **Developing the app** | `npm run dev` (hot reload) instead of build + start. |
| **Just check, change nothing** | `npm run setup:gemma -- --check` |

Node 20+ is required. Setup downloads Ollama and the model once; after that the app runs fully offline.

## Is the local LLM up?

The web page loading only proves the *web server* is up. Two places tell you about the *LLM*:

**Terminal** — one line when the server starts:

| Line | Meaning | What to do |
| --- | --- | --- |
| `Local LLM: UP - Ollama is running with: gemma4:e4b. Nothing to download or start.` | Ready. | Nothing. |
| `Local LLM: UP, but no Gemma model installed.` | Ollama runs, no Gemma model. | `npm run setup:gemma` |
| `Local LLM: DOWN - Ollama is installed but not running.` | Installed, stopped. | Start the Ollama app, or `npm run setup:gemma`. |
| `Local LLM: DOWN - Ollama is not installed.` | Not installed. | `npm run setup:gemma` (Windows), or install Ollama first (macOS/Linux). |

**Status bar** — shown under the header on every tab and updated by itself (no reload):

| Status | Colour / icon | Meaning |
| --- | --- | --- |
| Checking local LLM… | grey, spinner | First check in progress. |
| **Local LLM ready** | green, tick | Shows the model that will answer and the Ollama version, e.g. `gemma4:e4b · Ollama v0.12.3 · 1 model`. |
| Ollama is running — no Gemma model | amber, warning | Runtime is up but chat will fail; install a model. |
| Starting local LLM… / Installing Ollama… / Downloading Gemma model… NN% | blue, spinner | Auto-setup is working; chat is unavailable until it finishes. |
| Local LLM is down | red, cross | The web app is running, but nothing answers at the configured URL (or Ollama is installed but stopped). |
| Local LLM not installed | red, cross | The web app is running, but Ollama is not installed. |

The bar re-checks every 15 s while healthy, every 5 s while down, and every 1.5 s during setup. It pauses in background tabs and re-checks the moment the tab is visible again or the network returns. Use the refresh button for an instant check and **Fix / set up** (or **Runtime**) to open Runtime settings. The check works through the local server, so it needs `npm start` / `npm run dev`; in a standalone PWA it falls back to a direct connection and cannot tell "not installed" from "stopped".

## What `setup:gemma` does (and does not) download

`npm run setup:gemma` (also run by `setup-and-start.bat`, and by **Runtime settings → Auto-setup Gemma** in the app) checks before it acts, in this order:

1. **Ollama present or running?** If yes, the installer is **not** downloaded. The installer is fetched only on Windows, and only when Ollama is neither found nor responding. It is the official `OllamaSetup.exe`, must carry a valid digital signature issued to Ollama (`CN=Ollama` / `O=Ollama`), and installs silently for the current user (no admin prompt). macOS/Linux get exact manual instructions instead (they need sudo/Homebrew).
2. **Service running?** If not, it is started. Ollama's folder is added to the Windows User `PATH` and existing shell profiles (`.bashrc`, `.bash_profile`, `.zshrc`, `.profile`) if missing.
3. **Model already installed?** If the exact tag is present it prints `<model> is already installed.` and downloads nothing. Only otherwise does it pull the model (the large download).

It first prints a status line (for example `Ollama installed (on PATH) · service running · models: gemma4:e4b`), which is your confirmation of what it found.

**Which model.** It targets one picked from your RAM: `gemma4:e2b` under 7 GB, otherwise `gemma4:e4b`. Larger models are never auto-selected. Choose explicitly with `npm run setup:gemma -- --model gemma4:26b`. Only Gemma-family tags are accepted.

**Two cases where a download can still happen**

- You only have a *different* model (say `gemma4:26b`), so the recommended `e4b` is missing and gets pulled as well. Run with `--model <the tag you have>`, or skip setup and just `npm start`: the app auto-selects the best installed Gemma. List what you have with `ollama list`.
- You installed it under another tag (bare `ollama pull gemma4` makes `gemma4:latest`). Tags are compared exactly, so `e4b` looks missing. Ollama stores model files by content, so re-pulling the same model should reuse them and finish quickly, but if a large progress bar appears, press Ctrl+C.

If a firewall blocks `ollama.com`, install Ollama manually and run `ollama pull gemma4:e4b`. Auto-setup is disabled when `HOST` exposes the server beyond loopback.

### Commands you do not need to run

| Command | Skip it when | Why |
| --- | --- | --- |
| `ollama serve` | The Ollama app/service is already running (the status bar is green or the terminal says `UP`). | The Windows/macOS app and the Linux service start it automatically; a second one fails with "address already in use". Setup starts it for you if needed. |
| `ollama pull <model>` | Setup has run, or `ollama list` shows the model. | Setup already pulls it. |
| `npm run setup:gemma` | Every launch. | Harmless but pointless once installed; `npm start` is enough. |
| `npm run build` | The code has not changed since the last build. | `npm start` serves the existing `dist/`. |

## Choosing a model

Pick by RAM (sizes are approximate; tags change, so confirm with `ollama list` or the Ollama library page):

| Tag | Suited to |
| --- | --- |
| `gemma4:e2b` | Low-RAM machines (auto-picked under 7 GB). |
| `gemma4:e4b` | Default for most laptops. |
| `gemma4:12b` | Mid-tier. |
| `gemma4:26b` | MoE, about 20 GB+ RAM. |
| `gemma4:31b` | Dense, workstation class. |

Prefer **llama.cpp / LM Studio**? Start an OpenAI-compatible server (`llama-server -m gemma-4-e4b-it-Q4_K_M.gguf --port 1234 --ctx-size 8192`) and choose *OpenAI-compatible* in Runtime settings. The status bar then shows the model but no Ollama version, and setup and `--check` do not apply.

## Verify & test

```bash
npm run lint
npm test
```

## Network & Security Notes

- **Loopback by default.** Locally, the server binds to `127.0.0.1` and rejects requests whose `Host` header is not a loopback name (DNS-rebinding defense). To use GemmaVault from a phone on your Wi-Fi, opt in explicitly: `HOST=0.0.0.0 npm start`. The app has no login, so only do this on a trusted network; enable the vault passphrase first.
- **Containers.** When `K_SERVICE` or `APP_URL` is set (managed container hosts) the server binds `0.0.0.0` by default and the Host-header and setup-endpoint guards relax accordingly; set `HOST=127.0.0.1` to force loopback. In this mode it also omits `X-Frame-Options: DENY` and the CSP `frame-ancestors` directive so preview iframes can embed the app; local runs enforce both. Don't leave `APP_URL` set if framing should stay blocked.
- **Installed PWA without the Node server.** The browser then talks to Ollama directly, which requires CORS. This is the one case where you start Ollama yourself: quit any running Ollama first, then run `OLLAMA_ORIGINS="http://localhost:3000" ollama serve`. (With `npm start` / `npm run dev` the built-in proxy handles CORS and this is not needed.)
- **Encryption is opt-in.** Until you set a passphrase in *Vault DB*, data is stored unencrypted in IndexedDB. A lost passphrase cannot be recovered — keep a `.gvbackup`.
- **Multiple tabs.** Locking one tab locks all; changing encryption or importing a backup reloads the others.
