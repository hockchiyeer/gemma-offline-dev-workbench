import type { SymbolHit, SymbolKind } from '../../src/types/workspace.ts';

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
  /** capture group holding the name */
  name: number;
}

const TS: Pattern[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, kind: 'const', name: 1 },
];
const PY: Pattern[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
];
const GO: Pattern[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct', name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface', name: 1 },
];
const RUST: Pattern[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', name: 1 },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'module', name: 1 },
];
const JAVAISH: Pattern[] = [
  { re: /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial|data)\s+)*(?:class|record|object)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z_]\w*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual|suspend)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'method', name: 1 },
  { re: /^\s*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, kind: 'function', name: 1 },
];
const SQL: Pattern[] = [
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: 'module', name: 1 },
];
const MD: Pattern[] = [{ re: /^#{1,3}\s+(.+?)\s*#*$/, kind: 'module', name: 1 }];
const SH: Pattern[] = [{ re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function', name: 1 }];

const BY_LANG: Record<string, Pattern[]> = {
  typescript: TS, javascript: TS, python: PY, go: GO, rust: RUST,
  java: JAVAISH, kotlin: JAVAISH, csharp: JAVAISH, cpp: JAVAISH.slice(0, 3),
  sql: SQL, markdown: MD, bash: SH,
};

const KEYWORD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'function', 'constructor']);

export function extractSymbols(relPath: string, language: string, content: string): SymbolHit[] {
  const patterns = BY_LANG[language];
  if (!patterns) return [];
  const out: SymbolHit[] = [];
  const lines = content.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const line = lines[i];
    if (language === 'markdown' && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || line.length > 400) continue;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const name = m[p.name]?.trim();
      if (!name || KEYWORD_NAMES.has(name)) continue;
      out.push({
        name,
        kind: p.kind,
        path: relPath,
        line: i + 1,
        signature: line.trim().replace(/\s*\{\s*$/, '').slice(0, 140),
      });
      break;
    }
  }
  return out;
}

/** Relative import specifiers found in a file (used to rank files by how many others depend on them). */
export function extractImports(language: string, content: string): string[] {
  const specs = new Set<string>();
  if (language === 'typescript' || language === 'javascript') {
    for (const m of content.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) specs.add(m[1]);
  } else if (language === 'python') {
    for (const m of content.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm)) specs.add(m[1] || m[2]);
  } else if (language === 'go' || language === 'java' || language === 'kotlin' || language === 'rust') {
    for (const m of content.matchAll(/(?:import|use)\s+"?([\w./:]+)"?/g)) specs.add(m[1]);
  }
  return [...specs].slice(0, 80);
}
