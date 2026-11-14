import { createSetupManager, isAllowedGemmaTag } from '../server/ollamaSetup.ts';

/**
 * npm run setup:gemma [-- --model gemma4:e2b] [-- --check]
 * Installs Ollama if missing (Windows), starts it, and downloads a Google Gemma model.
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const manager = createSetupManager();
const system = await manager.getSystemInfo();
const pathNote = !system.ollamaInstalled
  ? 'n/a'
  : system.ollamaOnPath
    ? 'on PATH'
    : 'not on PATH yet';
console.log(
  `System: ${system.platform}, ${system.totalMemGiB} GiB RAM · Ollama ${system.ollamaInstalled ? 'installed' : 'NOT installed'} (${pathNote})` +
    ` · service ${system.ollamaRunning ? 'running' : 'stopped'} · models: ${system.installedModels.join(', ') || 'none'}`
);

if (args.includes('--check')) process.exit(system.ollamaRunning && system.installedModels.length ? 0 : 1);

const model = flag('--model') ?? system.recommendedModel;
if (!isAllowedGemmaTag(model)) {
  console.error(`"${model}" is not a Google Gemma model tag (expected e.g. gemma4:e4b).`);
  process.exit(2);
}
console.log(`Target model: ${model}${flag('--model') ? '' : ' (recommended for this machine)'}`);

let last = '';
const timer = setInterval(() => {
  const s = manager.getState();
  const line = `[${s.phase}] ${s.message}${s.percent !== null ? ` ${s.percent}%` : ''}`;
  if (line !== last) {
    process.stdout.write(`${line}\n`);
    last = line;
  }
}, 1000);
process.on('SIGINT', () => manager.cancel());

const final = await manager.runToCompletion(model);
clearInterval(timer);
if (final.phase === 'done') {
  for (const entry of final.log) {
    if (entry.includes('PATH') || entry.includes('profile')) {
      console.log(`ℹ ${entry}`);
    }
  }
  console.log(`\n✔ ${final.message}\nStart the app with: npm run build && npm start`);
} else {
  console.error(`\n✖ ${final.error ?? final.message}`);
  if (final.manualHint) console.error(final.manualHint);
  process.exit(1);
}
