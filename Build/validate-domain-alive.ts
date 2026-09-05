import path from 'node:path';
import process from 'node:process';
import picocolors from 'picocolors';
import { task } from './trace';
import { getErrorMessage } from './lib/misc';
import { getMethods } from './utils/domain/is-domain-alive';
import { createSourceInventory } from './lib/source-inventory';
import type { SourceInventoryEntry, SourceRole } from './lib/source-inventory';
import { ruleGroups, specialRules } from './lib/rule-sources';
import { MIRROR_GROUPS } from './integration/mirror-sync/mirror-config';
import { UA_MIRROR, UA_SURGE_MAC } from './constants/user-agents';
import { applyProxyIfNeeded } from './utils/network/proxy';
import { writeFileAtomic } from './lib/atomic-file';

export type HealthStatus = 'ok' | 'dead' | 'unknown';

export interface ProbeResult {
  status: HealthStatus,
  httpStatus?: number
}

export interface SourceHealthRecord extends ProbeResult {
  id: string,
  url: string,
  role: SourceRole,
  elapsedMs: number
}

export interface SourceHealthReport {
  generatedAt: string,
  summary: Record<HealthStatus, number>,
  sources: SourceHealthRecord[]
}

export type SourceProbe = (source: SourceInventoryEntry) => Promise<ProbeResult>;

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|key|secret|signature|credential|password|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value;
  }
}

export async function probeSource(
  source: SourceInventoryEntry,
  fetchFn: typeof fetch = fetch
): Promise<ProbeResult> {
  try {
    // Probe through the same fetch path the build uses: proxy-required hosts
    // (e.g. kelee.one rejects datacenter IPs with 403) must go through PROXY_BASE
    // or a healthy upstream is misreported as dead.
    const response = await fetchFn(applyProxyIfNeeded(source.url), {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000), // eslint-disable-line sukka/unicorn/numeric-separators-style -- 15 seconds
      headers: {
        'user-agent': source.requestProfile === 'github-release' ? UA_MIRROR : UA_SURGE_MAC,
      },
    });
    return { status: response.ok ? 'ok' : 'dead', httpStatus: response.status };
  } catch (fetchError) {
    // HTTP unreachable. Use the DNS-level checker to decide between a dead
    // domain and a transient/unknown network failure.
    try {
      const { isDomainAlive } = await getMethods();
      const hostname = new URL(source.url).hostname;
      const alive = await isDomainAlive(hostname);
      return alive ? { status: 'unknown' } : { status: 'dead' };
    } catch {
      throw fetchError;
    }
  }
}

export async function checkSources(
  inventory: readonly SourceInventoryEntry[],
  probe: SourceProbe = probeSource,
  now: () => number = Date.now
): Promise<SourceHealthReport> {
  const sources: SourceHealthRecord[] = [];
  for (const source of inventory) {
    const started = now();
    try {
      // eslint-disable-next-line no-await-in-loop -- keep upstream load bounded and timings isolated
      const checked = await probe(source);
      sources.push({ ...source, url: redactUrl(source.url), ...checked, elapsedMs: Math.max(0, now() - started) });
    } catch {
      sources.push({ ...source, url: redactUrl(source.url), status: 'unknown', elapsedMs: Math.max(0, now() - started) });
    }
  }
  const summary = { ok: 0, dead: 0, unknown: 0 };
  for (const source of sources) summary[source.status]++;
  return { generatedAt: new Date().toISOString(), summary, sources };
}

export async function writeHealthReport(outputPath: string, report: SourceHealthReport): Promise<void> {
  await writeFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

// Compatibility with Plan 011's public contract.
export interface DomainCheckResult {
  total: number,
  alive: string[],
  dead: string[],
  unknown: Array<{ domain: string, error: string }>
}

export async function checkDomains(
  domains: Iterable<string>,
  checker: (domain: string) => Promise<boolean | { alive: boolean }>
): Promise<DomainCheckResult> {
  const result: DomainCheckResult = { total: 0, alive: [], dead: [], unknown: [] };
  for (const domain of domains) {
    result.total++;
    try {
      // eslint-disable-next-line no-await-in-loop -- compatibility checker is intentionally sequential
      const checked = await checker(domain);
      if (typeof checked === 'boolean' ? checked : checked.alive) result.alive.push(domain);
      else result.dead.push(domain);
    } catch (error) {
      result.unknown.push({ domain, error: getErrorMessage(error) });
    }
  }
  return result;
}

export function domainCheckExitCode(result: DomainCheckResult | SourceHealthReport): number {
  if ('sources' in result) return result.summary.dead > 0 || result.summary.unknown > 0 ? 1 : 0;
  return result.dead.length > 0 || result.unknown.length > 0 ? 1 : 0;
}

export const validateDomainAlive = task(require.main === module, __filename)(async () => {
  const outputPath = path.resolve(process.argv[2] ?? 'source-health-report.json');
  const inventory = createSourceInventory(ruleGroups, specialRules, MIRROR_GROUPS);
  console.log(picocolors.cyan(`[Source Health] Checking ${inventory.length} configured network sources...`));
  const report = await checkSources(inventory);
  await writeHealthReport(outputPath, report);
  console.log(picocolors.green(`  ✓ OK: ${report.summary.ok}`));
  console.log(picocolors.red(`  ✗ Dead: ${report.summary.dead}`));
  console.log(picocolors.yellow(`  ? Unknown: ${report.summary.unknown}`));
  console.log(picocolors.gray(`[Source Health] Report: ${outputPath}`));
  process.exitCode = domainCheckExitCode(report);
});
