import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import {
  extractFencedCodeBlocks,
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

test('GemmaAssistantPane renders attached source snippets as clickable hyperlinks and flags deleted ones', () => {
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
                attachments: [
                  { kind: 'snippet', id: 'snip-live', title: 'Old Title' },
                  { kind: 'snippet', id: 'snip-gone', title: 'Removed Snippet' },
                  { kind: 'doc', id: 'doc-1', title: 'Architecture Doc' },
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

  assert.ok(html.includes('<button'));
  assert.ok(html.includes('aria-label="Open snippet Live Renamed Snippet in Snippets tab"'));
  assert.ok(html.includes('@snippet:Live Renamed Snippet'));
  assert.ok(html.includes('title="Open &quot;Live Renamed Snippet&quot; in Snippets (attached as &quot;Old Title&quot;)"'));
  assert.ok(html.includes('@snippet:Removed Snippet'));
  assert.ok(html.includes('(deleted)'));
  assert.ok(html.includes('@doc:Architecture Doc'));
});
