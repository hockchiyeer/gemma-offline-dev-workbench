import type { SupportedLanguage } from '../types/vault';

export interface LanguageMeta {
  id: SupportedLanguage;
  label: string;
  extension: string;
}

export const SUPPORTED_LANGUAGES: LanguageMeta[] = [
  { id: 'typescript', label: 'TypeScript', extension: 'ts' },
  { id: 'javascript', label: 'JavaScript', extension: 'js' },
  { id: 'python', label: 'Python', extension: 'py' },
  { id: 'rust', label: 'Rust', extension: 'rs' },
  { id: 'go', label: 'Go', extension: 'go' },
  { id: 'cpp', label: 'C++', extension: 'cpp' },
  { id: 'java', label: 'Java', extension: 'java' },
  { id: 'sql', label: 'SQL', extension: 'sql' },
  { id: 'bash', label: 'Bash', extension: 'sh' },
  { id: 'json', label: 'JSON', extension: 'json' },
  { id: 'html', label: 'HTML', extension: 'html' },
  { id: 'css', label: 'CSS', extension: 'css' },
  { id: 'markdown', label: 'Markdown', extension: 'md' },
  { id: 'yaml', label: 'YAML', extension: 'yml' },
];

export type TokenType =
  | 'plain'
  | 'keyword'
  | 'type'
  | 'string'
  | 'number'
  | 'comment'
  | 'operator'
  | 'function';

export interface CodeToken {
  type: TokenType;
  value: string;
}

const KEYWORDS_BY_LANG: Record<string, Set<string>> = {
  typescript: new Set([
    'import', 'export', 'from', 'default', 'async', 'await', 'function', 'const', 'let', 'var',
    'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch',
    'finally', 'throw', 'new', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
    'public', 'private', 'protected', 'readonly', 'typeof', 'keyof', 'as', 'in', 'of', 'true',
    'false', 'null', 'undefined', 'void',
  ]),
  javascript: new Set([
    'import', 'export', 'from', 'default', 'async', 'await', 'function', 'const', 'let', 'var',
    'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch',
    'finally', 'throw', 'new', 'class', 'extends', 'typeof', 'in', 'of', 'true', 'false', 'null',
    'undefined',
  ]),
  python: new Set([
    'import', 'from', 'as', 'def', 'async', 'await', 'return', 'yield', 'class', 'if', 'elif',
    'else', 'for', 'while', 'break', 'continue', 'try', 'except', 'finally', 'raise', 'with',
    'lambda', 'pass', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'self',
  ]),
  rust: new Set([
    'use', 'mod', 'pub', 'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait',
    'for', 'in', 'while', 'loop', 'if', 'else', 'match', 'return', 'async', 'await', 'move',
    'where', 'type', 'crate', 'self', 'Self', 'true', 'false', 'Some', 'None', 'Ok', 'Err',
  ]),
  go: new Set([
    'package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan',
    'go', 'defer', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'select',
    'break', 'continue', 'true', 'false', 'nil',
  ]),
  cpp: new Set([
    'include', 'define', 'namespace', 'using', 'class', 'struct', 'enum', 'template', 'typename',
    'public', 'private', 'protected', 'virtual', 'override', 'const', 'constexpr', 'auto', 'void',
    'int', 'long', 'double', 'float', 'bool', 'char', 'return', 'if', 'else', 'for', 'while',
    'switch', 'case', 'break', 'nullptr', 'true', 'false', 'new', 'delete',
  ]),
  java: new Set([
    'package', 'import', 'public', 'private', 'protected', 'class', 'interface', 'extends',
    'implements', 'static', 'final', 'void', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'this', 'super', 'true', 'false',
    'null',
  ]),
  sql: new Set([
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE',
    'TABLE', 'VIRTUAL', 'IF', 'NOT', 'EXISTS', 'INDEX', 'ON', 'CONFLICT', 'DO', 'JOIN', 'LEFT',
    'RIGHT', 'INNER', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'AS', 'AND', 'OR', 'USING',
    'PRAGMA', 'NULL', 'PRIMARY', 'KEY', 'MATCH', 'SELECT',
  ]),
  bash: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac',
    'function', 'return', 'local', 'export', 'source', 'echo', 'exit', 'cd', 'ls', 'grep', 'curl',
  ]),
};

export function normalizeLanguage(raw?: string): SupportedLanguage {
  const lower = (raw || '').toLowerCase().trim();
  const aliasMap: Record<string, SupportedLanguage> = {
    ts: 'typescript',
    tsx: 'typescript',
    typescript: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    javascript: 'javascript',
    py: 'python',
    python: 'python',
    rs: 'rust',
    rust: 'rust',
    go: 'go',
    golang: 'go',
    c: 'cpp',
    cpp: 'cpp',
    'c++': 'cpp',
    java: 'java',
    sql: 'sql',
    sqlite: 'sql',
    postgres: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    shell: 'bash',
    json: 'json',
    html: 'html',
    xml: 'html',
    css: 'css',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return aliasMap[lower] || 'typescript';
}

export function tokenizeLine(line: string, language: SupportedLanguage): CodeToken[] {
  const tokens: CodeToken[] = [];
  const keywords = KEYWORDS_BY_LANG[language] || KEYWORDS_BY_LANG.typescript;
  const isSql = language === 'sql';
  const usesHashComment =
    language === 'python' || language === 'bash' || language === 'yaml';
  const usesDashComment = language === 'sql';

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);

    // Comments
    if (
      (usesHashComment && rest.startsWith('#')) ||
      (usesDashComment && rest.startsWith('--')) ||
      (!usesHashComment && !usesDashComment && (rest.startsWith('//') || rest.startsWith('/*')))
    ) {
      tokens.push({ type: 'comment', value: rest });
      break;
    }

    // Strings
    if (rest[0] === '"' || rest[0] === "'" || rest[0] === '`') {
      const quote = rest[0];
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === '\\') {
          j += 2;
          continue;
        }
        if (rest[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      tokens.push({ type: 'string', value: rest.slice(0, j) });
      i += j;
      continue;
    }

    // Numbers
    const numMatch = rest.match(/^(?:0x[0-9a-fA-F]+|\d+(?:[._]\d+)*)/);
    if (numMatch && (i === 0 || !/[a-zA-Z0-9_]/.test(line[i - 1]))) {
      tokens.push({ type: 'number', value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    // Identifiers / Keywords / Types / Functions
    const wordMatch = rest.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      const nextChar = line[i + word.length];
      const keywordCheck = isSql ? word.toUpperCase() : word;

      if (keywords.has(keywordCheck)) {
        tokens.push({ type: 'keyword', value: word });
      } else if (nextChar === '(') {
        tokens.push({ type: 'function', value: word });
      } else if (/^[A-Z][a-zA-Z0-9_]*$/.test(word)) {
        tokens.push({ type: 'type', value: word });
      } else {
        tokens.push({ type: 'plain', value: word });
      }
      i += word.length;
      continue;
    }

    // Operators & punctuation
    const opMatch = rest.match(/^[=<>!+\-*/%&|^~?:;.,()[\]{}]+/);
    if (opMatch) {
      tokens.push({ type: 'operator', value: opMatch[0] });
      i += opMatch[0].length;
      continue;
    }

    // Whitespace or fallback character
    const spaceMatch = rest.match(/^\s+/);
    if (spaceMatch) {
      tokens.push({ type: 'plain', value: spaceMatch[0] });
      i += spaceMatch[0].length;
      continue;
    }

    tokens.push({ type: 'plain', value: rest[0] });
    i += 1;
  }

  return tokens;
}

export interface StaticCodeMetrics {
  lines: number;
  characters: number;
  symbols: string[];
  bracketsBalanced: boolean;
}

export function analyzeCodeLocally(code: string): StaticCodeMetrics {
  const lines = code ? code.split('\n').length : 0;
  const characters = code.length;

  const symbols: string[] = [];
  const symbolRegex =
    /(?:function|def|fn|func|class|struct|interface|type|enum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = symbolRegex.exec(code)) !== null) {
    if (!symbols.includes(match[1])) {
      symbols.push(match[1]);
    }
    if (symbols.length >= 12) break;
  }

  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let balanced = true;
  for (const ch of code) {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) {
        balanced = false;
        break;
      }
    }
  }
  if (stack.length > 0) balanced = false;

  return { lines, characters, symbols, bracketsBalanced: balanced };
}
