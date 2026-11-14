# GemmaVault

Offline-first, self-sustaining coding workbench powered by locally installed **Google Gemma** open-weight models (`gemma4`, `gemma3`, `gemma2`, `codegemma`) with an encrypted **IndexedDB** local database for code snippets, project documentation, and chat history.

## Features

- **100% Offline & Local AI**: Connects exclusively to loopback inference servers (`127.0.0.1` / `localhost`) via Ollama or OpenAI-compatible runtimes (`llama.cpp`, LM Studio). No cloud API keys or paid subscriptions required.
- **Automatic Gemma Ranking**: Detects locally installed models and auto-selects the most capable one by blending generation and size (newest generation wins at equal size; Gemma 4 12B ≈ Gemma 3 27B class, so a large older model can still beat a tiny new one). Embedding/safety variants (`embeddinggemma`, `shieldgemma`) are never auto-selected, and future `gemma5+` tags rank automatically.
- **Encrypted Local Database**: Stores snippets, Markdown docs, projects, and chat sessions in IndexedDB with optional **AES-256-GCM** encryption (`PBKDF2-SHA256`, 600,000 iterations, strict v2 per-record AAD binding, auto-lock timeout, passphrase rotation, and `.gvbackup` portable backups).
- **Responsive Desktop & Mobile PWA**: Installable standalone Progressive Web App with bundled offline fonts (`Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono`), dual light/dark themes, and adaptive layouts for desktop monitors and mobile viewports.

## Run Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Start a Local Google Gemma Model
Using **Ollama**:
```bash
ollama pull gemma4:e4b      # also available: gemma4:e2b, gemma4:12b, gemma4:26b, gemma4:31b
ollama serve
```
Pick by RAM: `e2b` (low-RAM/phones), `e4b` (default, most laptops), `12b` (mid-tier), `26b` MoE (~20 GB+), `31b` dense (workstation). Tags change over time — confirm with `ollama list` / the Ollama library page.

Or using **llama.cpp / LM Studio**:
```bash
llama-server -m gemma-4-e4b-it-Q4_K_M.gguf --port 1234 --ctx-size 8192
```

### 3. Launch GemmaVault
```bash
npm run dev
```
For production:
```bash
npm run build
npm start
```

### 4. Verify & Test
```bash
npm run lint
npm test
```

## Network & Security Notes

- **Loopback by default.** Locally, the server binds to `127.0.0.1` and rejects requests whose `Host` header is not a loopback name (DNS-rebinding defense). To use GemmaVault from a phone on your Wi-Fi, opt in explicitly: `HOST=0.0.0.0 npm start`. The app has no login, so only do this on a trusted network; enable the vault passphrase first.
- **Containers.** When `K_SERVICE` or `APP_URL` is set (managed container hosts) the server binds `0.0.0.0` by default and the Host-header and setup-endpoint guards relax accordingly; set `HOST=127.0.0.1` to force loopback.
- **Installed PWA without the Node server.** The browser then talks to Ollama directly, which requires CORS: `OLLAMA_ORIGINS="http://localhost:3000" ollama serve`.
- **Encryption is opt-in.** Until you set a passphrase in *Vault DB*, data is stored unencrypted in IndexedDB. A lost passphrase cannot be recovered — keep a `.gvbackup`.
- **Multiple tabs.** Locking one tab locks all; changing encryption or importing a backup reloads the others.

## Automatic Gemma Setup (no Ollama installed yet)

Three ways, all of which install **only** Ollama and a Google Gemma model (a one-time download; afterwards the app is fully offline):

1. **Windows one-click:** double-click `setup-and-start.bat` (installs npm deps, sets up Gemma, builds, starts, opens the browser).
2. **CLI:** `npm run setup:gemma` — add `-- --model gemma4:e2b` to choose a model, `-- --check` to only report status.
3. **In the app:** open *Runtime settings* → **Auto-setup Gemma** (live progress; available when running via `npm start` / `npm run dev`).

What it does: finds Ollama (PATH and default install folders) → if missing on Windows, downloads the official `OllamaSetup.exe`, requires a valid digital signature naming Ollama, and installs it silently for the current user (no admin prompt) → adds Ollama's folder to the Windows User `PATH` and existing shell profiles (`.bashrc` / `.bash_profile` / `.zshrc` / `.profile`) if missing → starts the service → pulls the model unless already present. The model is picked from your RAM (`gemma4:e2b` under 7 GB, otherwise `gemma4:e4b`); larger models are never auto-selected.

Notes: macOS/Linux get exact manual install instructions instead of automation (they need sudo/Homebrew). Auto-setup is disabled when `HOST` exposes the server beyond loopback, and only Gemma-family tags are accepted. If a firewall blocks `ollama.com`, install Ollama manually, then run `ollama pull gemma4:e4b`.
