import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSpan } from '../trace';
import { EnhancedFileOutput } from '../lib/enhanced-file-output';

function parseSingboxContent(content: string[] | null) {
  assert.ok(content, 'sing-box content should be present');
  return JSON.parse(content.join('\n')) as {
    rules: Array<{
      domain?: string[];
      domain_suffix?: string[];
      domain_keyword?: string[];
      domain_regex?: string[];
      ip_cidr?: string[];
    }>;
  };
}

describe('EnhancedFileOutput', () => {
  it('classifies raw rules and compiles equivalent multi-platform outputs', async () => {
    const output = new EnhancedFileOutput(
      createSpan('test'),
      'sample',
      'mixed',
      ['surge', 'clash', 'singbox', 'loon'],
      null,
      { applyNoResolve: true },
      'out'
    );

    output.addRules([
      'example.com',
      '.example.org',
      'DOMAIN-KEYWORD,video',
      'IP-CIDR,1.2.3.0/24,Proxy',
      'IP-CIDR6,2001:db8::/32',
      'DOMAIN-SUFFIX,policy.test,Proxy,no-resolve',
      '# ignored comment',
    ]);

    const [surge, clash, singbox, loon] = await output.compile();

    assert.ok(surge?.includes('DOMAIN,example.com'));
    assert.ok(surge?.includes('DOMAIN-SUFFIX,example.org'));
    assert.ok(surge?.includes('DOMAIN-KEYWORD,video'));
    assert.ok(surge?.includes('IP-CIDR,1.2.3.0/24,no-resolve'));
    assert.ok(surge?.includes('IP-CIDR6,2001:db8::/32,no-resolve'));
    assert.ok(surge?.includes('DOMAIN-SUFFIX,policy.test'));

    assert.ok(clash?.includes('DOMAIN,example.com'));
    assert.ok(clash?.includes('DOMAIN-SUFFIX,example.org'));
    assert.ok(clash?.includes('DOMAIN-KEYWORD,video'));
    assert.ok(clash?.includes('IP-CIDR,1.2.3.0/24,no-resolve'));

    const singboxJson = parseSingboxContent(singbox);
    assert.deepEqual(singboxJson.rules[0].domain, ['example.com']);
    assert.deepEqual(new Set(singboxJson.rules[0].domain_suffix), new Set(['example.org', 'policy.test']));
    assert.deepEqual(singboxJson.rules[0].domain_keyword, ['video']);
    assert.deepEqual(singboxJson.rules[0].ip_cidr, ['1.2.3.0/24', '2001:db8::/32']);

    assert.ok(loon?.includes('DOMAIN,example.com'));
    assert.ok(loon?.includes('DOMAIN-SUFFIX,example.org'));
    assert.ok(loon?.includes('DOMAIN-KEYWORD,video'));
    assert.ok(loon?.includes('IP-CIDR,1.2.3.0/24,no-resolve'));
  });

  it('prunes covered domains and wildcards while retaining distinct matches across all platforms', async () => {
    const output = new EnhancedFileOutput(
      createSpan('test'),
      'overlapping-domains',
      'mixed',
      ['surge', 'clash', 'singbox', 'loon']
    );
    output.addRules([
      'DOMAIN-KEYWORD,ads',
      'DOMAIN,ads.example',
      'DOMAIN-SUFFIX,ads-suffix.example',
      'DOMAIN-WILDCARD,*.ads-wild.example',
      'DOMAIN,exact.example',
      'DOMAIN-WILDCARD,exact.example',
      'DOMAIN-WILDCARD,*.exact.example',
      'DOMAIN-SUFFIX,suffix.example',
      'DOMAIN-WILDCARD,*.suffix.example',
      'DOMAIN-WILDCARD,*.standalone.example',
    ]);

    const [surge, clash, singbox, loon] = await output.compile();
    const commonRules = [
      'DOMAIN,exact.example',
      'DOMAIN-SUFFIX,suffix.example',
      'DOMAIN-KEYWORD,ads',
    ];
    const wildcardRules = [
      'DOMAIN-WILDCARD,*.exact.example',
      'DOMAIN-WILDCARD,*.standalone.example',
    ];
    for (const content of [surge, clash]) {
      assert.ok(content);
      assert.deepEqual(new Set(content), new Set([...commonRules, ...wildcardRules]));
    }
    assert.ok(loon);
    assert.deepEqual(new Set(loon), new Set(commonRules));
    assert.deepEqual(parseSingboxContent(singbox).rules, [{
      domain: ['exact.example'],
      domain_suffix: ['suffix.example'],
      domain_keyword: ['ads'],
      domain_regex: [
        String.raw`^[\w.-]*?\.standalone\.example$`,
        String.raw`^[\w.-]*?\.exact\.example$`,
      ],
    }]);
    assert.deepEqual(output.getRuleDropSummaries().loon?.unsupported, { 'DOMAIN-WILDCARD': 2 });
    await assert.rejects(output.compile(), /Strategies already written/);
  });

  it('summarizes finalized rules while merging IPv4 resolution partitions separately', async () => {
    const output = new EnhancedFileOutput(
      createSpan('test'),
      'partitioned-rules',
      'mixed',
      ['surge', 'clash', 'singbox', 'loon']
    );
    output.addRules([
      'DOMAIN-SUFFIX,example.com',
      'DOMAIN-WILDCARD,*.example.com',
      'IP-CIDR,10.0.0.0/25',
      'IP-CIDR,10.0.0.128/25',
      'IP-CIDR,10.0.0.0/25,no-resolve',
      'IP-CIDR,10.0.0.128/25,no-resolve',
    ]);

    const [surge, clash, singbox, loon] = await output.compile();

    for (const content of [surge, clash, loon]) {
      assert.deepEqual(content, [
        'DOMAIN-SUFFIX,example.com',
        'IP-CIDR,10.0.0.0/24,no-resolve',
        'IP-CIDR,10.0.0.0/24',
      ]);
    }
    assert.deepEqual(parseSingboxContent(singbox).rules, [{
      domain: [],
      domain_suffix: ['example.com'],
      ip_cidr: ['10.0.0.0/24', '10.0.0.0/24'],
    }]);
    assert.deepEqual(output.getOutputSummary(), {
      id: 'partitioned-rules',
      platforms: ['surge', 'clash', 'singbox', 'loon'],
      ruleCount: 3,
    });
  });

  it('keeps compilation and publication single-use with independent instance state', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00.000Z') });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirrrule-output-lifecycle-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const createOutput = (id: string) => new EnhancedFileOutput(
      createSpan('test'), id, 'mixed', ['surge'], null, undefined, directory
    ).withTitle('Lifecycle rules').withDescription(['Fixture description']);
    const compiled = createOutput('compiled');
    const published = createOutput('published');
    compiled.addRawRule('DOMAIN,compiled.example');
    published.addRawRule('DOMAIN,published.example');

    assert.deepEqual(await compiled.compile(), [['DOMAIN,compiled.example']]);
    await assert.rejects(compiled.write(), /Strategies already written/);
    assert.deepEqual(await fs.readdir(directory), []);

    await published.write();
    const outputPath = path.join(directory, 'List/published.list');
    const content = await fs.readFile(outputPath, 'utf8');
    assert.equal(content, [
      '#########################################',
      '# Lifecycle rules',
      '# Last Updated: 2026-01-01T00:00:00.000Z',
      '# Size: 1',
      '# Fixture description',
      '#########################################',
      'DOMAIN,published.example',
      '################## EOF ##################',
      '',
      '',
    ].join('\n'));
    assert.deepEqual(published.getOutputSummary(), {
      id: 'published', platforms: ['surge'], ruleCount: 1,
    });
    await assert.rejects(published.compile(), /Strategies already written/);
    await assert.rejects(published.write(), /Strategies already written/);
    assert.equal(await fs.readFile(outputPath, 'utf8'), content);
    assert.deepEqual(await fs.readdir(path.join(directory, 'List')), ['published.list']);
  });

  it('keeps explicit policies when a default policy is configured', async () => {
    const output = new EnhancedFileOutput(
      createSpan('test'),
      'sample-policy',
      'mixed',
      ['surge'],
      'Proxy',
      undefined,
      'out'
    );

    output.addRawRule('AND,((DOMAIN,foo.com),(DOMAIN-SUFFIX,bar.com)),Proxy,no-resolve');

    const [surge] = await output.compile();

    assert.deepEqual(surge, [
      'AND,((DOMAIN,foo.com),(DOMAIN-SUFFIX,bar.com)),Proxy,no-resolve',
    ]);
  });

  it('strips YAML/Clash list markers and keeps the recovered domain rule', async () => {
    const output = new EnhancedFileOutput(
      createSpan('test'),
      'yaml-bullet',
      'mixed',
      ['surge', 'clash'],
      null,
      { validate: true, applyNoResolve: true },
      'out'
    );

    // Real-world upstream glitch seen in kefengyoyo/own Emby-P.list
    output.addRules([
      '- DOMAIN-SUFFIX,cc.cd',
      '-\tDOMAIN,example.com',
      'DOMAIN-SUFFIX,valid.example',
      // Unknown type remains invalid after the YAML bullet is stripped
      '- NOT-A-RULE-TYPE,garbage.example',
    ]);

    const [surge, clash] = await output.compile();

    assert.ok(surge?.includes('DOMAIN-SUFFIX,cc.cd'));
    assert.ok(surge?.includes('DOMAIN,example.com'));
    assert.ok(surge?.includes('DOMAIN-SUFFIX,valid.example'));
    assert.equal(surge?.some(line => line.startsWith('-')), false);
    assert.equal(surge?.some(line => line.includes('NOT-A-RULE-TYPE')), false);
    assert.equal(surge?.some(line => line.includes('garbage.example')), false);

    assert.ok(clash?.includes('DOMAIN-SUFFIX,cc.cd'));
    assert.equal(clash?.some(line => line.startsWith('-')), false);
  });
});
