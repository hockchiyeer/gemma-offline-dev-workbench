import { normalizeLanguage } from './syntax';
import type { CodeSnippet, SnippetActionKind, SupportedLanguage } from '../types/vault';

export interface ExtractedCodeBlock {
  code: string;
  language: SupportedLanguage;
  rawLanguage: string;
}

export interface SnippetTreeNode {
  snippet: CodeSnippet;
  depth: number;
  childCount: number;
  parentTitle?: string;
}

const ACTION_LABELS: Record<SnippetActionKind, string> = {
  explain: 'Explain',
  debug: 'Debug',
  refactor: 'Refactor',
  expand: 'Expand',
  'unit-tests': 'Unit Tests',
  chat: 'AI Variant',
};

export function formatActionLabel(kind?: SnippetActionKind): string {
  if (!kind) return 'Variant';
  return ACTION_LABELS[kind] || 'Variant';
}

/**
 * Extracts all non-empty fenced code blocks (```lang ... ``` or ~~~lang ... ~~~)
 * from a Markdown response produced by a local Gemma model.
 */
export function extractFencedCodeBlocks(markdown: string): ExtractedCodeBlock[] {
  if (!markdown) return [];
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: ExtractedCodeBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i].match(/^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)/);
    if (!openMatch) {
      i++;
      continue;
    }

    const fenceToken = openMatch[1];
    const fenceChar = fenceToken[0];
    const fenceLen = fenceToken.length;
    const rawLanguage = (openMatch[2] || '').trim();
    const closeRegex = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);

    const bodyLines: string[] = [];
    i++;
    while (i < lines.length && !closeRegex.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    // A fence that never closes means the reply was cut off (token limit, Stop, or network abort):
    // the code is incomplete, so it must not be saved as a new snippet version.
    const closed = i < lines.length && closeRegex.test(lines[i]);
    if (closed) {
      i++;
    }

    const code = bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
    if (closed && code.trim().length > 0) {
      blocks.push({
        code,
        rawLanguage,
        language: normalizeLanguage(rawLanguage || 'typescript'),
      });
    }
  }

  return blocks;
}

/**
 * Whether a finished Gemma reply should be saved automatically as child snippets.
 * "Explain" replies typically quote illustrative fragments while explaining rather than
 * producing a new refined version of the code; those fragments can still be saved via
 * the code block's Save Snippet button.
 */
export function shouldAutoSaveChildSnippets(kind: SnippetActionKind): boolean {
  return kind !== 'explain';
}

export function inferActionKindFromPrompt(
  prompt: string,
  explicit?: SnippetActionKind
): SnippetActionKind {
  if (explicit) return explicit;
  const p = prompt.toLowerCase();
  if (p.includes('unit test') || p.includes('test suite') || p.includes('boundary conditions')) {
    return 'unit-tests';
  }
  if (p.includes('refactor') || p.includes('modularity')) {
    return 'refactor';
  }
  if (p.includes('bug') || p.includes('debug') || p.includes('audit') || p.includes('security flaw')) {
    return 'debug';
  }
  if (p.includes('implement or expand') || p.includes('expand this snippet') || p.includes('todo')) {
    return 'expand';
  }
  if (p.includes('explain how this snippet')) {
    return 'explain';
  }
  return 'chat';
}

export interface CreateChildSnippetsInput {
  parent: CodeSnippet;
  blocks: ExtractedCodeBlock[];
  actionKind: SnippetActionKind;
  prompt: string;
  model?: string;
  now?: number;
  makeId?: () => string;
}

/**
 * Creates one or more traceable child CodeSnippet entries beneath `parent`
 * from AI-generated code blocks, recording version, provenance, and prompt context.
 */
export function createChildSnippets({
  parent,
  blocks,
  actionKind,
  prompt,
  model,
  now = Date.now(),
  makeId = () => `snip-${crypto.randomUUID()}`,
}: CreateChildSnippetsInput): CodeSnippet[] {
  if (blocks.length === 0) return [];

  const nextVersion = (parent.version ?? 1) + 1;
  const actionLabel = formatActionLabel(actionKind);
  const actionTag = actionKind === 'chat' ? 'gemma-ai' : actionKind;
  const cleanTags = Array.from(new Set([...(parent.tags || []), actionTag]));
  const timestampText = new Date(now).toISOString();
  const promptSummary = prompt.trim().replace(/\s+/g, ' ').slice(0, 220);

  const baseParentTitle =
    parent.title.replace(/^v\d+\s+[^·]+·\s*/i, '').trim() || parent.title;

  return blocks.map((block, index) => {
    const partSuffix = blocks.length > 1 ? ` (${index + 1}/${blocks.length})` : '';
    const title = `v${nextVersion} ${actionLabel}${partSuffix} · ${baseParentTitle}`;
    const noteLines = [
      `Derived via ${actionLabel} from "${parent.title}" (v${parent.version ?? 1})`,
      model ? `Model: ${model}` : '',
      `Captured: ${timestampText}`,
      promptSummary ? `Prompt: ${promptSummary}` : '',
    ].filter(Boolean);

    return {
      id: makeId(),
      projectId: parent.projectId,
      parentId: parent.id,
      derivedAction: actionKind,
      version: nextVersion,
      title,
      language: block.rawLanguage ? block.language : parent.language,
      code: block.code,
      notes: noteLines.join('\n'),
      tags: cleanTags,
      favorite: false,
      createdAt: now + index,
      updatedAt: now + index,
    };
  });
}

/**
 * Orders a list of (possibly filtered) snippets into a depth-first hierarchy
 * where child snippets appear immediately beneath their parent in chronological
 * creation order (`createdAt` ascending). Orphans whose parent is absent from
 * `visibleSnippets` (e.g. due to a filter or deleted ancestor) are promoted safely
 * to top level while preserving their `parentTitle` when found in `allSnippets`.
 */
export function buildSnippetTree(
  visibleSnippets: CodeSnippet[],
  allSnippets: CodeSnippet[] = visibleSnippets
): SnippetTreeNode[] {
  const visibleMap = new Map<string, CodeSnippet>();
  const allMap = new Map<string, CodeSnippet>();
  for (const s of allSnippets) {
    allMap.set(s.id, s);
  }
  for (const s of visibleSnippets) {
    visibleMap.set(s.id, s);
  }

  const childrenByParent = new Map<string, CodeSnippet[]>();
  const roots: CodeSnippet[] = [];

  for (const s of visibleSnippets) {
    if (s.parentId && s.parentId !== s.id && visibleMap.has(s.parentId)) {
      const list = childrenByParent.get(s.parentId);
      if (list) {
        list.push(s);
      } else {
        childrenByParent.set(s.parentId, [s]);
      }
    } else {
      roots.push(s);
    }
  }

  // Sort each parent's direct children chronologically so refined versions append beneath in order.
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
  }

  const totalChildCount = new Map<string, number>();
  for (const s of allSnippets) {
    if (s.parentId && s.parentId !== s.id) {
      totalChildCount.set(s.parentId, (totalChildCount.get(s.parentId) || 0) + 1);
    }
  }

  const result: SnippetTreeNode[] = [];
  const visited = new Set<string>();

  const walk = (snippet: CodeSnippet, depth: number) => {
    if (visited.has(snippet.id)) return;
    visited.add(snippet.id);

    const parent = snippet.parentId ? allMap.get(snippet.parentId) : undefined;
    result.push({
      snippet,
      depth,
      childCount: totalChildCount.get(snippet.id) || 0,
      parentTitle: parent?.title,
    });

    const kids = childrenByParent.get(snippet.id);
    if (kids) {
      for (const child of kids) {
        walk(child, depth + 1);
      }
    }
  };

  for (const root of roots) {
    walk(root, 0);
  }

  // Defensive pass in case of a cycle in malformed imported data.
  for (const s of visibleSnippets) {
    if (!visited.has(s.id)) {
      walk(s, 0);
    }
  }

  return result;
}
