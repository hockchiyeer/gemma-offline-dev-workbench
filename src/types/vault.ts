export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'cpp'
  | 'java'
  | 'sql'
  | 'bash'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'yaml';

export type WorkspaceTab = 'assistant' | 'snippets' | 'docs' | 'database';

export type RuntimeKind = 'ollama' | 'openai';

export interface Project {
  id: string;
  name: string;
  description: string;
  defaultLanguage: SupportedLanguage;
  createdAt: number;
  updatedAt: number;
}

export type SnippetActionKind =
  | 'explain'
  | 'debug'
  | 'refactor'
  | 'expand'
  | 'unit-tests'
  | 'edit'
  | 'chat';

export interface CodeSnippet {
  id: string;
  projectId: string;
  /** Optional parent snippet ID when derived from an existing snippet. */
  parentId?: string;
  /** AI action or origin that created this derived snippet. */
  derivedAction?: SnippetActionKind;
  /** Tree depth / revision number (root = 1, child = 2, grandchild = 3...). */
  version?: number;
  /** Hash of the parent's code when this version was derived (lets the UI flag a parent that changed since). */
  baseHash?: string;
  title: string;
  language: SupportedLanguage;
  code: string;
  notes: string;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export type DocCategory = 'architecture' | 'api' | 'runbook' | 'notes';

export interface DocPage {
  id: string;
  projectId: string;
  title: string;
  category: DocCategory;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatAttachmentRef {
  kind: 'snippet' | 'doc' | 'file' | 'folder' | 'symbol' | 'git';
  id: string;
  title: string;
  /** Optional 1-based inclusive line range for file/symbol mentions. */
  startLine?: number;
  endLine?: number;
}

export interface ChatWorkspace {
  path: string;
  name?: string;
  repoMap: boolean;
  autoRetrieve: boolean;
}

export interface WorkspaceContextItem {
  via: 'mention' | 'retrieved' | 'map';
  label: string;
  tokens: number;
}

export interface WorkspaceContextUse {
  workspaceName: string;
  items: WorkspaceContextItem[];
  truncated?: boolean;
  mode?: 'lexical' | 'semantic' | 'hybrid';
}

export interface SavedSnippetRef {
  id: string;
  title: string;
  parentId?: string;
  parentTitle?: string;
}

/** One SEARCH/REPLACE change proposed by the model. */
export interface EditHunk {
  id: string;
  search: string;
  replace: string;
}

export interface EditTarget {
  snippetId: string;
  /** Snippet title at proposal time (the snippet may be renamed or deleted later). */
  title: string;
  /** Hash of the snippet's code when the proposal was made. */
  baseHash: string;
  hunks: EditHunk[];
  /** pending: awaiting review. applied: written to the original snippet. saved: written as a new version. */
  state: 'pending' | 'applied' | 'saved' | 'dismissed';
  acceptedHunkIds?: string[];
  /** For 'saved': the new version's snippet id. */
  resultSnippetId?: string;
  /** For 'applied': the code before the edit and a hash of the code after it, to support Undo. */
  preImage?: string;
  postHash?: string;
  resolvedAt?: number;
}

export interface EditProposal {
  targets: EditTarget[];
  /** Problems found while reading the reply (unterminated blocks, unknown targets). */
  issues: string[];
  /** 0 for the first answer, 1+ for automatic follow-ups that re-send blocks which did not match. */
  attempt: number;
}

/** Measured by the local runtime for one reply (all fields optional: runtimes report different subsets). */
export interface GenerationStats {
  /** Tokens the runtime evaluated for the prompt. With prompt-cache reuse this can be lower than the prompt size. */
  promptTokens?: number;
  /** Tokens generated, including reasoning tokens. */
  completionTokens?: number;
  tokensPerSecond?: number;
  /** Time spent loading the model into memory (0 when it was already resident). */
  loadMs?: number;
  /** Time spent evaluating the (non-cached part of the) prompt. */
  promptEvalMs?: number;
}

/** Rolling memory note that replaces older turns once a chat outgrows its history budget. */
export interface ConversationSummary {
  text: string;
  /** Messages up to and including this id are represented by `text` and no longer replayed. */
  coversUpToMessageId: string;
  updatedAt: number;
  model?: string;
  /** True once the user edited the note by hand. */
  edited?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Exact attached-context text that was sent with this user message. It is replayed byte-for-byte
   * on later turns so the runtime can reuse its prompt cache instead of re-reading the whole chat.
   */
  sentContext?: string;
  /** Measured generation stats for an assistant reply. */
  stats?: GenerationStats;
  /** Edits proposed in this assistant reply, awaiting review (Edit mode). */
  edits?: EditProposal;
  thinking?: string;
  model?: string;
  createdAt: number;
  durationMs?: number;
  attachments?: ChatAttachmentRef[];
  /** Summary of project files/search hits/map automatically or explicitly included on this turn. */
  workspaceContext?: WorkspaceContextUse;
  actionKind?: SnippetActionKind;
  savedSnippets?: SavedSnippetRef[];
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  /** True when the user explicitly renamed this session, preventing auto-naming from overwriting it. */
  titleLocked?: boolean;
  messages: ChatMessage[];
  /** Optional local project folder attached to this coding chat. */
  workspace?: ChatWorkspace;
  /** Condensed memory of the oldest turns (see ConversationSummary). */
  summary?: ConversationSummary;
  createdAt: number;
  updatedAt: number;
}

export interface LocalRuntimeConfig {
  kind: RuntimeKind;
  baseUrl: string;
  selectedModel: string;
  temperature: number;
  maxTokens: number;
  /** Context window requested from local runtimes such as Ollama (num_ctx). */
  contextTokens?: number;
  /**
   * Reasoning ("thinking") mode for Ollama models that support it, such as Gemma 4.
   * 'auto' lets the model decide (best quality, slow on CPU); 'off' sends `think: false`.
   */
  reasoning?: 'auto' | 'off';
  /**
   * How long Ollama keeps the model loaded after a reply (`keep_alive`). 0 unloads immediately;
   * undefined leaves Ollama's own default (5 minutes). Ollama only.
   */
  keepAliveMinutes?: number;
  /** Condense the oldest turns into a summary note when a chat outgrows its history budget. Default on. */
  autoCompact?: boolean;
  /** Optional Ollama embedding model tag (for example `embeddinggemma`) for semantic project search. */
  embeddingModel?: string;
  systemPrompt: string;
}

export interface GemmaModelInfo {
  id: string;
  name: string;
  family: 'gemma4' | 'gemma3n' | 'gemma3' | 'gemma2' | 'codegemma' | 'gemma' | 'other';
  parameterLabel: string;
  sizeBytes?: number;
  quantization?: string;
  rankScore: number;
}

export interface VaultSecurityMeta {
  id: 'primary';
  encryptionEnabled: boolean;
  saltBase64: string;
  verifierCipherBase64: string;
  verifierIvBase64: string;
  iterations: number;
  autoLockMinutes: number;
  updatedAt: number;
}

export interface EncryptedEnvelope {
  id: string;
  encrypted: true;
  iv: string;
  ciphertext: string;
  aad?: string;
  /** Schema version: 2 requires AAD bound to storeName + record id. */
  v?: number;
  updatedAt: number;
}

export interface VaultBackupBundle {
  format: 'gemmavault-backup-v1';
  exportedAt: number;
  encrypted: boolean;
  securityMeta?: VaultSecurityMeta;
  payload: string;
  iv?: string;
  aad?: string;
}
