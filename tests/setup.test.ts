import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendDirToPathValue,
  createSetupManager,
  ensureOllamaOnPath,
  isAllowedGemmaTag,
  isDirInPath,
  isExpectedOllamaSignerSubject,
  pullModel,
  recommendModel,
  toPosixPath,
  type SetupDeps,
} from '../server/ollamaSetup.ts';
import { createApp } from '../server.ts';

function fakeDeps(over: Partial<SetupDeps> = {}) {
  const calls: string[] = [];
  let installed = false;
  let serving = false;
  const models: string[] = [];
  const deps: SetupDeps = {
    platform: 'win32',
    totalMem: () => 16 * 2 ** 30,
    findBinary: () => (installed ? 'C:\\ollama.exe' : null),
    ensureOnPath: (binPath) => {
      calls.push(`path:${binPath}`);
      return {
        binDir: path.dirname(binPath),
        alreadyInProcessPath: true,
        addedToProcessPath: false,
        addedToUserEnv: false,
        updatedProfiles: [],
      };
    },
    listModels: async () => (serving ? [...models] : null),
    installOllama: async () => {
      calls.push('install');
      installed = true;
    },
    startServe: () => {
      calls.push('serve');
      serving = true;
    },
    pull: async (tag, onProgress) => {
      calls.push(`pull:${tag}`);
      onProgress('downloading', 50);
      models.push(tag);
    },
    sleep: async () => undefined,
    ...over,
  };
  return { deps, calls };
}

test('recommendModel stays conservative by RAM', () => {
  assert.equal(recommendModel(4 * 2 ** 30), 'gemma4:e2b');
  assert.equal(recommendModel(16 * 2 ** 30), 'gemma4:e4b');
  assert.equal(recommendModel(128 * 2 ** 30), 'gemma4:e4b');
});

test('only Gemma-family tags are accepted', () => {
  for (const ok of ['gemma4:e4b', 'gemma3:12b', 'codegemma:7b', 'gemma3n:e4b']) {
    assert.equal(isAllowedGemmaTag(ok), true, ok);
  }
  for (const bad of [
    'llama3:8b',
    'gemma4',
    'gemma4:e4b;rm -rf',
    '../gemma4:e4b',
    'x'.repeat(60) + 'gemma:1',
    5,
    undefined,
  ]) {
    assert.equal(isAllowedGemmaTag(bad), false, String(bad));
  }
});

test('fresh Windows machine: install → configure PATH → start service → pull Gemma', async () => {
  const { deps, calls } = fakeDeps();
  const final = await createSetupManager(deps).runToCompletion();
  assert.equal(final.phase, 'done');
  assert.deepEqual(calls, ['install', 'path:C:\\ollama.exe', 'serve', 'pull:gemma4:e4b']);
});

test('already installed and running: ensures PATH, pulls missing model, skips pull if present', async () => {
  const a = fakeDeps({ findBinary: () => 'C:\\ollama.exe', listModels: async () => [] });
  assert.equal((await createSetupManager(a.deps).runToCompletion('gemma4:e2b')).phase, 'done');
  assert.deepEqual(a.calls, ['path:C:\\ollama.exe', 'pull:gemma4:e2b']);

  const b = fakeDeps({ findBinary: () => 'C:\\ollama.exe', listModels: async () => ['gemma4:e4b'] });
  assert.equal((await createSetupManager(b.deps).runToCompletion('gemma4:e4b')).phase, 'done');
  assert.deepEqual(b.calls, ['path:C:\\ollama.exe']);
});

test('installer failure surfaces as an error and pulls nothing', async () => {
  const { deps, calls } = fakeDeps({
    installOllama: async () => {
      throw new Error('Installer signature check failed');
    },
  });
  const final = await createSetupManager(deps).runToCompletion();
  assert.equal(final.phase, 'error');
  assert.match(final.error || '', /signature/);
  assert.equal(calls.some((c) => c.startsWith('pull')), false);
});

test('non-Windows without Ollama gives a manual hint instead of guessing', async () => {
  const { deps } = fakeDeps({ platform: 'linux' });
  const final = await createSetupManager(deps).runToCompletion();
  assert.equal(final.phase, 'error');
  assert.match(final.manualHint || '', /ollama/i);
});

test('rejects non-Gemma models and concurrent runs', () => {
  const mgr = createSetupManager(fakeDeps({ pull: () => new Promise(() => undefined) }).deps);
  assert.throws(() => mgr.start('llama3:8b'), /Gemma/);
  mgr.start('gemma4:e4b');
  assert.throws(() => mgr.start('gemma4:e4b'), /already running/);
  mgr.cancel();
});

test('setup API: guarded by header and disabled when exposed beyond loopback', async () => {
  const run = async (allowSetup: boolean) => {
    const server = createApp({ allowSetup, setupManager: createSetupManager(fakeDeps().deps) }).listen(
      0,
      '127.0.0.1'
    );
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const noHeader = await fetch(`${base}/api/setup/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const ok = await fetch(`${base}/api/setup/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Setup': '1' },
        body: JSON.stringify({ model: 'gemma4:e2b' }),
      });
      const bad = await fetch(`${base}/api/setup/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Setup': '1' },
        body: JSON.stringify({ model: 'llama3:8b' }),
      });
      return [noHeader.status, ok.status, bad.status];
    } finally {
      server.close();
    }
  };
  assert.deepEqual(await run(false), [403, 403, 403]);
  const [noHeader, ok, bad] = await run(true);
  assert.equal(noHeader, 400);
  assert.equal(ok, 202);
  assert.equal(bad, 409);
});

test('pullModel parses a real chunked NDJSON stream and reports progress; surfaces errors', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    if (req.url === '/api/pull') {
      // Split a JSON line across chunk boundaries to exercise buffering.
      res.write('{"status":"pulling manifest"}\n{"status":"downloading","total":200,"comple');
      setTimeout(() => {
        res.write('ted":100}\n{"status":"success"}\n');
        res.end();
      }, 20);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen: Array<[string, number | null]> = [];
  await pullModel('gemma4:e4b', (s, p) => seen.push([s, p]), new AbortController().signal, base);
  assert.deepEqual(seen, [
    ['pulling manifest', null],
    ['downloading', 50],
    ['success', null],
  ]);
  server.close();

  const errServer = http.createServer((_q, res) =>
    res.end('{"error":"pull model manifest: file does not exist"}\n')
  );
  await new Promise<void>((r) => errServer.listen(0, '127.0.0.1', r));
  await assert.rejects(
    () =>
      pullModel(
        'gemma4:nope',
        () => undefined,
        new AbortController().signal,
        `http://127.0.0.1:${(errServer.address() as AddressInfo).port}`
      ),
    /does not exist/
  );
  errServer.close();
});

test('PATH helpers detect existing entries cleanly across separators, casing, and trailing slashes', () => {
  assert.equal(
    isDirInPath(
      'C:\\Users\\Dev\\AppData\\Local\\Programs\\Ollama',
      'C:\\Windows\\system32;"c:\\users\\dev\\appdata\\local\\programs\\ollama\\"',
      'win32'
    ),
    true
  );
  assert.equal(isDirInPath('C:\\Ollama', 'C:\\Windows\\system32', 'win32'), false);
  assert.equal(
    toPosixPath('C:\\Users\\Dev\\AppData\\Local\\Programs\\Ollama'),
    '/c/Users/Dev/AppData/Local/Programs/Ollama'
  );
  assert.deepEqual(appendDirToPathValue('C:\\Windows;', 'C:\\Ollama', 'win32'), {
    updated: 'C:\\Windows;C:\\Ollama',
    changed: true,
  });
  assert.deepEqual(appendDirToPathValue('C:\\Windows;c:\\ollama', 'C:\\Ollama', 'win32'), {
    updated: 'C:\\Windows;c:\\ollama',
    changed: false,
  });
});

test('ensureOllamaOnPath updates Windows User PATH and shell profile idempotently when missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-home-'));
  const bashrc = path.join(home, '.bashrc');
  fs.writeFileSync(bashrc, 'export FOO=bar\n', 'utf8');

  let persistedUserPath = 'C:\\Users\\Dev\\bin';
  const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32', Path: 'C:\\Windows\\System32' };
  const winBin = 'C:\\Users\\Dev\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
  const winDir = 'C:\\Users\\Dev\\AppData\\Local\\Programs\\Ollama';

  try {
    const first = ensureOllamaOnPath(winBin, {
      platform: 'win32',
      env,
      homeDir: home,
      readWinPaths: () => ({ userPath: persistedUserPath, machinePath: 'C:\\Windows\\System32' }),
      writeWinUserPath: (next) => {
        persistedUserPath = next;
        return true;
      },
    });

    assert.equal(first.alreadyInProcessPath, false);
    assert.equal(first.addedToProcessPath, true);
    assert.equal(first.addedToUserEnv, true);
    assert.deepEqual(first.updatedProfiles, [bashrc]);
    assert.ok(isDirInPath(winDir, env.PATH, 'win32'));
    assert.ok(isDirInPath(winDir, persistedUserPath, 'win32'));

    const profileText = fs.readFileSync(bashrc, 'utf8');
    assert.match(profileText, /\/c\/Users\/Dev\/AppData\/Local\/Programs\/Ollama/);

    // Second run is a complete no-op (no duplicate entries)
    const second = ensureOllamaOnPath(winBin, {
      platform: 'win32',
      env,
      homeDir: home,
      readWinPaths: () => ({ userPath: persistedUserPath, machinePath: 'C:\\Windows\\System32' }),
      writeWinUserPath: () => {
        throw new Error('Should not rewrite User PATH when already present');
      },
    });

    assert.equal(second.alreadyInProcessPath, true);
    assert.equal(second.addedToUserEnv, false);
    assert.deepEqual(second.updatedProfiles, []);
    assert.equal(fs.readFileSync(bashrc, 'utf8'), profileText);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isExpectedOllamaSignerSubject requires CN or O to identify Ollama rather than arbitrary substrings', () => {
  assert.equal(
    isExpectedOllamaSignerSubject('CN=Ollama Inc., O=Ollama Inc., L=Toronto, S=Ontario, C=CA'),
    true
  );
  assert.equal(
    isExpectedOllamaSignerSubject('CN=Ollama, O=Ollama, L=Palo Alto, S=California, C=US'),
    true
  );
  assert.equal(
    isExpectedOllamaSignerSubject('CN=Ollama Inc, O=Ollama Inc, L=San Francisco, C=US'),
    true
  );
  assert.equal(
    isExpectedOllamaSignerSubject('CN="Ollama, Inc.", O="Ollama, Inc.", C=US'),
    true
  );
  assert.equal(
    isExpectedOllamaSignerSubject('CN=Fake Ollama Tools LLC, O=Evil Corp, C=US'),
    false
  );
  assert.equal(isExpectedOllamaSignerSubject('CN=Attacker, OU=ollama-mirror'), false);
  assert.equal(isExpectedOllamaSignerSubject(''), false);
  assert.equal(isExpectedOllamaSignerSubject(null), false);
});
