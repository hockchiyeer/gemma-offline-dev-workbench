/** Types shared by the workspace server (server/workspace/*) and the browser client. */

export interface EmbeddingSetting {
  /** Loopback Ollama base URL used for /api/embed. */
  baseUrl: string;
  model: string;
}

export interface WorkspaceInfo {
  rootPath: string;
  name: string;
  fileCount: number;
  chunkCount: number;
  totalBytes: number;
  /** True when the scan stopped at a safety limit (very large project). */
  truncated: boolean;
  isGit: boolean;
  indexedAt: number;
  watching?: boolean;
  source?: 'server' | 'browser';
  embeddings: {
    model: string;
    embedded: number;
    total: number;
    state: 'idle' | 'running' | 'error' | 'off';
    error?: string;
  };
}

export interface FileListItem {
  path: string;
  size: number;
  language: string;
}

export interface FileListResult {
  files: FileListItem[];
  dirs: string[];
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'method'
  | 'struct'
  | 'trait'
  | 'module';

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  signature: string;
}

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  via: 'lexical' | 'semantic' | 'both';
}

export interface SearchResult {
  hits: SearchHit[];
  /** What actually ran (semantic falls back to lexical when no vectors exist yet). */
  mode: SearchMode;
}

export interface FileRead {
  path: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  redactions: number;
}

export type GitOp = 'status' | 'diff';

export interface GitResult {
  op: GitOp;
  text: string;
  truncated: boolean;
}

export interface RepoMapResult {
  text: string;
  files: number;
  symbols: number;
}

export interface BrowseWorkspaceResult {
  supported: boolean;
  cancelled: boolean;
  path: string | null;
}
