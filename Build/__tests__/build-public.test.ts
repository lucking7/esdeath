import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ruleCardsHtml, treeHtml } from '../build-public';
import { collectRules } from '../lib/public-index-model';
import { prioritySorter } from '../lib/public-index-sort';
import { TreeFileType } from '../lib/tree-dir';
import type { TreeTypeArray } from '../lib/tree-dir';
import { escapeHtml } from '../utils/escape-html';

function file(name: string, path: string) {
  return { type: TreeFileType.FILE, name, path } as const;
}

function dir(name: string, children: TreeTypeArray) {
  return {
    type: TreeFileType.DIRECTORY,
    name,
    path: `/${name}`,
    children,
  } as const;
}

describe('prioritySorter (public root ordering)', () => {
  it('orders known roots by the curated priority, directories first', () => {
    const names = ['Mirror', 'GeoIP', 'zz-unknown', 'sing-box', 'Loon', 'Clash', 'List', 'Mock', 'Modules', 'Scripts'];
    const sorted = names
      .map(name => dir(name, []))
      .sort(prioritySorter)
      .map(entry => entry.name);
    assert.deepEqual(sorted, ['List', 'Loon', 'Clash', 'sing-box', 'GeoIP', 'Mock', 'Modules', 'Scripts', 'Mirror', 'zz-unknown']);
  });

  it('matches real output roots case-sensitively so GeoIP sorts at its curated slot', () => {
    // Regression pin: the pre-2026-09 table keyed "GEOIP" while the real output
    // dir is "GeoIP", silently pushing it to the fallback slot.
    const entries = [dir('GeoIP', []), dir('sing-box', []), dir('Mirror', [])] as TreeTypeArray;
    const sorted = [...entries].sort(prioritySorter);
    assert.deepEqual(sorted.map(e => e.name), ['sing-box', 'GeoIP', 'Mirror']);
  });

  it('sorts directories before files regardless of name', () => {
    const entries = [file('a-file', '/a-file'), dir('zz-dir', [])] as TreeTypeArray;
    const sorted = [...entries].sort(prioritySorter);
    assert.equal(sorted[0].name, 'zz-dir');
    assert.equal(sorted[1].name, 'a-file');
  });
});

describe('public index HTML escaping', () => {
  it('escapes all HTML metacharacters without double-escaping generated entities', () => {
    const unsafe = '<script>"Tom & Jerry\'s"</script>';

    assert.equal(
      escapeHtml(unsafe),
      '&lt;script&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/script&gt;'
    );
    assert.equal(escapeHtml('&'), '&amp;');
  });

  it('escapes visible names and URI-encodes link paths without escaping slashes twice', () => {
    const name = '<script>"规则 & Jerry\'s 文件.list';
    const tree: TreeTypeArray = [{
      type: TreeFileType.DIRECTORY,
      name: '目录 "&\'',
      path: '/目录 "&\'',
      children: [{
        type: TreeFileType.DIRECTORY,
        name: 'sgmodule',
        path: '/目录/sgmodule',
        children: [{
          type: TreeFileType.FILE,
          name,
          path: `/目录/中文 space/${name}`,
        }],
      }],
    }];

    const rendered = treeHtml(tree);

    assert.ok(rendered.includes('<span class="folder-name">目录 &quot;&amp;&#39;</span>'));
    assert.ok(rendered.includes('data-path="目录 &quot;&amp;&#39;"'));
    // depth-1 section has no trail; depth-2 branch would, but fixture is root → section → file
    assert.ok(rendered.includes('folder-summary is-section'));
    assert.ok(rendered.includes('<span class="folder-name">sgmodule</span>'));
    assert.ok(rendered.includes(
      '&lt;script&gt;&quot;规则 &amp; Jerry&#39;s 文件.list'
    ));
    assert.ok(rendered.includes(
      'href="/%E7%9B%AE%E5%BD%95/%E4%B8%AD%E6%96%87%20space/%3Cscript%3E%22%E8%A7%84%E5%88%99%20&amp;%20Jerry&#39;s%20%E6%96%87%E4%BB%B6.list"'
    ));
    assert.ok(rendered.includes('Copy URL'));
    assert.equal(rendered.includes('<script>'), false);
    assert.equal(rendered.includes('%2520'), false);
    assert.equal(rendered.includes('%2F'), false);
  });

  it('renders generic trees without mutating caller-owned ordering', () => {
    const tree: TreeTypeArray = [
      file('zeta.list', '/zeta.list'),
      file('alpha.list', '/alpha.list'),
    ];

    treeHtml(tree);

    assert.deepEqual(tree.map(entry => entry.name), ['zeta.list', 'alpha.list']);
  });
});

describe('collectRules (rule-card aggregation)', () => {
  it('aggregates the same basename across client dirs into one rule, ordered and sorted', () => {
    const tree: TreeTypeArray = [
      dir('Clash', [file('beta.txt', '/Clash/beta.txt'), file('alpha.txt', '/Clash/alpha.txt')]),
      dir('List', [file('alpha.list', '/List/alpha.list'), file('beta.list', '/List/beta.list')]),
      dir('Loon', [file('alpha.list', '/Loon/alpha.list')]),
      dir('sing-box', [file('alpha.json', '/sing-box/alpha.json')]),
      dir('GeoIP', [file('ip2.mmdb', '/GeoIP/ip2.mmdb')]),
    ];

    const { rules, restRoots } = collectRules(tree);

    // GeoIP is not a client dir: passes through untouched
    assert.deepEqual(restRoots.map(r => r.name), ['GeoIP']);

    // rules sorted by name; beta only has List+Clash, alpha has 4 formats in CLIENT_DIRS order (S·C·L·X)
    assert.deepEqual(rules.map(r => r.name), ['alpha', 'beta']);
    assert.deepEqual(
      rules[0].formats.map(f => [f.dir, f.client, f.filename, f.href]),
      [
        ['List', 'Surge', 'alpha.list', '/List/alpha.list'],
        ['Clash', 'Clash', 'alpha.txt', '/Clash/alpha.txt'],
        ['Loon', 'Loon', 'alpha.list', '/Loon/alpha.list'],
        ['sing-box', 'sing-box', 'alpha.json', '/sing-box/alpha.json'],
      ]
    );
    assert.deepEqual(rules[1].formats.map(f => f.dir), ['List', 'Clash']);

    // full coverage: availability letters render in S·C·L·X order, all on
    const fullLetters = [
      ...ruleCardsHtml([rules[0]]).matchAll(/class="av (is-on|is-off)"[^>]*>([A-Z])</g),
    ].map(m => `${m[2]}:${m[1]}`);
    assert.deepEqual(fullLetters, ['S:is-on', 'C:is-on', 'L:is-on', 'X:is-on']);
  });

  it('skips meta files and marks missing clients in availability', () => {
    const tree: TreeTypeArray = [
      dir('List', [file('alpha.list', '/List/alpha.list'), file('README.md', '/List/README.md')]),
    ];

    const { rules } = collectRules(tree);
    assert.equal(rules.length, 1);

    const htmlOut = ruleCardsHtml(rules);
    assert.ok(htmlOut.includes('data-clients="List"'));
    assert.equal((htmlOut.match(/class="fmt"/g) || []).length, 1);
    // partial client (Surge only): exact on/off state per S·C·L·X position
    const letters = [...htmlOut.matchAll(/class="av (is-on|is-off)"[^>]*>([A-Z])</g)].map(
      m => `${m[2]}:${m[1]}`
    );
    assert.deepEqual(letters, ['S:is-on', 'C:is-off', 'L:is-off', 'X:is-off']);
  });
});

describe('ruleCardsHtml escaping', () => {
  it('escapes rule names and encodes hrefs without double-escaping', () => {
    const tree: TreeTypeArray = [
      dir('List', [file('<b>"x&\'.list', '/List/<b>"x&\'.list')]),
    ];

    const { rules } = collectRules(tree);
    const rendered = ruleCardsHtml(rules);

    assert.ok(rendered.includes('data-rule="&lt;b&gt;&quot;x&amp;&#39;"'));
    assert.ok(rendered.includes('href="/List/%3Cb%3E%22x&amp;&#39;.list"'));
    assert.equal(rendered.includes('<b>"x'), false);
    assert.equal(rendered.includes('%2522'), false);
  });
});
