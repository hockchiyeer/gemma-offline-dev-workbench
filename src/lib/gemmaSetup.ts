export type SetupPhase =
  | 'idle'
  | 'checking'
  | 'downloading-installer'
  | 'verifying'
  | 'installing'
  | 'starting-ollama'
  | 'pulling-model'
  | 'done'
  | 'error';

export interface SetupJob {
  phase: SetupPhase;
  message: string;
  percent: number | null;
  model: string;
  running: boolean;
  error?: string;
  manualHint?: string;
}

export interface SetupSystem {
  platform: string;
  totalMemGiB: number;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  installedModels: string[];
  recommendedModel: string;
}

export interface SetupStatus {
  system: SetupSystem;
  job: SetupJob;
}

const HEADERS = { 'Content-Type': 'application/json', 'X-GemmaVault-Setup': '1' };

/** Returns null when the local GemmaVault server (and so auto-setup) is unavailable, e.g. static PWA or non-loopback server. */
export async function fetchSetupStatus(): Promise<SetupStatus | null> {
  try {
    const resp = await fetch('/api/setup/status', { headers: HEADERS });
    if (!resp.ok) return null;
    return (await resp.json()) as SetupStatus;
  } catch {
    return null;
  }
}

export async function startGemmaSetup(model?: string): Promise<void> {
  const resp = await fetch('/api/setup/start', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ model }),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Setup could not start (HTTP ${resp.status}).`);
  }
}

export async function cancelGemmaSetup(): Promise<void> {
  await fetch('/api/setup/cancel', { method: 'POST', headers: HEADERS, body: '{}' }).catch(
    () => undefined
  );
}
