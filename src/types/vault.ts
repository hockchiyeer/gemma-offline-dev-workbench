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

export interface CodeSnippet {
  id: string;
  projectId: string;
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
  kind: 'snippet' | 'doc';
  id: string;
  title: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  createdAt: number;
  durationMs?: number;
  attachments?: ChatAttachmentRef[];
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  messages: ChatMessage[];
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
