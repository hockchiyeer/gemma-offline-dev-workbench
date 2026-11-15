# GemmaVault

Offline-first, self-sustaining coding workbench powered by locally installed **Google Gemma** open-weight models (`gemma4`, `gemma3`, `gemma2`, `codegemma`) with an encrypted **IndexedDB** local database for code snippets, project documentation, and chat history.

## Features

- **100% Offline & Local AI**: Connects exclusively to loopback inference servers (`127.0.0.1` / `localhost`) via Ollama or OpenAI-compatible runtimes (`llama.cpp`, LM Studio). No cloud API keys or paid subscriptions required.
- **Automatic Gemma Ranking**: Detects locally installed models and auto-selects the most capable one by blending generation and size (newest generation wins at equal size; Gemma 4 12B ≈ Gemma 3 27B class, so a large older model can still beat a tiny new one). Embedding/safety variants (`embeddinggemma`, `shieldgemma`) are never auto-selected, and future `gemma5+` tags rank automatically.
- **Encrypted Local Database**: Stores snippets, Markdown docs, projects, and chat sessions in IndexedDB with optional **AES-256-GCM** encryption (`PBKDF2-SHA256`, 600,000 iterations, strict v2 per-record AAD binding, auto-lock timeout, passphrase rotation, and `.gvbackup` portable backups).
- **Live Local-LLM Status Bar**: A bar under the header on every tab says whether the local LLM is up, starting, installing, or down, with the model name and Ollama version, so a loaded web page is never mistaken for a working AI. On phone screens, details collapse behind a tap toggle to preserve editor height. See [Is the local LLM up?](#is-the-local-llm-up).
- **Versioned Snippet Lineage & AI Actions**: One-tap **Explain**, **Debug**, **Refactor**, **Expand** and **Unit Tests** on any snippet. Code the model returns is saved beneath the source snippet as traceable child versions (`v2`, `v3`, …) with the action, model, time and prompt recorded. See [Snippet lineage & AI actions](#snippet-lineage--ai-actions).
- **Reasoning You Can See and Control**: Gemma 4 "thinks" before it answers. The chat shows live progress (loading, reasoning, generating, with elapsed seconds) and a collapsible **Show reasoning** trace that is saved with each reply. **Runtime settings → Reasoning (Ollama)** can switch thinking off for much faster answers on CPU-only PCs. See [Slow or stuck answers](#slow-or-stuck-answers).
- **Responsive Desktop & Mobile PWA**: Installable standalone Progressive Web App with bundled offline fonts (`Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono`), dual light/dark themes, and phone-friendly editor headers with collapsible `Tools & AI` drawers so the code and Markdown editors stay usable on small screens.

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

## Snippet lineage & AI actions

Open a snippet and use **Tools & AI** (on phones) or the toolbar (on larger screens). Each action sends the snippet to Gemma AI with a ready-made prompt, then files what comes back:

| Action | Asks Gemma to | Reply saved as child snippet? |
| --- | --- | --- |
| **Explain** | Walk through the code step by step and note edge cases. | **No.** Explanations quote small fragments, not a new version. Save any fragment yourself with the code block's **Save Snippet** button. |
| **Debug** | Audit for bugs, race conditions and security flaws, and return a fixed version. | Yes |
| **Refactor** | Improve clarity, modularity and idiomatic style. | Yes |
| **Expand** | Implement stubs, TODOs and comment specs into working code. | Yes |
| **Unit Tests** | Write tests for normal and boundary cases. | Yes |
| Any other prompt with a snippet attached (paperclip) | Whatever you ask. | Yes, labelled **AI Variant** |

**How children are saved**

- Every complete fenced code block in the reply becomes one child (`v2 Refactor (1/2) · <parent title>`), nested under its parent in the list. A code block that never closes, because the reply hit the token limit or you pressed Stop, is ignored, so half-written code is never saved as a version.
- A child records the action, model, capture time and prompt in **Engineering Notes**, inherits the parent's tags plus an action tag, and shows **Parent** and **Derived** links so you can jump between versions. Developer prompts link straight to the source snippet they reference, and chat replies link straight to the snippets they created.
- Deleting a snippet keeps its children: they move up to the deleted snippet's parent.
- Children are ordinary snippets: they are searchable, editable, covered by vault encryption and included in `.gvbackup` files.

## Context handling & speed

Local runtimes (Ollama, llama.cpp) keep a cache of the prompt they last read and only process what changed.
GemmaVault builds prompts to take advantage of that:

- **Stable prefix.** The system prompt stays constant; attached snippets/docs go on the *latest* user message, and
  every earlier turn is replayed exactly as it was sent (stored per message). Follow-up questions therefore reuse
  the runtime's cache instead of re-reading the whole chat.
- **Context meter** above the composer: estimated prompt size vs. what fits after reserving room for the reply, the
  last reply's speed (tokens/s, as measured by the runtime), and warnings when older turns or attachments don't fit.
- **Token budgeting.** Estimates separate prose, code and CJK text and are calibrated per model from the runtime's
  own token counts. History and attachments each keep a guaranteed share; whole turns and whole attachments are
  dropped (never cut mid-code-block), and an attachment cut short is closed cleanly and listed in the prompt.
- **Condense long chats.** When history outgrows its share, the oldest turns are folded into a short summary note
  by the same local model (Settings: *Condense long chats*; or use *Condense chat* any time). The note is visible
  and editable under *Summary*. If a turn doesn't fit in full, it is replayed with a short `[attached: …]` marker
  instead of being dropped.
- **Keep model loaded** (Settings, Ollama): how long the model stays in memory after a reply (default 30 minutes).

Notes: a larger **Context Window** gives all of the above more room (the default 8192 leaves roughly 2k tokens for
the prompt once the reply and reasoning reserve are subtracted). Because earlier attachments are now remembered
across turns, chats store the attached text with each message and prompts are larger than before; condensing and
the meter are there to manage that.

## Slow or stuck answers

Gemma 4 normally *reasons* before it writes the answer. On a CPU-only machine that phase can take minutes for a simple question, so the chat shows what it is doing while you wait:

| Chat shows | Meaning |
| --- | --- |
| `Loading model into memory… Ns` | Nothing has come back yet: the model is loading or reading your prompt. The first request after idle is the slowest. |
| `Reasoning… Ns` | The model is thinking. Open **Show reasoning** to watch it; the answer follows. |
| `Generating… Ns` | The answer is streaming. |

**Make it faster**

1. **Runtime settings → Reasoning (Ollama) → Off.** Sends `think: false`, so the model answers directly. *Auto* (the default) lets the model decide and gives the best quality. This setting applies to Ollama only; OpenAI-compatible servers ignore it.
2. **Check where the model runs.** While it is loaded, `ollama ps` shows CPU or GPU in the `PROCESSOR` column.
3. **Use a smaller model**, for example `gemma4:e2b` (see [Choosing a model](#choosing-a-model)). `ollama run gemma4:e4b --verbose "hello"` prints the speed in tokens/s; a CPU-only rate below about 5 tokens/s will always feel slow.

**Token budget.** *Max Output Tokens* is the length of the answer. In *Auto*, the app asks Ollama for 4096 extra tokens so reasoning cannot use up the answer's budget, and it reserves that room from the *Context Window* when trimming long chats or attached snippets. With *Off*, no extra room is reserved.

**Stop and timeouts.** The red stop button keeps whatever has streamed so far. If nothing arrives for 5 minutes at the start, or the stream goes silent for 90 seconds mid-reply, the request is cancelled with an error instead of waiting forever.

**Messages you may see**

| Message | Fix |
| --- | --- |
| `…used its entire token budget on reasoning and produced no answer` | Raise *Max Output Tokens*, or set Reasoning to Off. |
| `…finished reasoning without producing a final answer` | Rephrase the prompt, or raise *Max Output Tokens*. |
| `…returned an empty answer with Reasoning turned off` | This Ollama build needs thinking on: set Reasoning back to Auto. |
| `The local model stopped responding (no data received)` | Check that Ollama is running and the model fits in RAM (`ollama ps`), then retry. |

**Page looks unchanged after an update.** The installed PWA caches the app. Hard-refresh with Ctrl+Shift+R. If the old behaviour persists, open DevTools → Application → Service Workers and click **Unregister**, then reload. Do **not** use "Clear site data": it also deletes your IndexedDB vault.

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
- **Reasoning traces and snippet lineage are stored.** A reply's reasoning ("Show reasoning") and derived child snippets (`parentId`, `derivedAction`, `version`, and provenance notes) are saved with their session or snippet in IndexedDB, so they are covered by vault encryption and included in `.gvbackup` files. Setting Reasoning to Off stops new reasoning traces from being created.
- **Multiple tabs.** Locking one tab locks all; changing encryption or importing a backup reloads the others.
