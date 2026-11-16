import type { EmbeddingSetting, SearchMode } from '../../src/types/workspace.ts';
import { WorkspaceError } from './safety.ts';
import { isLoopbackHttpUrl, type WorkspaceManager } from './workspace.ts';

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseEmbedding(v: unknown): EmbeddingSetting | null {
  if (!v || typeof v !== 'object') return null;
  const { baseUrl, model } = v as { baseUrl?: unknown; model?: unknown };
  if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim()) return null;
  if (!isLoopbackHttpUrl(baseUrl)) throw new WorkspaceError('The embedding endpoint must be localhost.', 400);
  return { baseUrl, model: model.trim().slice(0, 120) };
}

export const WORKSPACE_OPS = ['browse', 'browse-cancel', 'open', 'close', 'info', 'files', 'tree', 'read', 'symbols', 'search', 'map', 'git'] as const;
export type WorkspaceOp = (typeof WORKSPACE_OPS)[number];

/** Transport-independent request handler. server.ts wires it to Express; tests call it directly. */
export async function handleWorkspaceOp(
  manager: WorkspaceManager,
  op: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const root = str(body.root);
  switch (op as WorkspaceOp) {
    case 'browse':
      return manager.browse(str(body.initialDir) || undefined, signal);
    case 'browse-cancel':
      return manager.cancelBrowse();
    case 'open':
      return manager.open(root, parseEmbedding(body.embedding));
    case 'close':
      manager.close(root);
      return { ok: true };
    case 'info':
      return manager.info(root, parseEmbedding(body.embedding));
    case 'files':
      return manager.files(root, str(body.query, 200), num(body.limit, 8));
    case 'tree':
      return manager.tree(root, str(body.dir, 500), num(body.depth, 2));
    case 'read':
      return manager.read(
        root,
        str(body.path, 1000),
        body.startLine === undefined ? undefined : num(body.startLine, 1),
        body.endLine === undefined ? undefined : num(body.endLine, 1)
      );
    case 'symbols':
      return manager.symbols(root, str(body.query, 200), num(body.limit, 6));
    case 'search': {
      const mode = (['lexical', 'semantic', 'hybrid'] as SearchMode[]).includes(body.mode as SearchMode)
        ? (body.mode as SearchMode)
        : 'hybrid';
      return manager.search(root, str(body.query, 2000), mode, num(body.limit, 6), parseEmbedding(body.embedding));
    }
    case 'map':
      return manager.repoMap(
        root,
        num(body.maxTokens, 800),
        Array.isArray(body.focus) ? body.focus.map((x) => str(x, 500)) : []
      );
    case 'git':
      return manager.git(root, body.gitOp === 'diff' ? 'diff' : 'status');
    default:
      throw new WorkspaceError('Unknown workspace operation.', 404);
  }
}
