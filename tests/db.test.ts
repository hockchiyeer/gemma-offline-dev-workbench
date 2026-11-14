import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeVaultPassphrase,
  disableVaultEncryption,
  enableVaultEncryption,
  exportVaultBackup,
  importVaultBackup,
  loadWorkspaceData,
  parseBackupFile,
  removeProjectAndRehome,
  saveSnippet,
  unlockVaultWithPassphrase,
  validateBackupPayload,
} from '../src/lib/db.ts';

test('IndexedDB seeding, encryption, unlock, passphrase rotation, re-homing, and backup roundtrip', async () => {
  // 1. Seed starter dataset in clean IndexedDB
  const initial = await loadWorkspaceData(null);
  assert.ok(initial.projects.length >= 2);
  assert.ok(initial.snippets.length >= 4);
  assert.ok(initial.docs.length >= 2);
  assert.ok(initial.sessions.length >= 1);
  assert.equal(initial.securityMeta.encryptionEnabled, false);

  // 2. Reject too-short passphrase
  await assert.rejects(() => enableVaultEncryption('short', initial, 15));

  // 3. Enable AES-256-GCM encryption
  const pass1 = 'GemmaVault!Passphrase#1';
  const sealed = await enableVaultEncryption(pass1, initial, 15);
  assert.equal(sealed.meta.encryptionEnabled, true);

  // Locked load without key must fail
  await assert.rejects(() => loadWorkspaceData(null));

  // Wrong passphrase returns null
  const wrongUnlock = await unlockVaultWithPassphrase('Wrong!Passphrase#999');
  assert.equal(wrongUnlock, null);

  // Correct passphrase unlocks and decrypts
  const unlocked = await unlockVaultWithPassphrase(pass1);
  assert.ok(unlocked);
  const decrypted = await loadWorkspaceData(unlocked.key);
  assert.equal(decrypted.snippets.length, initial.snippets.length);
  assert.equal(decrypted.docs.length, initial.docs.length);

  // 4. Write an encrypted snippet and export encrypted backup
  const customSnippet = {
    ...decrypted.snippets[0],
    id: 'snip-custom-db-test',
    title: 'Custom Encrypted Test Snippet',
    updatedAt: Date.now(),
  };
  await saveSnippet(customSnippet, unlocked.key);
  const afterSave = await loadWorkspaceData(unlocked.key);
  assert.ok(afterSave.snippets.some((s) => s.id === 'snip-custom-db-test'));

  const encryptedBundle = await exportVaultBackup(afterSave, unlocked.key);
  assert.equal(encryptedBundle.encrypted, true);

  // 5. Rotate passphrase and confirm old passphrase fails while new passphrase unlocks
  const pass2 = 'Rotated!GemmaVault#2026';
  const rotated = await changeVaultPassphrase(pass1, pass2, afterSave);
  assert.equal(await unlockVaultWithPassphrase(pass1), null);
  const unlocked2 = await unlockVaultWithPassphrase(pass2);
  assert.ok(unlocked2);
  const decrypted2 = await loadWorkspaceData(rotated.key);
  assert.ok(decrypted2.snippets.some((s) => s.id === 'snip-custom-db-test'));

  // 6. Remove project and verify linked snippets/docs/sessions are re-homed, not deleted
  const projectToRemove = decrypted2.projects[1];
  const fallbackProject = decrypted2.projects[0];
  const linkedSnippetCount = decrypted2.snippets.filter(
    (s) => s.projectId === projectToRemove.id
  ).length;
  assert.ok(linkedSnippetCount > 0);

  const rehomed = await removeProjectAndRehome({
    projectId: projectToRemove.id,
    fallbackProjectId: fallbackProject.id,
    snippets: decrypted2.snippets,
    docs: decrypted2.docs,
    sessions: decrypted2.sessions,
    key: rotated.key,
  });
  assert.equal(
    rehomed.snippets.filter((s) => s.projectId === projectToRemove.id).length,
    0
  );
  assert.equal(rehomed.snippets.length, decrypted2.snippets.length);

  const afterRehome = await loadWorkspaceData(rotated.key);
  assert.equal(afterRehome.projects.length, decrypted2.projects.length - 1);
  assert.equal(afterRehome.snippets.length, decrypted2.snippets.length);

  // 7. Import encrypted backup (sealed with pass1) into vault (currently sealed with pass2)
  const parsedBundle = parseBackupFile(JSON.stringify(encryptedBundle));
  const restored = await importVaultBackup(parsedBundle, pass1, rotated.key);
  assert.equal(restored.projects.length, afterSave.projects.length);
  assert.ok(restored.snippets.some((s) => s.id === 'snip-custom-db-test'));

  // 8. Disable encryption and export plain backup
  await disableVaultEncryption(restored);
  const plainData = await loadWorkspaceData(null);
  assert.equal(plainData.securityMeta.encryptionEnabled, false);
  const plainBundle = await exportVaultBackup(plainData, null);
  assert.equal(plainBundle.encrypted, false);

  // 9. Hostile/malformed backup payloads must be rejected
  assert.throws(() =>
    validateBackupPayload({
      projects: [],
      snippets: [],
      docs: [],
    })
  );
  assert.throws(() =>
    validateBackupPayload({
      projects: [{ id: '', name: 'Bad' }],
      snippets: [],
      docs: [],
    })
  );
  assert.throws(() =>
    validateBackupPayload({
      projects: [{ id: 'p1', name: 'Valid' }],
      snippets: [{ id: 's1', projectId: 'p1', title: 'Missing code' }],
      docs: [],
    })
  );
});

test('Late plaintext writes are refused while the vault is encrypted (e.g. stream finishing after auto-lock)', async () => {
  const { saveChatSession, saveRuntimeConfig, DEFAULT_RUNTIME_CONFIG, getSecurityMeta } =
    await import('../src/lib/db.ts');
  const current = await getSecurityMeta();
  if (!current.encryptionEnabled) {
    const data = await loadWorkspaceData(null);
    await enableVaultEncryption('GemmaVault!Guard#2026', data, 15);
  }
  const session = {
    id: 'chat-late-write',
    projectId: 'proj-core',
    title: 'late',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await assert.rejects(() => saveChatSession(session, null), /locked/i);
  await assert.rejects(() => saveRuntimeConfig(DEFAULT_RUNTIME_CONFIG, null), /locked/i);
});
