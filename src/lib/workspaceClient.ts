import type {
  EmbeddingSetting,
  FileListResult,
  FileRead,
  GitOp,
  GitResult,
  RepoMapResult,
  SearchMode,
  SearchResult,
  SymbolHit,
  TreeEntry,
  WorkspaceInfo,
} from '../types/workspace';

export async function probeWorkspaceAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/workspace/status', { signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { available?: unknown };
    return json.available === true;
  } catch {
    return false;
  }
}

export class WorkspaceConnection {
  readonly root: string;
  private readonly embedding: EmbeddingSetting | null;

  constructor(root: string, embedding: EmbeddingSetting | null = null) {
    this.root = root;
    this.embedding = embedding;
  }

  private async call<T>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`/api/workspace/${op}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GemmaVault-Workspace': '1',
      },
      body: JSON.stringify({ root: this.root, ...body }),
      signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const msg =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `Workspace ${op} failed (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  open(signal?: AbortSignal): Promise<WorkspaceInfo> {
    return this.call<WorkspaceInfo>('open', { embedding: this.embedding }, signal);
  }

  close(): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('close', {});
  }

  info(signal?: AbortSignal): Promise<WorkspaceInfo> {
    return this.call<WorkspaceInfo>('info', { embedding: this.embedding }, signal);
  }

  files(query: string, limit = 8, signal?: AbortSignal): Promise<FileListResult> {
    return this.call<FileListResult>('files', { query, limit }, signal);
  }

  tree(dir = '', depth = 2, signal?: AbortSignal): Promise<TreeEntry[]> {
    return this.call<TreeEntry[]>('tree', { dir, depth }, signal);
  }

  read(path: string, startLine?: number, endLine?: number, signal?: AbortSignal): Promise<FileRead> {
    return this.call<FileRead>('read', { path, startLine, endLine }, signal);
  }

  symbols(query: string, limit = 6, signal?: AbortSignal): Promise<SymbolHit[]> {
    return this.call<SymbolHit[]>('symbols', { query, limit }, signal);
  }

  search(
    query: string,
    mode: SearchMode = 'hybrid',
    limit = 6,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    return this.call<SearchResult>(
      'search',
      { query, mode, limit, embedding: this.embedding },
      signal
    );
  }

  repoMap(maxTokens = 800, focus: string[] = [], signal?: AbortSignal): Promise<RepoMapResult> {
    return this.call<RepoMapResult>('map', { maxTokens, focus }, signal);
  }

  git(gitOp: GitOp, signal?: AbortSignal): Promise<GitResult> {
    return this.call<GitResult>('git', { gitOp }, signal);
  }
}
