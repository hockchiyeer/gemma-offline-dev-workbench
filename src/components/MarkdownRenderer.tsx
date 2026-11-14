import React from 'react';
import { CodeBlock } from './CodeBlock';
import type { SupportedLanguage } from '../types/vault';

interface MarkdownRendererProps {
  content: string;
  onSaveSnippet?: (code: string, language: SupportedLanguage) => void;
}

export function sanitizeMarkdownHref(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={keyIdx++}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.875em] text-teal-800 dark:bg-slate-800 dark:text-teal-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={keyIdx++} className="font-semibold text-slate-900 dark:text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={keyIdx++} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const safeHref = sanitizeMarkdownHref(linkMatch[2]);
        if (safeHref) {
          const isExternal = /^https?:/i.test(safeHref);
          parts.push(
            <a
              key={keyIdx++}
              href={safeHref}
              target={isExternal ? '_blank' : undefined}
              rel={isExternal ? 'noopener noreferrer' : undefined}
              className="text-teal-700 underline underline-offset-2 hover:text-teal-600 dark:text-teal-400"
            >
              {linkMatch[1]}
            </a>
          );
        } else {
          parts.push(
            <span key={keyIdx++} className="text-slate-600 dark:text-slate-400">
              {linkMatch[1]}
            </span>
          );
        }
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  onSaveSnippet,
}) => {
  const blocks: React.ReactNode[] = [];
  const lines = content.split('\n');
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || 'typescript';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <CodeBlock
          key={blockKey++}
          code={codeLines.join('\n')}
          language={lang}
          onSaveSnippet={onSaveSnippet}
        />
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      const id = slugifyHeading(headingText);
      if (level === 1) {
        blocks.push(
          <h1
            key={blockKey++}
            id={id}
            className="mt-5 mb-3 text-xl font-semibold tracking-tight text-slate-900 first:mt-0 dark:text-white"
          >
            {renderInline(headingText)}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2
            key={blockKey++}
            id={id}
            className="mt-6 mb-2.5 border-b border-slate-200 pb-1.5 text-lg font-semibold tracking-tight text-slate-900 dark:border-slate-800 dark:text-slate-100"
          >
            {renderInline(headingText)}
          </h2>
        );
      } else {
        blocks.push(
          <h3
            key={blockKey++}
            id={id}
            className="mt-4 mb-2 text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            {renderInline(headingText)}
          </h3>
        );
      }
      i++;
      continue;
    }

    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      /^\s*\|[\s:-]+\|/.test(lines[i + 1])
    ) {
      const parseRow = (rowLine: string) =>
        rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={blockKey++} className="my-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/80">
                {headers.map((h, idx) => (
                  <th key={idx} className="px-3.5 py-2.5 font-medium text-slate-900 dark:text-slate-100">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-slate-50/70 dark:hover:bg-slate-900/40">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3.5 py-2.5 text-slate-700 dark:text-slate-300">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={blockKey++}
          className="my-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300"
        >
          {renderInline(quoteLines.join(' '))}
        </blockquote>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={blockKey++} className="my-2.5 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={blockKey++} className="my-2.5 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Always consume the current line. Lines that none of the block rules above accepted (e.g. a
    // table header whose separator row has not streamed in yet, "#!/bin/bash", "##### x") would
    // otherwise match none of the paragraph continuation rules below, leaving `i` unchanged and
    // spinning forever while pushing empty <p> elements until the tab runs out of memory.
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|')
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={blockKey++} className="my-2.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {renderInline(paraLines.join(' '))}
      </p>
    );
  }

  return <div className="max-w-none">{blocks}</div>;
};
