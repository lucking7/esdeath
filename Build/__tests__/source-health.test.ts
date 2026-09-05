import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  checkSources,
  domainCheckExitCode,
  probeSource,
  writeHealthReport,
} from '../validate-domain-alive';
import { UA_MIRROR, UA_SURGE_MAC } from '../constants/user-agents';

describe('source health report', () => {
  it('classifies injected results and redacts secrets', async () => {
    let clock = 0;
    const report = await checkSources([
      { id: 'primary:a', role: 'primary', requestProfile: 'rule', url: 'https://user:pass@ok.test/a?token=secret&public=yes' },
      { id: 'primary:b', role: 'primary', requestProfile: 'rule', url: 'https://dead.test' },
      { id: 'primary:c', role: 'primary', requestProfile: 'rule', url: 'https://unknown.test' },
    ], source => {
      if (source.url.includes('unknown')) throw new Error('token=must-not-leak');
      return Promise.resolve(source.url.includes('dead') ? { status: 'dead', httpStatus: 503 } : { status: 'ok', httpStatus: 204 });
    }, () => ++clock);
    assert.deepEqual(report.summary, { ok: 1, dead: 1, unknown: 1 });
    assert.equal(report.sources[1].httpStatus, 503);
    assert.equal(report.sources[2].status, 'unknown');
    assert.equal(JSON.stringify(report).includes('secret'), false);
    assert.equal(JSON.stringify(report).includes('pass@'), false);
    assert.equal(domainCheckExitCode(report), 1);
  });

  it('uses the build request profile for rule and release sources', async () => {
    const userAgents: string[] = [];
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
      userAgents.push(new Headers(init?.headers).get('user-agent') ?? '');
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    await probeSource(
      { id: 'primary:a', role: 'primary', requestProfile: 'rule', url: 'https://rule.test/a' },
      fetchFn
    );
    await probeSource(
      {
        id: 'mirror-repository:a',
        role: 'mirror-repository',
        requestProfile: 'github-release',
        url: 'https://api.github.com/repos/owner/repo/releases/latest',
      },
      fetchFn
    );

    assert.deepEqual(userAgents, [UA_SURGE_MAC, UA_MIRROR]);
  });

  it('routes proxy-required sources through PROXY_BASE like the build does', async () => {
    const seenUrls: string[] = [];
    const fetchFn = ((_input: string | URL | Request, _init?: RequestInit) => {
      seenUrls.push(typeof _input === 'string' ? _input : (_input instanceof URL ? _input.href : _input.url));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    process.env.PROXY_BASE = 'https://proxy.test/?url=';
    try {
      await probeSource(
        { id: 'primary:a', role: 'primary', requestProfile: 'rule', url: 'https://kelee.one/Tool/Loon/Lsr/AI.lsr' },
        fetchFn
      );
      await probeSource(
        { id: 'primary:b', role: 'primary', requestProfile: 'rule', url: 'https://rule.example.com/rule.list' },
        fetchFn
      );
    } finally {
      delete process.env.PROXY_BASE;
    }

    assert.match(seenUrls[0], /^https:\/\/proxy\.test\/\?url=https:\/\/kelee\.one\//);
    assert.equal(seenUrls[1], 'https://rule.example.com/rule.list');
  });

  it('writes valid JSON atomically to an explicit path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-health-'));
    const output = path.join(directory, 'report.json');
    const report = await checkSources([], () => Promise.resolve({ status: 'ok' }));
    await writeHealthReport(output, report);
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), report);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['report.json']);
    await fs.rm(directory, { recursive: true, force: true });
  });
});
