import React, { useEffect, useRef, useState } from 'react';
import { Code2 } from 'lucide-react';
import type { ChatAttachmentRef, ChatMessage } from '../types/vault';

export interface ConversationTurnItem {
  id: string;
  index: number;
  shortLabel: string;
  tooltipPreview: string;
  truncated: boolean;
  createdAt: number;
  attachments?: ChatAttachmentRef[];
}

export const MAX_TOOLTIP_CHARS = 220;

export function buildTurnPreview(
  content: string,
  maxChars = MAX_TOOLTIP_CHARS
): { text: string; truncated: boolean } {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { text: '(empty prompt)', truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  const slice = normalized.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd() || normalized.slice(0, maxChars);
  return { text: `${slice}...`, truncated: true };
}

export function extractConversationTurns(messages: ChatMessage[]): ConversationTurnItem[] {
  const turns: ConversationTurnItem[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const singleLine = msg.content.replace(/\s+/g, ' ').trim();
    const shortLabel = singleLine
      ? singleLine.length > 34
        ? `${singleLine.slice(0, 34).trimEnd()}...`
        : singleLine
      : msg.attachments?.[0]?.title || 'Prompt';
    const preview = buildTurnPreview(msg.content);
    turns.push({
      id: msg.id,
      index: turns.length + 1,
      shortLabel,
      tooltipPreview: preview.text,
      truncated: preview.truncated,
      createdAt: msg.createdAt,
      attachments: msg.attachments,
    });
  }
  return turns;
}

interface ChatThreadJumpRailProps {
  turns: ConversationTurnItem[];
  activeTurnId: string | null;
  onJumpToTurn: (messageId: string) => void;
  /** Optional initial state overrides (primarily for SSR / tests). */
  defaultExpanded?: boolean;
  defaultHoveredId?: string | null;
}

export const ChatThreadJumpRail: React.FC<ChatThreadJumpRailProps> = ({
  turns,
  activeTurnId,
  onJumpToTurn,
  defaultExpanded = false,
  defaultHoveredId = null,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [hoveredId, setHoveredId] = useState<string | null>(defaultHoveredId);
  const [hoveredTop, setHoveredTop] = useState<number>(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setExpanded(false);
        setHoveredId(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        setHoveredId(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  if (turns.length === 0) return null;

  const effectiveActiveId = activeTurnId || turns[turns.length - 1]?.id || null;
  const hoveredTurn = hoveredId ? turns.find((t) => t.id === hoveredId) || null : null;

  const openRail = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setExpanded(true);
  };

  const scheduleCloseRail = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setExpanded(false);
      setHoveredId(null);
      closeTimerRef.current = null;
    }, 120);
  };

  const handleRowHover = (turnId: string, el: HTMLElement | null) => {
    setHoveredId(turnId);
    if (!el) return;
    const navEl = navRef.current;
    const rawTop = el.offsetTop - (navEl?.scrollTop || 0);
    const maxTop = navEl ? Math.max(0, navEl.clientHeight - 72) : rawTop;
    setHoveredTop(Math.max(0, Math.min(rawTop, maxTop)));
  };

  return (
    <div
      ref={rootRef}
      onMouseEnter={openRail}
      onMouseLeave={scheduleCloseRail}
      className="pointer-events-none absolute top-3 right-2 bottom-3 z-20 flex items-center sm:right-3"
    >
      <div className="pointer-events-auto relative flex items-center">
        {/* Conversation content [...] tooltip popping out beside the hovered row */}
        {expanded && hoveredTurn && (
          <div
            role="tooltip"
            id={`turn-tooltip-${hoveredTurn.id}`}
            style={{ top: hoveredTop }}
            className="pointer-events-none absolute right-full mr-2.5 hidden w-72 max-w-[min(18rem,calc(100vw-16rem))] rounded-xl border border-slate-700/80 bg-slate-900/95 px-3.5 py-2.5 text-xs leading-relaxed text-slate-100 shadow-2xl backdrop-blur-md sm:block dark:border-slate-600/80 dark:bg-slate-950/95"
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-slate-400">
              <span>Turn {hoveredTurn.index}</span>
              <span className="tabular-nums">
                {new Date(hoveredTurn.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            {hoveredTurn.attachments && hoveredTurn.attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {hoveredTurn.attachments.map((att) => (
                  <span
                    key={`${att.kind}-${att.id}`}
                    className="inline-flex max-w-full items-center gap-1 truncate rounded bg-teal-500/20 px-1.5 py-0.5 font-mono text-[10px] text-teal-300"
                  >
                    <Code2 className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{att.title}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="line-clamp-4 whitespace-pre-wrap break-words text-[12px] text-slate-100">
              {hoveredTurn.tooltipPreview}
            </p>
          </div>
        )}

        {/* Expanded jump chip popover */}
        {expanded ? (
          <nav
            ref={navRef}
            aria-label="Conversation turn navigator"
            className="max-h-[60vh] w-56 overflow-y-auto rounded-2xl border border-slate-200/90 bg-white/95 p-1.5 shadow-xl backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-900/95"
          >
            <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
              Chat Turns ({turns.length})
            </div>
            <ul className="space-y-0.5">
              {turns.map((turn) => {
                const isActive = turn.id === effectiveActiveId;
                const isHovered = turn.id === hoveredId;
                return (
                  <li key={turn.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onJumpToTurn(turn.id);
                        setExpanded(false);
                        setHoveredId(null);
                      }}
                      onMouseEnter={(e) => handleRowHover(turn.id, e.currentTarget)}
                      onFocus={(e) => handleRowHover(turn.id, e.currentTarget)}
                      onBlur={() => {
                        if (hoveredId === turn.id) setHoveredId(null);
                      }}
                      aria-current={isActive ? 'location' : undefined}
                      aria-describedby={isHovered ? `turn-tooltip-${turn.id}` : undefined}
                      title={`${turn.index}) ${turn.tooltipPreview}`}
                      className={`group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                        isActive
                          ? 'bg-teal-500/10 font-medium text-teal-700 dark:text-teal-300'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/80 dark:hover:text-white'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="mr-1 tabular-nums opacity-70">{turn.index})</span>
                        {turn.shortLabel}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`shrink-0 rounded-full transition-all ${
                          isActive
                            ? 'h-[3px] w-3.5 bg-teal-500'
                            : 'h-[2px] w-2.5 bg-slate-300 group-hover:w-3 group-hover:bg-slate-500 dark:bg-slate-600 dark:group-hover:bg-slate-400'
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : (
          /* Resting right-edge dash/tick rail */
          <div
            role="navigation"
            aria-label="Conversation turns quick jump"
            className="flex max-h-[60vh] flex-col items-end gap-1.5 overflow-y-auto rounded-full py-1.5 pl-2 pr-0.5"
          >
            {turns.map((turn) => {
              const isActive = turn.id === effectiveActiveId;
              return (
                <button
                  key={turn.id}
                  type="button"
                  onClick={() => {
                    // On touch/mobile devices where hover isn't triggered, tapping opens the jump chip;
                    // on desktop, hovering already expanded the list above.
                    setExpanded(true);
                    setHoveredId(turn.id);
                    onJumpToTurn(turn.id);
                  }}
                  onFocus={openRail}
                  aria-label={`Jump to turn ${turn.index}: ${turn.shortLabel}`}
                  title={`${turn.index}) ${turn.tooltipPreview}`}
                  className="group flex h-3 cursor-pointer items-center justify-end px-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 rounded-sm"
                >
                  <span
                    className={`block rounded-full transition-all ${
                      isActive
                        ? 'h-[3px] w-3.5 bg-teal-500 shadow-[0_0_6px_rgba(20,184,166,0.55)]'
                        : 'h-[2px] w-2.5 bg-slate-400/55 group-hover:w-3.5 group-hover:bg-slate-600 dark:bg-slate-500/55 dark:group-hover:bg-slate-300'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
