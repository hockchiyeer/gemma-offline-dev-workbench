import React, { useMemo, useState } from 'react';
import { BookmarkPlus, Check, Copy } from 'lucide-react';
import { normalizeLanguage, tokenizeLine, type TokenType } from '../lib/syntax';
import type { SupportedLanguage } from '../types/vault';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  onSaveSnippet?: (code: string, language: SupportedLanguage) => void;
}

const TOKEN_CLASSES: Record<TokenType, string> = {
  plain: 'text-slate-800 dark:text-slate-200',
  keyword: 'text-teal-700 dark:text-teal-400 font-medium',
  type: 'text-sky-700 dark:text-sky-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-amber-700 dark:text-amber-300',
  comment: 'text-slate-400 dark:text-slate-500 italic',
  operator: 'text-slate-500 dark:text-slate-400',
  function: 'text-indigo-700 dark:text-indigo-300',
};

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  showLineNumbers = true,
  onSaveSnippet,
}) => {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const normalizedLang = useMemo(() => normalizeLanguage(language), [language]);
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback ignored if clipboard blocked
    }
  };

  const handleSave = () => {
    if (!onSaveSnippet) return;
    onSaveSnippet(code, normalizedLang);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-[#0D1424]">
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-3.5 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <div className="flex items-center gap-2 font-mono">
          <span className="font-medium text-slate-700 dark:text-slate-300">{normalizedLang}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{lines.length} lines</span>
        </div>
        <div className="flex items-center gap-1.5">
          {onSaveSnippet && (
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200/70 hover:text-slate-900 whitespace-nowrap shrink-0 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              {saved ? <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
              {saved ? 'Saved' : 'Save Snippet'}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200/70 hover:text-slate-900 whitespace-nowrap shrink-0 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto p-3.5 font-mono text-[13px] leading-6">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => {
              const tokens = tokenizeLine(line, normalizedLang);
              return (
                <tr key={index} className="align-top">
                  {showLineNumbers && (
                    <td className="w-9 select-none pr-4 text-right text-xs text-slate-400 tabular-nums dark:text-slate-600">
                      {index + 1}
                    </td>
                  )}
                  <td className="whitespace-pre">
                    {tokens.length === 0 ? (
                      <span> </span>
                    ) : (
                      tokens.map((tok, tIdx) => (
                        <span key={tIdx} className={TOKEN_CLASSES[tok.type]}>
                          {tok.value}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
