import {
  createVerifier,
  decryptText,
  DEFAULT_PBKDF2_ITERATIONS,
  deriveAesKey,
  encryptText,
  generateSaltBase64,
  MIN_PASSPHRASE_LENGTH,
  verifyKeyAgainstToken,
} from './crypto';
import type {
  ChatSession,
  CodeSnippet,
  DocPage,
  EncryptedEnvelope,
  LocalRuntimeConfig,
  Project,
  VaultBackupBundle,
  VaultSecurityMeta,
} from '../types/vault';

export { MIN_PASSPHRASE_LENGTH };

const DB_NAME = 'GemmaVaultDB';
const DB_VERSION = 1;
const BACKUP_AAD = 'gemmavault:backup:v1';
const MAX_BACKUP_CHARS = 50_000_000;
const MIN_BACKUP_ITERATIONS = 10_000;
const MAX_BACKUP_ITERATIONS = 5_000_000;

const STORES = {
  projects: 'projects',
  snippets: 'snippets',
  docs: 'docs',
  sessions: 'sessions',
  settings: 'settings',
  security: 'security',
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];
const ALL_STORE_NAMES = Object.values(STORES) as StoreName[];

let cachedDbPromise: Promise<IDBDatabase> | null = null;

export interface DecryptedWorkspaceData {
  projects: Project[];
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
  runtimeConfig: LocalRuntimeConfig;
  securityMeta: VaultSecurityMeta;
}

export const DEFAULT_RUNTIME_CONFIG: LocalRuntimeConfig = {
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  selectedModel: 'gemma4:e4b',
  temperature: 0.25,
  maxTokens: 2048,
  contextTokens: 8192,
  reasoning: 'auto',
  systemPrompt:
    'You are an expert software engineer running locally on Google Gemma. Provide concise, accurate, production-ready code and architectural guidance. Always specify the language on fenced code blocks.',
};

const DEFAULT_SECURITY_META: VaultSecurityMeta = {
  id: 'primary',
  encryptionEnabled: false,
  saltBase64: '',
  verifierCipherBase64: '',
  verifierIvBase64: '',
  iterations: DEFAULT_PBKDF2_ITERATIONS,
  autoLockMinutes: 15,
  updatedAt: Date.now(),
};

function clampNumber(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, val));
}

export function sanitizeRuntimeConfig(raw?: Partial<LocalRuntimeConfig> | null): LocalRuntimeConfig {
  const kind = raw?.kind === 'openai' || raw?.kind === 'ollama' ? raw.kind : DEFAULT_RUNTIME_CONFIG.kind;
  const baseUrl =
    typeof raw?.baseUrl === 'string' && raw.baseUrl.trim()
      ? raw.baseUrl.trim()
      : DEFAULT_RUNTIME_CONFIG.baseUrl;
  const selectedModel =
    typeof raw?.selectedModel === 'string' && raw.selectedModel.trim()
      ? raw.selectedModel.trim()
      : DEFAULT_RUNTIME_CONFIG.selectedModel;
  const temperature = clampNumber(raw?.temperature, DEFAULT_RUNTIME_CONFIG.temperature, 0, 2);
  const maxTokens = Math.round(clampNumber(raw?.maxTokens, DEFAULT_RUNTIME_CONFIG.maxTokens, 64, 32768));
  const contextTokens = Math.round(
    clampNumber(raw?.contextTokens, DEFAULT_RUNTIME_CONFIG.contextTokens ?? 8192, 2048, 262144)
  );
  const reasoning = raw?.reasoning === 'off' ? 'off' : 'auto';
  const systemPrompt =
    typeof raw?.systemPrompt === 'string' && raw.systemPrompt.trim()
      ? raw.systemPrompt
      : DEFAULT_RUNTIME_CONFIG.systemPrompt;

  return {
    kind,
    baseUrl,
    selectedModel,
    temperature,
    maxTokens,
    contextTokens,
    reasoning,
    systemPrompt,
  };
}

function makeRecordAad(storeName: StoreName, id: string): string {
  return `gemmavault:${storeName}:${id}`;
}

function createStarterDataset(): {
  projects: Project[];
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
} {
  const now = Date.now();
  const projects: Project[] = [
    {
      id: 'proj-core',
      name: 'Core Local Stack',
      description: 'Offline utilities, local encryption primitives, and runtime adapters.',
      defaultLanguage: 'typescript',
      createdAt: now - 86400000 * 3,
      updatedAt: now - 3600000 * 2,
    },
    {
      id: 'proj-systems',
      name: 'Systems & Data Pipelines',
      description: 'High-throughput Python, Rust, and SQL patterns for local processing.',
      defaultLanguage: 'python',
      createdAt: now - 86400000 * 2,
      updatedAt: now - 3600000 * 5,
    },
  ];

  const snippets: CodeSnippet[] = [
    {
      id: 'snip-aes-gcm',
      projectId: 'proj-core',
      title: 'WebCrypto AES-256-GCM Sealed Payload',
      language: 'typescript',
      favorite: true,
      tags: ['crypto', 'offline', 'security'],
      notes:
        'Derives an AES-256-GCM key via PBKDF2-SHA256 and seals JSON state with AAD binding and a unique 96-bit IV.',
      code: `export async function sealLocalPayload(
  secret: string,
  salt: Uint8Array,
  payload: unknown,
  aadContext: string
): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 600_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aadContext) },
    aesKey,
    data
  );

  return { iv, ciphertext };
}`,
      createdAt: now - 86400000 * 2,
      updatedAt: now - 1800000,
    },
    {
      id: 'snip-py-sqlite',
      projectId: 'proj-systems',
      title: 'Python WAL-Mode SQLite Batch Writer',
      language: 'python',
      favorite: true,
      tags: ['python', 'sqlite', 'performance'],
      notes:
        'Uses Write-Ahead Logging and batched executemany transactions for fast offline local ingestion.',
      code: `import sqlite3
from contextlib import contextmanager
from typing import Iterable, Tuple

@contextmanager
def open_local_db(db_path: str):
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def upsert_records(db_path: str, rows: Iterable[Tuple[str, str, str]]) -> int:
    with open_local_db(db_path) as conn:
        cursor = conn.executemany(
            """
            INSERT INTO snippets (id, language, body)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                language = excluded.language,
                body = excluded.body
            """,
            rows,
        )
        return cursor.rowcount`,
      createdAt: now - 86400000,
      updatedAt: now - 7200000,
    },
    {
      id: 'snip-rust-lru',
      projectId: 'proj-systems',
      title: 'Rust Thread-Safe Ring Buffer Cache',
      language: 'rust',
      favorite: false,
      tags: ['rust', 'concurrency', 'cache'],
      notes:
        'Bounded FIFO/ring cache protected by a standard RwLock with zero external crate dependencies.',
      code: `use std::collections::VecDeque;
use std::sync::RwLock;

pub struct BoundedRing<T> {
    capacity: usize,
    inner: RwLock<VecDeque<T>>,
}

impl<T: Clone> BoundedRing<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            inner: RwLock::new(VecDeque::with_capacity(capacity)),
        }
    }

    pub fn push(&self, item: T) {
        let mut guard = self.inner.write().expect("ring lock poisoned");
        if guard.len() >= self.capacity {
            guard.pop_front();
        }
        guard.push_back(item);
    }

    pub fn snapshot(&self) -> Vec<T> {
        let guard = self.inner.read().expect("ring lock poisoned");
        guard.iter().cloned().collect()
    }
}`,
      createdAt: now - 86400000,
      updatedAt: now - 14400000,
    },
    {
      id: 'snip-sql-fts',
      projectId: 'proj-systems',
      title: 'SQLite FTS5 Full-Text Snippet Index',
      language: 'sql',
      favorite: false,
      tags: ['sql', 'search', 'indexing'],
      notes:
        'FTS5 indexing strategy for instant sub-millisecond code search across large local documentation stores.',
      code: `-- SQLite FTS5 Virtual Table for Offline Snippet & Doc Search
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
    entry_id UNINDEXED,
    title,
    language,
    body,
    tokenize = 'unicode61 tokenchars "_-."'
);

-- Query ranked snippets matching both keyword and language filter
SELECT entry_id, title, bm25(vault_fts) AS relevance
FROM vault_fts
WHERE vault_fts MATCH 'title:crypto OR body:PBKDF2'
ORDER BY relevance ASC
LIMIT 25;`,
      createdAt: now - 43200000,
      updatedAt: now - 21600000,
    },
  ];

  const docs: DocPage[] = [
    {
      id: 'doc-gemma-setup',
      projectId: 'proj-core',
      title: 'Running Local Google Gemma Models Offline',
      category: 'runbook',
      pinned: true,
      content: `# Running Local Google Gemma Models Offline

GemmaVault connects directly to locally installed **Google Gemma** open-weight models on your machine with zero cloud API keys or paid subscriptions.

## Recommended Free Google Gemma Models

| Model Tag | Best For | Memory Needed |
| --- | --- | --- |
| \`gemma4:31b\` | Flagship dense reasoning & multi-file refactoring | ~24 GB VRAM/RAM |
| \`gemma4:26b\` | High-speed MoE architecture & coding | ~18 GB VRAM/RAM |
| \`gemma4:e4b\` | Balanced everyday coding on laptops | ~6–8 GB VRAM/RAM |
| \`gemma4:e2b\` | Ultra-lightweight edge & low-RAM devices | ~3–4 GB VRAM/RAM |
| \`gemma3n:e4b\` | Multimodal-ready efficient local model | ~5 GB VRAM/RAM |
| \`gemma3:12b\` | Proven Gemma 3 coding & test generation | ~9 GB VRAM/RAM |
| \`codegemma:7b\` | Dedicated code completion and FIM tasks | ~6 GB VRAM/RAM |

## Option 1: Ollama (Recommended)

Install Ollama and a Gemma model once, then run completely offline. This command is safe to re-run; it skips anything already installed:

\`\`\`bash
npm run setup:gemma
\`\`\`

> Tip: the status bar under the header shows whether the local LLM is up. Do not run \`ollama serve\` if Ollama is already running; the status bar and the terminal both tell you.

## Option 2: LM Studio or llama.cpp Server

Start an OpenAI-compatible local endpoint with any GGUF build of Gemma 4 or Gemma 3:

\`\`\`bash
llama-server -m gemma-4-e4b-it-Q4_K_M.gguf --port 1234 --ctx-size 8192
\`\`\`

Then switch the runtime selector in the **Model Setup** dialog to **llama.cpp / LM Studio** pointing to \`http://127.0.0.1:1234\`.`,
      createdAt: now - 86400000 * 2,
      updatedAt: now - 3600000,
    },
    {
      id: 'doc-vault-security',
      projectId: 'proj-core',
      title: 'Local Encrypted Database Architecture',
      category: 'architecture',
      pinned: false,
      content: `# Local Encrypted Database Architecture

All snippets, project documentation, and AI chat sessions remain strictly inside your browser's **IndexedDB** storage engine (\`GemmaVaultDB\`).

## Cryptographic Specification

- **Cipher**: \`AES-256-GCM\` (Authenticated Encryption with Associated Data)
- **AAD Binding**: Each v2 encrypted record strictly binds its store name and record ID as Additional Authenticated Data to prevent ciphertext swapping
- **Key Derivation**: \`PBKDF2\` with \`SHA-256\` and \`600,000\` iterations
- **Initialization Vector**: Fresh 96-bit random IV generated via \`crypto.getRandomValues\` per record write
- **Zero Plaintext Secret Storage**: Your master passphrase never touches \`localStorage\` or \`IndexedDB\`; only an encrypted verifier token is persisted

## Backup & Portability

1. Open the **Vault DB** tab to export a self-contained \`.gvbackup\` file.
2. When vault encryption is enabled, backups stay encrypted using your active key derivation parameters.
3. Restore on any desktop or mobile device completely offline via **Import Backup**.`,
      createdAt: now - 86400000,
      updatedAt: now - 10800000,
    },
  ];

  const sessions: ChatSession[] = [
    {
      id: 'chat-welcome',
      projectId: 'proj-core',
      title: 'Local Gemma Coding Session',
      messages: [
        {
          id: 'msg-intro',
          role: 'assistant',
          model: 'Gemma Local Workspace',
          createdAt: now - 3600000,
          content:
            'Ready to assist offline with your locally installed **Google Gemma** model.\n\n- Click **Scan Local** in the model bar to auto-detect `gemma4`, `gemma3n`, `gemma3`, `gemma2`, or `codegemma` running via Ollama or llama.cpp.\n- Attach any code snippet or Markdown doc from your encrypted local vault to ground Gemma in your project context.\n- Every code block Gemma produces can be copied or saved straight into your **Snippets** database.',
        },
      ],
      createdAt: now - 3600000,
      updatedAt: now - 3600000,
    },
  ];

  return { projects, snippets, docs, sessions };
}

function openDB(): Promise<IDBDatabase> {
  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      ALL_STORE_NAMES.forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      });
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        cachedDbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        cachedDbPromise = null;
      };
      resolve(db);
    };

    request.onblocked = () => {
      cachedDbPromise = null;
      reject(
        new Error('Local database upgrade is blocked by another open GemmaVault tab. Close other tabs and retry.')
      );
    };

    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
  });

  return cachedDbPromise;
}

async function getAllRaw<T>(storeName: StoreName): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function getRawById<T>(storeName: StoreName, id: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function putRaw<T>(storeName: StoreName, record: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteRaw(storeName: StoreName, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function commitAtomically(
  stores: StoreName[],
  fn: (tx: IDBTransaction) => void
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Atomic IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Atomic IndexedDB transaction aborted'));
    fn(tx);
  });
}

async function writeWorkspaceAtomically(params: {
  projects: Array<Project | EncryptedEnvelope>;
  snippets: Array<CodeSnippet | EncryptedEnvelope>;
  docs: Array<DocPage | EncryptedEnvelope>;
  sessions: Array<ChatSession | EncryptedEnvelope>;
  settingsRecord: (LocalRuntimeConfig & { id: string; updatedAt: number }) | EncryptedEnvelope;
  securityMeta?: VaultSecurityMeta;
}): Promise<void> {
  const storesToLock: StoreName[] = params.securityMeta
    ? [STORES.projects, STORES.snippets, STORES.docs, STORES.sessions, STORES.settings, STORES.security]
    : [STORES.projects, STORES.snippets, STORES.docs, STORES.sessions, STORES.settings];

  await commitAtomically(storesToLock, (tx) => {
    const writeStore = (name: StoreName, items: unknown[]) => {
      const store = tx.objectStore(name);
      store.clear();
      for (const item of items) {
        store.put(item);
      }
    };

    writeStore(STORES.projects, params.projects);
    writeStore(STORES.snippets, params.snippets);
    writeStore(STORES.docs, params.docs);
    writeStore(STORES.sessions, params.sessions);
    writeStore(STORES.settings, [params.settingsRecord]);

    if (params.securityMeta) {
      tx.objectStore(STORES.security).put(params.securityMeta);
    }
  });
}

function isEncryptedEnvelope(record: unknown): record is EncryptedEnvelope {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as EncryptedEnvelope).encrypted === true &&
    typeof (record as EncryptedEnvelope).ciphertext === 'string' &&
    typeof (record as EncryptedEnvelope).iv === 'string'
  );
}

async function serializeRecord<T extends { id: string; updatedAt?: number }>(
  storeName: StoreName,
  record: T,
  key: CryptoKey | null
): Promise<T | EncryptedEnvelope> {
  if (!key) return record;
  const aad = makeRecordAad(storeName, record.id);
  const { ivBase64, ciphertextBase64 } = await encryptText(JSON.stringify(record), key, aad);
  return {
    id: record.id,
    encrypted: true,
    v: 2,
    iv: ivBase64,
    ciphertext: ciphertextBase64,
    aad,
    updatedAt: record.updatedAt || Date.now(),
  };
}

async function deserializeRecord<T>(
  storeName: StoreName,
  record: T | EncryptedEnvelope,
  key: CryptoKey | null
): Promise<T> {
  if (!isEncryptedEnvelope(record)) {
    return record;
  }
  if (!key) {
    throw new Error('Vault is locked. Unlock with your passphrase to decrypt local records.');
  }
  const canonicalAad = makeRecordAad(storeName, record.id);
  if (record.v === 2 || record.aad) {
    if (record.aad && record.aad !== canonicalAad) {
      throw new Error(`Integrity check failed: AAD mismatch for ${storeName}:${record.id}`);
    }
    const json = await decryptText(record.ciphertext, record.iv, key, canonicalAad);
    return JSON.parse(json) as T;
  }

  // Legacy v1 envelope without AAD
  const json = await decryptText(record.ciphertext, record.iv, key);
  return JSON.parse(json) as T;
}

export async function getSecurityMeta(): Promise<VaultSecurityMeta> {
  const existing = await getRawById<VaultSecurityMeta>(STORES.security, 'primary');
  if (existing) return existing;
  await putRaw(STORES.security, DEFAULT_SECURITY_META);
  return DEFAULT_SECURITY_META;
}

export async function updateSecurityMeta(meta: VaultSecurityMeta): Promise<void> {
  await putRaw(STORES.security, meta);
}

export async function ensureSeededIfEmpty(): Promise<void> {
  const [projects, snippets, docs] = await Promise.all([
    getAllRaw<Project | EncryptedEnvelope>(STORES.projects),
    getAllRaw<CodeSnippet | EncryptedEnvelope>(STORES.snippets),
    getAllRaw<DocPage | EncryptedEnvelope>(STORES.docs),
  ]);

  const meta = await getSecurityMeta();
  if (meta.encryptionEnabled) return;

  if (projects.length === 0 && snippets.length === 0 && docs.length === 0) {
    const starter = createStarterDataset();
    await writeWorkspaceAtomically({
      projects: starter.projects,
      snippets: starter.snippets,
      docs: starter.docs,
      sessions: starter.sessions,
      settingsRecord: { id: 'runtime', ...DEFAULT_RUNTIME_CONFIG, updatedAt: Date.now() },
    });
  }
}

export async function loadWorkspaceData(key: CryptoKey | null): Promise<DecryptedWorkspaceData> {
  await ensureSeededIfEmpty();
  const securityMeta = await getSecurityMeta();

  const [rawProjects, rawSnippets, rawDocs, rawSessions, rawSettings] = await Promise.all([
    getAllRaw<Project | EncryptedEnvelope>(STORES.projects),
    getAllRaw<CodeSnippet | EncryptedEnvelope>(STORES.snippets),
    getAllRaw<DocPage | EncryptedEnvelope>(STORES.docs),
    getAllRaw<ChatSession | EncryptedEnvelope>(STORES.sessions),
    getRawById<(LocalRuntimeConfig & { id: string }) | EncryptedEnvelope>(STORES.settings, 'runtime'),
  ]);

  const projects = await Promise.all(
    rawProjects.map((r) => deserializeRecord<Project>(STORES.projects, r, key))
  );
  const snippets = await Promise.all(
    rawSnippets.map((r) => deserializeRecord<CodeSnippet>(STORES.snippets, r, key))
  );
  const docs = await Promise.all(
    rawDocs.map((r) => deserializeRecord<DocPage>(STORES.docs, r, key))
  );
  const sessions = await Promise.all(
    rawSessions.map((r) => deserializeRecord<ChatSession>(STORES.sessions, r, key))
  );

  let runtimeConfig = DEFAULT_RUNTIME_CONFIG;
  if (rawSettings) {
    const parsed = await deserializeRecord<LocalRuntimeConfig & { id?: string }>(
      STORES.settings,
      rawSettings,
      key
    );
    runtimeConfig = sanitizeRuntimeConfig(parsed);
  }

  return {
    projects: projects.sort((a, b) => a.createdAt - b.createdAt),
    snippets: snippets.sort((a, b) => b.updatedAt - a.updatedAt),
    docs: docs.sort((a, b) => b.updatedAt - a.updatedAt),
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    runtimeConfig,
    securityMeta,
  };
}

/**
 * Defense in depth: never let a record reach IndexedDB in plaintext while the vault is
 * encrypted. A late write (e.g. a Gemma stream finishing after auto-lock) arrives with
 * key === null; without this guard it would silently be stored unencrypted.
 */
async function assertWritable(key: CryptoKey | null): Promise<void> {
  if (key) return;
  const meta = await getSecurityMeta();
  if (meta.encryptionEnabled) {
    throw new Error('Vault is locked. Unlock with your passphrase before saving.');
  }
}

export async function saveProject(project: Project, key: CryptoKey | null): Promise<void> {
  await assertWritable(key);
  await putRaw(STORES.projects, await serializeRecord(STORES.projects, project, key));
}

export async function removeProject(id: string): Promise<void> {
  await deleteRaw(STORES.projects, id);
}

/**
 * Deletes a project and atomically re-homes all snippets, documentation pages,
 * and chat sessions linked to it into `fallbackProjectId` so user data is never wiped.
 */
export async function removeProjectAndRehome(params: {
  projectId: string;
  fallbackProjectId: string;
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
  key: CryptoKey | null;
}): Promise<{
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
}> {
  if (params.projectId === params.fallbackProjectId) {
    throw new Error('Fallback project must be distinct from the project being removed.');
  }

  await assertWritable(params.key);

  const now = Date.now();
  const movedSnippets = params.snippets
    .filter((s) => s.projectId === params.projectId)
    .map((s) => ({ ...s, projectId: params.fallbackProjectId, updatedAt: now }));
  const movedDocs = params.docs
    .filter((d) => d.projectId === params.projectId)
    .map((d) => ({ ...d, projectId: params.fallbackProjectId, updatedAt: now }));
  const movedSessions = params.sessions
    .filter((c) => c.projectId === params.projectId)
    .map((c) => ({ ...c, projectId: params.fallbackProjectId, updatedAt: now }));

  const [serializedSnippets, serializedDocs, serializedSessions] = await Promise.all([
    Promise.all(movedSnippets.map((s) => serializeRecord(STORES.snippets, s, params.key))),
    Promise.all(movedDocs.map((d) => serializeRecord(STORES.docs, d, params.key))),
    Promise.all(movedSessions.map((c) => serializeRecord(STORES.sessions, c, params.key))),
  ]);

  await commitAtomically(
    [STORES.projects, STORES.snippets, STORES.docs, STORES.sessions],
    (tx) => {
      tx.objectStore(STORES.projects).delete(params.projectId);
      const snippetStore = tx.objectStore(STORES.snippets);
      for (const s of serializedSnippets) snippetStore.put(s);
      const docStore = tx.objectStore(STORES.docs);
      for (const d of serializedDocs) docStore.put(d);
      const sessionStore = tx.objectStore(STORES.sessions);
      for (const c of serializedSessions) sessionStore.put(c);
    }
  );

  const movedSnippetMap = new Map(movedSnippets.map((s) => [s.id, s]));
  const movedDocMap = new Map(movedDocs.map((d) => [d.id, d]));
  const movedSessionMap = new Map(movedSessions.map((c) => [c.id, c]));

  return {
    snippets: params.snippets.map((s) => movedSnippetMap.get(s.id) || s),
    docs: params.docs.map((d) => movedDocMap.get(d.id) || d),
    sessions: params.sessions.map((c) => movedSessionMap.get(c.id) || c),
  };
}

export async function saveSnippet(snippet: CodeSnippet, key: CryptoKey | null): Promise<void> {
  await assertWritable(key);
  await putRaw(STORES.snippets, await serializeRecord(STORES.snippets, snippet, key));
}

export async function removeSnippet(id: string): Promise<void> {
  await deleteRaw(STORES.snippets, id);
}

export async function saveDoc(doc: DocPage, key: CryptoKey | null): Promise<void> {
  await assertWritable(key);
  await putRaw(STORES.docs, await serializeRecord(STORES.docs, doc, key));
}

export async function removeDoc(id: string): Promise<void> {
  await deleteRaw(STORES.docs, id);
}

export async function saveChatSession(session: ChatSession, key: CryptoKey | null): Promise<void> {
  await assertWritable(key);
  await putRaw(STORES.sessions, await serializeRecord(STORES.sessions, session, key));
}

export async function removeChatSession(id: string): Promise<void> {
  await deleteRaw(STORES.sessions, id);
}

export async function saveRuntimeConfig(
  config: LocalRuntimeConfig,
  key: CryptoKey | null
): Promise<void> {
  await assertWritable(key);
  const sanitized = sanitizeRuntimeConfig(config);
  await putRaw(
    STORES.settings,
    await serializeRecord(
      STORES.settings,
      { id: 'runtime', ...sanitized, updatedAt: Date.now() },
      key
    )
  );
}

export async function unlockVaultWithPassphrase(
  passphrase: string
): Promise<{ key: CryptoKey; meta: VaultSecurityMeta } | null> {
  const meta = await getSecurityMeta();
  if (!meta.encryptionEnabled) return null;
  const derivedKey = await deriveAesKey(passphrase, meta.saltBase64, meta.iterations);
  const valid = await verifyKeyAgainstToken(
    derivedKey,
    meta.verifierCipherBase64,
    meta.verifierIvBase64
  );
  if (!valid) return null;
  return { key: derivedKey, meta };
}

export async function enableVaultEncryption(
  passphrase: string,
  currentData: DecryptedWorkspaceData,
  autoLockMinutes: number
): Promise<{ key: CryptoKey; meta: VaultSecurityMeta }> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const saltBase64 = generateSaltBase64(16);
  const key = await deriveAesKey(passphrase, saltBase64, DEFAULT_PBKDF2_ITERATIONS);
  const { verifierCipherBase64, verifierIvBase64 } = await createVerifier(key);

  const meta: VaultSecurityMeta = {
    id: 'primary',
    encryptionEnabled: true,
    saltBase64,
    verifierCipherBase64,
    verifierIvBase64,
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    autoLockMinutes,
    updatedAt: Date.now(),
  };

  const sanitizedCfg = sanitizeRuntimeConfig(currentData.runtimeConfig);

  const [projects, snippets, docs, sessions, settingsRecord] = await Promise.all([
    Promise.all(currentData.projects.map((p) => serializeRecord(STORES.projects, p, key))),
    Promise.all(currentData.snippets.map((s) => serializeRecord(STORES.snippets, s, key))),
    Promise.all(currentData.docs.map((d) => serializeRecord(STORES.docs, d, key))),
    Promise.all(currentData.sessions.map((c) => serializeRecord(STORES.sessions, c, key))),
    serializeRecord(
      STORES.settings,
      { id: 'runtime', ...sanitizedCfg, updatedAt: Date.now() },
      key
    ),
  ]);

  await writeWorkspaceAtomically({
    projects,
    snippets,
    docs,
    sessions,
    settingsRecord,
    securityMeta: meta,
  });

  return { key, meta };
}

export async function changeVaultPassphrase(
  currentPassphrase: string,
  newPassphrase: string,
  currentData: DecryptedWorkspaceData
): Promise<{ key: CryptoKey; meta: VaultSecurityMeta }> {
  const verified = await unlockVaultWithPassphrase(currentPassphrase);
  if (!verified) {
    throw new Error('Current master passphrase is incorrect.');
  }
  return enableVaultEncryption(newPassphrase, currentData, currentData.securityMeta.autoLockMinutes);
}

export async function disableVaultEncryption(
  currentData: DecryptedWorkspaceData
): Promise<VaultSecurityMeta> {
  const meta: VaultSecurityMeta = {
    ...DEFAULT_SECURITY_META,
    updatedAt: Date.now(),
  };

  await writeWorkspaceAtomically({
    projects: currentData.projects,
    snippets: currentData.snippets,
    docs: currentData.docs,
    sessions: currentData.sessions,
    settingsRecord: {
      id: 'runtime',
      ...sanitizeRuntimeConfig(currentData.runtimeConfig),
      updatedAt: Date.now(),
    },
    securityMeta: meta,
  });

  return meta;
}

export async function exportVaultBackup(
  data: DecryptedWorkspaceData,
  key: CryptoKey | null
): Promise<VaultBackupBundle> {
  const plainJson = JSON.stringify({
    projects: data.projects,
    snippets: data.snippets,
    docs: data.docs,
    sessions: data.sessions,
    runtimeConfig: sanitizeRuntimeConfig(data.runtimeConfig),
  });

  if (key && data.securityMeta.encryptionEnabled) {
    const { ivBase64, ciphertextBase64 } = await encryptText(plainJson, key, BACKUP_AAD);
    return {
      format: 'gemmavault-backup-v1',
      exportedAt: Date.now(),
      encrypted: true,
      securityMeta: data.securityMeta,
      payload: ciphertextBase64,
      iv: ivBase64,
      aad: BACKUP_AAD,
    };
  }

  return {
    format: 'gemmavault-backup-v1',
    exportedAt: Date.now(),
    encrypted: false,
    payload: plainJson,
  };
}

export function parseBackupFile(rawText: string): VaultBackupBundle {
  if (typeof rawText !== 'string' || rawText.length > MAX_BACKUP_CHARS) {
    throw new Error('Backup file exceeds maximum supported size (50 MB).');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Backup file has an invalid structure.');
  }

  const candidate = parsed as Partial<VaultBackupBundle>;
  if (candidate.format !== 'gemmavault-backup-v1') {
    throw new Error('Unsupported backup file format.');
  }
  if (typeof candidate.encrypted !== 'boolean' || typeof candidate.payload !== 'string') {
    throw new Error('Backup file is missing required payload fields.');
  }

  if (candidate.encrypted) {
    const meta = candidate.securityMeta;
    if (
      typeof candidate.iv !== 'string' ||
      !meta ||
      typeof meta.saltBase64 !== 'string' ||
      typeof meta.verifierCipherBase64 !== 'string' ||
      typeof meta.verifierIvBase64 !== 'string' ||
      typeof meta.iterations !== 'number' ||
      !Number.isInteger(meta.iterations) ||
      meta.iterations < MIN_BACKUP_ITERATIONS ||
      meta.iterations > MAX_BACKUP_ITERATIONS
    ) {
      throw new Error('Encrypted backup has invalid or out-of-range cryptographic metadata.');
    }
  }

  return candidate as VaultBackupBundle;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

export function validateBackupPayload(raw: unknown): {
  projects: Project[];
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
  runtimeConfig: LocalRuntimeConfig;
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Backup payload is malformed.');
  }
  const obj = raw as Record<string, unknown>;
  if (
    !Array.isArray(obj.projects) ||
    !Array.isArray(obj.snippets) ||
    !Array.isArray(obj.docs)
  ) {
    throw new Error('Backup payload is missing projects, snippets, or docs arrays.');
  }

  if (obj.projects.length === 0) {
    throw new Error('Backup must contain at least one workspace project.');
  }

  for (const p of obj.projects) {
    if (
      typeof p !== 'object' ||
      p === null ||
      !isNonEmptyString((p as Project).id) ||
      !isNonEmptyString((p as Project).name)
    ) {
      throw new Error('Backup contains an invalid project entry.');
    }
  }

  for (const s of obj.snippets) {
    if (
      typeof s !== 'object' ||
      s === null ||
      !isNonEmptyString((s as CodeSnippet).id) ||
      !isNonEmptyString((s as CodeSnippet).projectId) ||
      typeof (s as CodeSnippet).title !== 'string' ||
      typeof (s as CodeSnippet).code !== 'string'
    ) {
      throw new Error('Backup contains an invalid code snippet entry.');
    }
  }

  for (const d of obj.docs) {
    if (
      typeof d !== 'object' ||
      d === null ||
      !isNonEmptyString((d as DocPage).id) ||
      !isNonEmptyString((d as DocPage).projectId) ||
      typeof (d as DocPage).title !== 'string' ||
      typeof (d as DocPage).content !== 'string'
    ) {
      throw new Error('Backup contains an invalid documentation entry.');
    }
  }

  const sessions = Array.isArray(obj.sessions) ? (obj.sessions as ChatSession[]) : [];
  for (const c of sessions) {
    if (
      typeof c !== 'object' ||
      c === null ||
      !isNonEmptyString(c.id) ||
      !Array.isArray(c.messages)
    ) {
      throw new Error('Backup contains an invalid chat session entry.');
    }
  }

  return {
    projects: obj.projects as Project[],
    snippets: obj.snippets as CodeSnippet[],
    docs: obj.docs as DocPage[],
    sessions,
    runtimeConfig: sanitizeRuntimeConfig(
      obj.runtimeConfig && typeof obj.runtimeConfig === 'object'
        ? (obj.runtimeConfig as Partial<LocalRuntimeConfig>)
        : undefined
    ),
  };
}

export async function openBackupBundle(
  bundle: VaultBackupBundle,
  passphraseForEncryptedBundle: string | null
): Promise<ReturnType<typeof validateBackupPayload>> {
  if (bundle.format !== 'gemmavault-backup-v1') {
    throw new Error('Unsupported backup file format.');
  }

  let parsedRaw: unknown;

  if (bundle.encrypted) {
    if (!bundle.iv || !bundle.securityMeta) {
      throw new Error('Encrypted backup is missing cryptographic metadata.');
    }
    if (
      !Number.isInteger(bundle.securityMeta.iterations) ||
      bundle.securityMeta.iterations < MIN_BACKUP_ITERATIONS ||
      bundle.securityMeta.iterations > MAX_BACKUP_ITERATIONS
    ) {
      throw new Error('Encrypted backup PBKDF2 iteration count is out of safe bounds.');
    }
    if (!passphraseForEncryptedBundle) {
      throw new Error('Enter the passphrase used to seal this encrypted backup.');
    }
    const backupKey = await deriveAesKey(
      passphraseForEncryptedBundle,
      bundle.securityMeta.saltBase64,
      bundle.securityMeta.iterations
    );
    const valid = await verifyKeyAgainstToken(
      backupKey,
      bundle.securityMeta.verifierCipherBase64,
      bundle.securityMeta.verifierIvBase64
    );
    if (!valid) {
      throw new Error('Incorrect passphrase for encrypted backup file.');
    }
    // Pin AAD to the constant: never trust an AAD string supplied by the file itself.
    const json = await decryptText(bundle.payload, bundle.iv, backupKey, BACKUP_AAD);
    parsedRaw = JSON.parse(json);
  } else {
    parsedRaw = JSON.parse(bundle.payload);
  }

  return validateBackupPayload(parsedRaw);
}

export async function importVaultBackup(
  bundle: VaultBackupBundle,
  passphraseForEncryptedBundle: string | null,
  activeKey: CryptoKey | null
): Promise<DecryptedWorkspaceData> {
  const parsedPayload = await openBackupBundle(bundle, passphraseForEncryptedBundle);
  const securityMeta = await getSecurityMeta();
  const runtimeConfig = parsedPayload.runtimeConfig;

  const [projects, snippets, docs, sessions, settingsRecord] = await Promise.all([
    Promise.all(parsedPayload.projects.map((p) => serializeRecord(STORES.projects, p, activeKey))),
    Promise.all(parsedPayload.snippets.map((s) => serializeRecord(STORES.snippets, s, activeKey))),
    Promise.all(parsedPayload.docs.map((d) => serializeRecord(STORES.docs, d, activeKey))),
    Promise.all(parsedPayload.sessions.map((c) => serializeRecord(STORES.sessions, c, activeKey))),
    serializeRecord(
      STORES.settings,
      { id: 'runtime', ...runtimeConfig, updatedAt: Date.now() },
      activeKey
    ),
  ]);

  await writeWorkspaceAtomically({
    projects,
    snippets,
    docs,
    sessions,
    settingsRecord,
  });

  return {
    projects: parsedPayload.projects,
    snippets: parsedPayload.snippets,
    docs: parsedPayload.docs,
    sessions: parsedPayload.sessions,
    runtimeConfig,
    securityMeta,
  };
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function estimateStorageUsage(): Promise<{
  usageBytes: number;
  quotaBytes: number;
  persisted: boolean;
} | null> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const [est, persisted] = await Promise.all([
        navigator.storage.estimate(),
        navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
      ]);
      return {
        usageBytes: est.usage || 0,
        quotaBytes: est.quota || 0,
        persisted,
      };
    } catch {
      return null;
    }
  }
  return null;
}
