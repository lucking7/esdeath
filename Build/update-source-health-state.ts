import fs from 'node:fs/promises';
import process from 'node:process';
import type { SourceHealthReport } from './validate-domain-alive';
import { transitionSourceHealth } from './lib/source-health-state';
import type { SourceHealthState } from './lib/source-health-state';

interface PersistedState {
  sources: Record<string, SourceHealthState>
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const [reportPath, statePath, actionsPath] = process.argv.slice(2);
  if (!reportPath || !statePath || !actionsPath) throw new Error('Usage: update-source-health-state <report> <state> <actions>');
  const report = await readJson<SourceHealthReport>(reportPath, { generatedAt: '', summary: { ok: 0, dead: 0, unknown: 0 }, sources: [] });
  const persisted = await readJson<PersistedState>(statePath, { sources: {} });
  // The workflow only reads `close` records from actions.json (open/update
  // decisions are recomputed from state.json deadStreak), so only close
  // transitions are serialized.
  const actions: Array<{ id: string, action: 'close', observedAt: string }> = [];
  for (const source of report.sources) {
    const transition = transitionSourceHealth(persisted.sources[source.id], source.id, source.status, report.generatedAt);
    persisted.sources[source.id] = transition.state;
    if (transition.issueAction === 'close') actions.push({ id: source.id, action: 'close', observedAt: report.generatedAt });
  }
  await fs.writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
  await fs.writeFile(actionsPath, `${JSON.stringify(actions, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
