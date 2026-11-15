import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import {
  extractFencedCodeBlocks,
  extractSnippetSnapshotFromSentContext,
  shouldAutoSaveChildSnippets,
} from '../src/lib/snippetLineage.ts';

test('extractFencedCodeBlocks ignores a fence that never closes (truncated reply)', () => {
  const truncated = 'Refactor:\n```ts\nexport async function seal(\n  secret: string,\n  payl';
  assert.deepEqual(extractFencedCodeBlocks(truncated), []);
});

test('extractFencedCodeBlocks keeps closed blocks and drops only the unclosed tail', () => {
  const md = '```ts\nconst a = 1;\n```\ntext\n```ts\nconst b = ';
  const blocks = extractFencedCodeBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'const a = 1;');
});

test('extractFencedCodeBlocks still handles ~~~ fences and longer fences', () => {
  const md = '~~~py\nprint(1)\n~~~\n````md\n```inner```\n````';
  assert.equal(extractFencedCodeBlocks(md).length, 2);
});

test('explain replies are not auto-saved as child snippets; code-producing actions are', () => {
  assert.equal(shouldAutoSaveChildSnippets('explain'), false);
  for (const k of ['debug', 'refactor', 'expand', 'unit-tests', 'chat'] as const) {
    assert.equal(shouldAutoSaveChildSnippets(k), true, k);
  }
});

test('extractSnippetSnapshotFromSentContext recovers the fenced snippet snapshot matching attachment title', () => {
  const sentContext = [
    'Attached Local Vault Context:',
    '--- SNIPPET: Auth Helper (typescript) ---',
    '```typescript',
    'export function verify() { return true; }',
    '```',
    '',
    '--- DOCUMENTATION: Auth Spec ---',
    'Always check expiry.',
  ].join('\n');

  const snap = extractSnippetSnapshotFromSentContext(sentContext, 'Auth Helper');
  assert.ok(snap);
  assert.equal(snap.language, 'typescript');
  assert.equal(snap.code, 'export function verify() { return true; }');
  assert.equal(snap.truncated, false);
  assert.equal(extractSnippetSnapshotFromSentContext(sentContext, 'Missing Snippet'), null);
});

test('GemmaAssistantPane renders expandable source snippet hyperlinks and dustbin deleted indicators', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions: [
          {
            id: 'chat-1',
            projectId: 'proj-core',
            title: 'Test session',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              {
                id: 'msg-1',
                role: 'user',
                content: 'Refactor this snippet',
                createdAt: 1,
                sentContext:
                  'Attached Local Vault Context:\n--- SNIPPET: Removed With Snapshot (python) ---\n```python\ndef old_fn():\n    return 42\n```',
                attachments: [
                  { kind: 'snippet', id: 'snip-live', title: 'Old Title' },
                  { kind: 'snippet', id: 'snip-gone', title: 'Removed Snippet' },
                  { kind: 'snippet', id: 'snip-snap', title: 'Removed With Snapshot' },
                  { kind: 'doc', id: 'doc-1', title: 'Architecture Doc' },
                ],
              },
              {
                id: 'msg-2',
                role: 'assistant',
                content: 'Done.',
                createdAt: 2,
                savedSnippets: [
                  { id: 'snip-child-live', title: 'v2 Refactor · Live Renamed Snippet' },
                  { id: 'snip-child-gone', title: 'v2 Refactor · Deleted Child' },
                ],
              },
            ],
          },
        ],
        activeSessionId: 'chat-1',
        onSelectSession: () => {},
        onCreateSession: () => {},
        onUpdateSession: () => {},
        onDeleteSession: async () => {},
        snippets: [
          {
            id: 'snip-live',
            projectId: 'proj-core',
            title: 'Live Renamed Snippet',
            language: 'typescript',
            code: 'export const ok = true;',
            notes: '',
            tags: [],
            favorite: false,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: 'snip-child-live',
            projectId: 'proj-core',
            title: 'v2 Refactor · Live Renamed Snippet',
            language: 'typescript',
            code: 'export const ok = true;',
            notes: '',
            tags: [],
            favorite: false,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        docs: [],
        runtimeConfig: {
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          selectedModel: 'gemma4:e4b',
          temperature: 0.25,
          maxTokens: 2048,
          contextTokens: 8192,
          systemPrompt: 'System',
        },
        probe: {
          connected: true,
          transport: 'proxy',
          models: [],
          recommendedModel: null,
        },
        probing: false,
        onRescanRuntime: async () => {},
        onOpenRuntimeModal: () => {},
        onSaveSnippetFromCode: async () => {},
        onSaveGeneratedSnippets: async () => [],
        onOpenSnippet: () => {},
        onClearQueuedPrompt: () => {},
      })
    )
  );

  assert.ok(html.includes('aria-label="Open snippet Live Renamed Snippet in Snippets tab"'));
  assert.ok(html.includes('aria-label="Expand full code for Live Renamed Snippet"'));
  assert.ok(html.includes('View code'));
  assert.ok(html.includes('@snippet:Live Renamed Snippet'));
  assert.ok(html.includes('title="Open &quot;Live Renamed Snippet&quot; in Snippets (attached as &quot;Old Title&quot;)"'));
  assert.ok(html.includes('aria-label="Deleted snippet"'));
  assert.ok(html.includes('@snippet:Removed Snippet'));
  assert.ok(html.includes('Deleted'));
  assert.ok(html.includes('View snapshot'));
  assert.ok(html.includes('v2 Refactor · Deleted Child'));
  assert.ok(html.includes('@doc:Architecture Doc'));
});
