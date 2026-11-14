import { once } from 'node:events';
import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSetupManager, type SetupManager } from './server/ollamaSetup.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isManagedContainer = Boolean(process.env.K_SERVICE || process.env.APP_URL);
// Loopback by default on local machines: the app and its local-AI proxy are unauthenticated, so exposing
// them to the LAN must be an explicit opt-in (HOST=0.0.0.0 npm start, e.g. to reach it from a phone).
const HOST = process.env.HOST || (isManagedContainer ? '0.0.0.0' : '127.0.0.1');
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Strictly restrict proxy targets to loopback/local machine addresses
// so no external paid cloud AI servers can ever be contacted through this proxy.
export function parseLoopbackUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    if (!allowedHosts.has(host)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export const isLoopbackUrl = parseLoopbackUrl;

function createSecurityHeaders(production: boolean, managedContainer: boolean) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!managedContainer) {
      res.setHeader('X-Frame-Options', 'DENY');
    }
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (production) {
      // Note: Do not include http://[::1]:* because Chromium rejects bracketed IPv6 wildcards in CSP.
      const directives = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' http://localhost:* http://127.0.0.1:*",
        "form-action 'self'",
        "object-src 'none'",
        "base-uri 'self'",
      ];
      if (!managedContainer) {
        directives.push("frame-ancestors 'none'");
      }
      res.setHeader('Content-Security-Policy', directives.join('; '));
    }
    next();
  };
}

// DNS-rebinding defense: when bound to loopback, only answer requests addressed to a loopback host name.
export function hostHeaderAllowed(hostHeader: string | undefined, bindHost = HOST): boolean {
  if (!LOOPBACK_BIND_HOSTS.has(bindHost)) return true; // operator or container ingress explicitly exposed it
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.status(403).json({ error: 'Cross-site access to local AI proxy is forbidden.' });
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  const forwardedHost = req.headers['x-forwarded-host'];
  const expectedHost = (
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ||
    req.headers.host ||
    ''
  )
    .split(',')[0]
    .trim();

  try {
    const parsedOrigin = new URL(origin);
    if (!expectedHost || parsedOrigin.host !== expectedHost) {
      res.status(403).json({ error: 'Cross-origin access to local AI proxy is forbidden.' });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: 'Invalid Origin header.' });
  }
}

export interface CreateAppOptions {
  bindHost?: string;
  setupManager?: SetupManager;
  /** Automatic install/pull is only offered when the server is bound to loopback. */
  allowSetup?: boolean;
  /** Override production header mode (defaults to NODE_ENV=production or --production). */
  isProduction?: boolean;
  /** Override managed container detection (defaults to K_SERVICE / APP_URL). */
  managedContainer?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const bindHost = options.bindHost ?? HOST;
  const setupManager = options.setupManager ?? createSetupManager();
  const allowSetup = options.allowSetup ?? LOOPBACK_BIND_HOSTS.has(bindHost);
  const productionHeaders = options.isProduction ?? isProduction;
  const managedContainer = options.managedContainer ?? isManagedContainer;
  const app = express();
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!hostHeaderAllowed(req.headers.host, bindHost)) {
      res.status(403).json({ error: 'Unexpected Host header for a loopback-only GemmaVault server.' });
      return;
    }
    next();
  });
  app.use(createSecurityHeaders(productionHeaders, managedContainer));
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', sameOriginOnly);

  // --- Automatic local Gemma setup (install Ollama on Windows, start it, pull a Gemma model) ---
  const setupGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!allowSetup) {
      res.status(403).json({
        error: 'Automatic setup is disabled while GemmaVault is exposed on the network. Run it on 127.0.0.1 to use it.',
      });
      return;
    }
    // A custom header cannot be sent cross-site without a CORS preflight, which this server never grants.
    if (req.method !== 'GET' && req.get('x-gemmavault-setup') !== '1') {
      res.status(400).json({ error: 'Missing X-GemmaVault-Setup header.' });
      return;
    }
    next();
  };

  app.get('/api/setup/status', setupGuard, async (_req, res) => {
    res.json({ system: await setupManager.getSystemInfo(), job: setupManager.getState() });
  });

  app.post('/api/setup/start', setupGuard, (req, res) => {
    try {
      const model = (req.body as { model?: unknown } | undefined)?.model;
      res.status(202).json({ job: setupManager.start(typeof model === 'string' ? model : undefined) });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Unable to start setup.' });
    }
  });

  app.post('/api/setup/cancel', setupGuard, (_req, res) => {
    setupManager.cancel();
    res.json({ job: setupManager.getState() });
  });

  // Local AI runtime health & model discovery proxy (bypasses browser CORS for local Ollama/LM Studio)
  app.post('/api/local-ai/probe', async (req, res) => {
    const { baseUrl, kind } = (req.body || {}) as { baseUrl?: string; kind?: string };
    if (kind && kind !== 'ollama' && kind !== 'openai') {
      res.status(400).json({ error: 'Invalid runtime kind. Expected "ollama" or "openai".' });
      return;
    }

    const targetBase = parseLoopbackUrl(baseUrl || 'http://127.0.0.1:11434');
    if (!targetBase) {
      res.status(400).json({
        error: 'Only loopback local AI endpoints (localhost / 127.0.0.1 / ::1) are permitted.',
      });
      return;
    }

    const endpointPath = kind === 'openai' ? '/v1/models' : '/api/tags';
    const targetUrl = new URL(endpointPath, targetBase.origin).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const upstream = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `Local runtime returned HTTP ${upstream.status}` });
        return;
      }
      const data = await upstream.json();
      // Ollama only: also report its version so the UI can show which runtime build is up.
      let version: string | undefined;
      if (kind !== 'openai') {
        try {
          const v = await fetch(new URL('/api/version', targetBase.origin).toString(), {
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          });
          const parsed = (await v.json()) as { version?: unknown };
          if (typeof parsed.version === 'string') version = parsed.version.slice(0, 40);
        } catch {
          // version is optional
        }
      }
      res.json({ ok: true, data, version });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to reach local runtime';
      res.status(503).json({ ok: false, error: message });
    } finally {
      clearTimeout(timer);
    }
  });

  // Streaming local Gemma chat proxy
  app.post('/api/local-ai/chat', async (req, res) => {
    const { baseUrl, kind, payload } = (req.body || {}) as {
      baseUrl?: string;
      kind?: string;
      payload?: Record<string, unknown>;
    };

    if (kind && kind !== 'ollama' && kind !== 'openai') {
      res.status(400).json({ error: 'Invalid runtime kind. Expected "ollama" or "openai".' });
      return;
    }

    const targetBase = parseLoopbackUrl(baseUrl || 'http://127.0.0.1:11434');
    if (!targetBase) {
      res.status(400).json({
        error: 'Only loopback local AI endpoints (localhost / 127.0.0.1 / ::1) are permitted.',
      });
      return;
    }

    const endpointPath = kind === 'openai' ? '/v1/chat/completions' : '/api/chat';
    const targetUrl = new URL(endpointPath, targetBase.origin).toString();
    const controller = new AbortController();

    // Listen on `res` (not `req`) so closing the POST body stream does not abort upstream streaming.
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
        redirect: 'error',
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        res.status(upstream.status || 502).json({
          error: text || `Local runtime returned HTTP ${upstream.status}`,
        });
        return;
      }

      res.setHeader(
        'Content-Type',
        upstream.headers.get('content-type') || 'application/x-ndjson'
      );
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          if (!res.write(Buffer.from(value))) {
            await once(res, 'drain');
          }
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : 'Local runtime connection failed';
        res.status(503).json({ error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const httpServer = http.createServer(app);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer },
        ...(disableHmr ? { ws: false as const } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(
      express.static(distPath, {
        setHeaders(res, filePath) {
          const base = path.basename(filePath);
          if (base === 'sw.js' || base === 'index.html' || base === 'manifest.webmanifest') {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Tell the operator, in this terminal, whether the local LLM is actually up (the web app being up says nothing about it).
  {
    const { findOllamaBinary, listInstalledModels } = await import('./server/ollamaSetup.ts');
    const models = await listInstalledModels();
    if (models === null && !findOllamaBinary()) {
      console.log(
        'Local LLM: DOWN - Ollama is not installed. Run: npm run setup:gemma (or use Runtime settings -> Auto-setup in the app).'
      );
    } else if (models === null) {
      console.log(
        'Local LLM: DOWN - Ollama is installed but not running. Start the Ollama app, or run: npm run setup:gemma'
      );
    } else if (!models.some((m) => m.toLowerCase().includes('gemma'))) {
      console.log('Local LLM: UP, but no Gemma model installed. Run: npm run setup:gemma');
    } else {
      console.log(
        `Local LLM: UP - Ollama is running with: ${models
          .filter((m) => m.toLowerCase().includes('gemma'))
          .join(', ')}. Nothing to download or start.`
      );
    }
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`GemmaVault local workbench running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!isManagedContainer && (HOST === '0.0.0.0' || HOST === '::')) {
      console.warn('WARNING: GemmaVault is reachable from your network and has no authentication. Use only on trusted networks.');
    }
  });
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer();
}
