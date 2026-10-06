// The daily check of the newest Claude Code (.github/workflows/upstream.yml): Baton's own model check,
// signed out. Claude Code answers models, context windows, efforts and the account over its control
// channel without a sign-in. It fails when a release changes something Baton relies on.
import { probe } from './claude.js';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

const exe = process.env.CLAUDE_EXE;
if (!exe) throw new Error('Set CLAUDE_EXE to the Claude Code binary to check.');
const started = Date.now();
try {
  const { models, account } = await probe(exe, {}, true);
  console.log(`model check: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const { info, contextWindow, compactAt } of models) {
    console.log(`  ${info.value} (${info.resolvedModel ?? '-'}): window ${contextWindow}, compacts at ${compactAt ?? '-'}, efforts ${(info.supportedEffortLevels ?? []).join('/') || '-'}`);
  }
  check('lists models', models.length > 0, String(models.length));
  check('reads every context window', models.length > 0 && models.every((model) => model.checkedAt > 0));
  check('names every model', models.every((model) => Boolean(model.info.value && model.info.displayName)));
  check('offers effort levels', models.some((model) => (model.info.supportedEffortLevels ?? []).length > 0));
  check('reports the account', typeof account === 'object' && account !== null, JSON.stringify(account));
} catch (error) {
  check('model check', false, String(error));
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
