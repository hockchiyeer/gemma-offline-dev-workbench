import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVerifier,
  decryptText,
  deriveAesKey,
  encryptText,
  evaluatePassphraseStrength,
  generateSaltBase64,
  verifyKeyAgainstToken,
} from '../src/lib/crypto.ts';
import { parseBackupFile, sanitizeRuntimeConfig } from '../src/lib/db.ts';
import {
  THINKING_TOKEN_HEADROOM,
  buildGemmaMessages,
  classifyAndRankModel,
  isLoopbackBaseUrl,
  parseParamBillions,
  pickRecommendedModel,
} from '../src/lib/gemmaClient.ts';
import { createSaveQueue } from '../src/lib/saveQueue.ts';
import { analyzeCodeLocally, normalizeLanguage, tokenizeLine } from '../src/lib/syntax.ts';
import { sanitizeMarkdownHref } from '../src/components/MarkdownRenderer.tsx';

test('WebCrypto AES-256-GCM roundtrip with AAD binding and tamper detection', async () => {
  const salt = generateSaltBase64();
  const key = await deriveAesKey('correct-horse-battery-staple', salt, 10_000);
  const wrongKey = await deriveAesKey('wrong-passphrase-1234', salt, 10_000);

  const aad = 'gemmavault:snippets:snip-1';
  const sealed = await encryptText('const secret = 42;', key, aad);

  const decrypted = await decryptText(sealed.ciphertextBase64, sealed.ivBase64, key, aad);
  assert.equal(decrypted, 'const secret = 42;');

  // Wrong AAD must reject decryption
  await assert.rejects(() =>
    decryptText(sealed.ciphertextBase64, sealed.ivBase64, key, 'gemmavault:snippets:snip-2')
  );

  // Wrong key must reject decryption
  await assert.rejects(() =>
    decryptText(sealed.ciphertextBase64, sealed.ivBase64, wrongKey, aad)
  );

  const verifier = await createVerifier(key);
  assert.equal(
    await verifyKeyAgainstToken(key, verifier.verifierCipherBase64, verifier.verifierIvBase64),
    true
  );
  assert.equal(
    await verifyKeyAgainstToken(
      wrongKey,
      verifier.verifierCipherBase64,
      verifier.verifierIvBase64
    ),
    false
  );
});

test('Passphrase strength evaluator enforces minimum length', () => {
  assert.equal(evaluatePassphraseStrength('short').valid, false);
  assert.equal(evaluatePassphraseStrength('longenoughpass').valid, true);
  assert.equal(evaluatePassphraseStrength('Correct!Horse#2026').label, 'Strong passphrase');
});

test('Gemma ranking: newest generation wins at equal size, big older models can beat tiny new ones', () => {
  const rank = (n: string) => classifyAndRankModel(n).rankScore;
  assert.ok(rank('gemma4:31b') > rank('gemma4:26b'));
  assert.ok(rank('gemma4:26b') > rank('gemma4:12b'));
  assert.ok(rank('gemma4:12b') > rank('gemma3:27b'), 'Gemma 4 12B is Gemma 3 27B class');
  assert.ok(rank('gemma4:12b') > rank('gemma3:12b'));
  assert.ok(rank('gemma3:27b') > rank('gemma4:e2b'));
  assert.ok(rank('gemma4:e4b') > rank('gemma4:e2b'));
  assert.equal(rank('gemma4'), rank('gemma4:e4b'), 'bare gemma4 aliases to E4B');
  assert.ok(rank('gemma3:27b') > rank('gemma2:27b'));
  assert.ok(rank('gemma2:27b') > rank('codegemma:7b'));
  assert.ok(rank('gemma5:12b') > rank('gemma4:12b'), 'future generations rank automatically');
  assert.equal(classifyAndRankModel('gemma4:e4b').family, 'gemma4');
  assert.equal(classifyAndRankModel('gemma3n:e4b').family, 'gemma3n');
  assert.equal(classifyAndRankModel('hf.co/x/gemma-3-12b-it-GGUF:Q4_K_M').family, 'gemma3');
  assert.equal(classifyAndRankModel('llama3.2:3b').rankScore, 0);
  assert.deepEqual(parseParamBillions('gemma4:e4b'), { label: 'E4B', billions: 4 });
  assert.deepEqual(parseParamBillions('gemma4:31b'), { label: '31B', billions: 31 });
});

test('Embedding/safety Gemma variants are never auto-selected', () => {
  const models = ['embeddinggemma:300m', 'shieldgemma:2b', 'llama3.2:3b', 'gemma3:4b'].map((n) =>
    classifyAndRankModel(n)
  );
  assert.equal(pickRecommendedModel(models)?.id, 'gemma3:4b');
  const noChatGemma = ['embeddinggemma:300m', 'llama3.2:3b'].map((n) => classifyAndRankModel(n));
  assert.equal(pickRecommendedModel(noChatGemma)?.id, 'llama3.2:3b');
});

test('Loopback URL validator blocks remote and credentialed URLs', () => {
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost:1234'), true);
  assert.equal(isLoopbackBaseUrl('http://[::1]:11434'), true);
  assert.equal(isLoopbackBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(isLoopbackBaseUrl('http://user:pass@127.0.0.1:11434'), false);
  assert.equal(isLoopbackBaseUrl('ftp://localhost:21'), false);
});

test('Context budget builder supports token-window options and trims oversized attachments', () => {
  const bigCode = 'x'.repeat(20_000);
  const built = buildGemmaMessages(
    'You are a local coder.',
    [
      { id: '1', role: 'user', content: 'a'.repeat(12_000), createdAt: 1 },
      { id: '2', role: 'assistant', content: 'b'.repeat(6_000), createdAt: 2 },
      { id: '3', role: 'user', content: 'Fix line 10', createdAt: 3 },
    ],
    [{ title: 'Huge Doc', kind: 'documentation', content: bigCode }],
    { contextTokens: 4096, reserveForReply: 1024 }
  );

  assert.equal(built.truncated, true);
  assert.equal(built.messages[0].role, 'system');
  assert.equal(built.messages[built.messages.length - 1].content, 'Fix line 10');

  // Reserving reply + thinking headroom on an 8192 window keeps system prompt + latest user turn
  // while skipping stale empty assistant placeholders.
  const withThinkingReserve = buildGemmaMessages(
    'System instruction.',
    [
      { id: '1', role: 'user', content: 'old question '.repeat(600), createdAt: 1 },
      { id: '2', role: 'assistant', content: '', createdAt: 2 },
      { id: '3', role: 'user', content: 'Latest prompt', createdAt: 3 },
    ],
    [],
    { contextTokens: 8192, reserveForReply: 2048 + THINKING_TOKEN_HEADROOM }
  );
  assert.equal(withThinkingReserve.truncated, true);
  assert.equal(withThinkingReserve.messages[0].content, 'System instruction.');
  assert.equal(
    withThinkingReserve.messages.some((m) => m.role === 'assistant' && !m.content),
    false
  );
  assert.equal(withThinkingReserve.messages[withThinkingReserve.messages.length - 1].content, 'Latest prompt');
});

test('SaveQueue coalesces rapid writes, cancels pending writes on now(), and surfaces errors', async () => {
  const errors: unknown[] = [];
  const queue = createSaveQueue(40, (err) => errors.push(err));
  const writes: string[] = [];

  queue.schedule('snip:1', async () => {
    writes.push('first');
  });
  queue.schedule('snip:1', async () => {
    writes.push('second');
  });
  queue.schedule('doc:1', async () => {
    writes.push('doc');
  });

  await queue.flushAll();
  assert.deepEqual(writes, ['second', 'doc']);
  assert.equal(queue.pendingCount(), 0);

  // Pending write canceled before delete via now() so deletes never resurrect stale drafts
  queue.schedule('snip:2', async () => {
    writes.push('resurrected');
  });
  await queue.now('snip:2', async () => {
    writes.push('deleted');
  });
  await queue.flushAll();
  assert.deepEqual(writes, ['second', 'doc', 'deleted']);

  // Failing tasks invoke onError instead of crashing future queued tasks
  await queue.now('snip:err', async () => {
    throw new Error('disk full');
  });
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /disk full/);
});

test('Syntax analyzer extracts symbols and checks bracket balance', () => {
  const tokens = tokenizeLine('const x = 42; // test', 'typescript');
  assert.equal(tokens[0].type, 'keyword');
  assert.equal(normalizeLanguage('py'), 'python');

  const ok = analyzeCodeLocally('function greet() { return [1, 2]; }');
  assert.deepEqual(ok.symbols, ['greet']);
  assert.equal(ok.bracketsBalanced, true);

  const bad = analyzeCodeLocally('function broken() { return (1; }');
  assert.equal(bad.bracketsBalanced, false);
});

test('Markdown link sanitizer blocks javascript: and data: URLs while allowing safe links', () => {
  assert.equal(sanitizeMarkdownHref('https://ai.google.dev/gemma'), 'https://ai.google.dev/gemma');
  assert.equal(sanitizeMarkdownHref('#overview'), '#overview');
  assert.equal(sanitizeMarkdownHref('/docs/local'), '/docs/local');
  assert.equal(sanitizeMarkdownHref('javascript:alert(1)'), null);
  assert.equal(sanitizeMarkdownHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeMarkdownHref('//evil.example/phish'), null);
});

test('Backup parser and runtime config sanitizer enforce safe bounds', () => {
  assert.throws(() => parseBackupFile('not json'));
  assert.throws(() => parseBackupFile(JSON.stringify({ format: 'other' })));
  assert.throws(() =>
    parseBackupFile(
      JSON.stringify({
        format: 'gemmavault-backup-v1',
        exportedAt: 1,
        encrypted: true,
        payload: 'abc',
        iv: 'def',
        securityMeta: {
          saltBase64: 'aaa',
          verifierCipherBase64: 'bbb',
          verifierIvBase64: 'ccc',
          iterations: 50_000_000, // out-of-range DoS iteration count
        },
      })
    )
  );

  const validPlain = parseBackupFile(
    JSON.stringify({
      format: 'gemmavault-backup-v1',
      exportedAt: 123,
      encrypted: false,
      payload: '{}',
    })
  );
  assert.equal(validPlain.encrypted, false);

  const sanitized = sanitizeRuntimeConfig({
    kind: 'ollama',
    temperature: 99,
    maxTokens: 10,
    contextTokens: 999999,
  });
  assert.equal(sanitized.temperature, 2);
  assert.equal(sanitized.maxTokens, 64);
  assert.equal(sanitized.contextTokens, 262144);
});

test('SaveQueue maxWait: continuous updates (streaming) still reach the database', async () => {
  const queue = createSaveQueue(50, () => {}, 120);
  const writes: number[] = [];
  const t0 = Date.now();
  const iv = setInterval(
    () => queue.schedule('chat:1', async () => void writes.push(Date.now() - t0)),
    10
  );
  await new Promise((r) => setTimeout(r, 320));
  clearInterval(iv);
  const duringStream = writes.length;
  await queue.flushAll();
  assert.ok(duringStream >= 2, `expected periodic writes while streaming, got ${duringStream}`);
});
