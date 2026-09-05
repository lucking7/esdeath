import path from 'node:path';

import { task } from './trace';
import { treeDir, TreeFileType } from './lib/tree-dir';
import type { TreeTypeArray } from './lib/tree-dir';

import { PUBLIC_DIR } from './constants/dir';
import { writeFile } from './lib/misc';
import { tagged as html } from 'foxts/tagged';
import { compareAndWriteFile } from './lib/create-file';
import { priorityOrder, prioritySorter } from './lib/public-index-sort.ts';
import { escapeHtml } from './utils/escape-html';
import {
  CLIENT_DIRS,
  collectRules,
  countListedFiles,
  shouldListFile,
} from './lib/public-index-model';
import type { RuleEntry } from './lib/public-index-model';

export { collectRules } from './lib/public-index-model';
export type { ClientDirectory, RuleEntry, RuleFormat } from './lib/public-index-model';

/**
 * 规则平台目录 → 客户端映射。规则卡片模型:同一 basename 跨这些目录聚合为一条规则,
 * 客户端格式是规则的输出,而不是四棵独立的树。
 */
/** Shortcut chips → search queries (personal high-frequency rulesets). */
const QUICK_SEARCHES = ['emby', 'reject', 'stream', 'github', 'geoip'] as const;

export const buildPublic = task(
  require.main === module,
  __filename
)(async span => {
  // Ruleset-text roots get text/plain + noindex; GeoIP serves binary mmdb
  // payloads and keeps its default content-type.
  const rulesetHeaderDirs = Object.keys(priorityOrder).filter(name => name !== 'GeoIP');

  const pageHtml = await span
    .traceChild('generate index.html')
    .traceAsyncFn(() => treeDir(PUBLIC_DIR).then(generateHtml));

  await Promise.all([
    compareAndWriteFile(
      span,
      [
        '/*',
        '  cache-control: public, max-age=240, stale-while-revalidate=60, stale-if-error=15',
        'https://:project.pages.dev/*',
        '  X-Robots-Tag: noindex',
        ...rulesetHeaderDirs.map(
          name => `/${name}/*\n  content-type: text/plain; charset=utf-8\n  X-Robots-Tag: noindex`
        ),
      ],
      path.join(PUBLIC_DIR, '_headers')
    ),
    compareAndWriteFile(
      span,
      [
        '# <pre>',
        '#########################################',
        '# Luck&#39;s Ruleset - 404 Not Found',
        '################## EOF ##################</pre>',
      ],
      path.join(PUBLIC_DIR, '404.html')
    ),
    compareAndWriteFile(
      span,
      [
        '# NRRule - Surge / Clash 规则部署仓库',
        '# 源码位于 [lucking7/MirrRule](https://github.com/lucking7/MirrRule)',
        '',
        '![GitHub repo size](https://img.shields.io/github/repo-size/lucking7/NRRule?style=flat-square)',
      ],
      path.join(PUBLIC_DIR, 'README.md')
    ),
  ]);

  return writeFile(path.join(PUBLIC_DIR, 'index.html'), pageHtml);
});

function buildTimestampGmt8(): { iso: string, display: string } {
  const now = new Date();
  const offsetMinutes = 8 * 60;
  const msPerMinute = 60 * 1000;
  const gmtPlus8 = new Date(
    now.getTime() + (offsetMinutes - now.getTimezoneOffset()) * msPerMinute
  );
  const iso = gmtPlus8.toISOString().replace('Z', '+08:00');
  // Display: minute precision is enough for a build signal (distill: drop ms noise)
  const display = `${iso.slice(0, 16).replace('T', ' ')} +08:00`;
  return { iso, display };
}
function clientChipsHtml(tree: TreeTypeArray): string {
  const present = CLIENT_DIRS.filter(c =>
    tree.some(e => e.type === TreeFileType.DIRECTORY && e.name === c.dir)
  );
  const chips = [
    html`<button type="button" class="chip is-on" data-platform="all" aria-pressed="true">All</button>`,
    ...present.map(
      c =>
        html`<button type="button" class="chip" data-platform="${c.dir}" aria-pressed="false">${c.client}</button>`
    ),
  ];
  return chips.join('\n');
}

function quickChipsHtml(): string {
  return QUICK_SEARCHES.map(
    q => html`<button type="button" class="quick-chip" data-query="${q}">${q}</button>`
  ).join('\n');
}

function availHtml(rule: RuleEntry): string {
  const present = new Set(rule.formats.map(f => f.dir));
  return CLIENT_DIRS.map(c => {
    const on = present.has(c.dir);
    const title = on ? `${c.client} 可用` : `无 ${c.client} 格式`;
    return html`<span class="av ${on ? 'is-on' : 'is-off'}" title="${title}">${c.short}</span>`;
  }).join('\n');
}

/** Rule card: collapsed row = rule name + client availability; body = one row per client format. */
export function ruleCardsHtml(rules: RuleEntry[]): string {
  let result = '';
  for (const rule of rules) {
    const nameAttr = escapeHtml(rule.name.toLowerCase());
    const escapedName = escapeHtml(rule.name);
    const clientDirs = rule.formats.map(f => f.dir).join(' ');
    const clientNames = rule.formats.map(f => f.client).join('、');
    const rows = rule.formats
      .map(
        f => html`
          <li class="fmt" data-client-dir="${f.dir}">
            <span class="fmt-client">${f.client}</span>
            <a
              class="fmt-file"
              href="${escapeHtml(f.href)}"
              target="_blank"
              rel="noopener noreferrer"
              >${escapeHtml(f.filename)}</a
            >
            <button
              type="button"
              class="copy-btn"
              data-path="${escapeHtml(f.href)}"
              data-client="${f.client}"
              aria-label="Copy ${f.client} URL for ${escapedName}"
            >
              Copy URL
            </button>
          </li>
        `
      )
      .join('\n');
    result += html`
      <details
        class="rule"
        data-rule="${nameAttr}"
        data-name="${nameAttr}"
        data-clients="${clientDirs}"
        data-copy-scope
      >
        <summary class="rule-summary">
          <span class="rule-name">${escapedName}</span>
          <span class="avail" aria-hidden="true">${availHtml(rule)}</span>
          <span class="sr-only">可用格式:${clientNames}</span>
        </summary>
        <div class="rule-body">
          <div class="copied-strip" hidden>
            <span class="copied-status"></span>
            <input class="copied-url" type="text" readonly aria-label="已复制的 URL" />
            <button type="button" class="strip-close" aria-label="关闭">✕</button>
          </div>
          <ul class="fmt-list">
            ${rows}
          </ul>
        </div>
      </details>
    `;
  }
  return result;
}

/**
 * Render non-client roots (GeoIP / Mirror / Modules …) as a generic tree.
 * Flat roots open by default; deep roots stay collapsed.
 */
export function treeHtml(
  tree: TreeTypeArray,
  level = 0,
  parentPath = '',
  rootName = ''
): string {
  let result = '';
  const sortedTree = [...tree].sort(prioritySorter);

  for (let i = 0, len = sortedTree.length; i < len; i++) {
    const entry = sortedTree[i];

    if (entry.type === TreeFileType.DIRECTORY) {
      const isFlatRoot =
        level === 0 &&
        !entry.children.some(child => child.type === TreeFileType.DIRECTORY);
      const openAttr = isFlatRoot ? 'open' : '';
      const defaultOpenAttr = isFlatRoot ? ' data-default-open' : '';
      const folderPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const currentRoot = level === 0 ? entry.name : rootName;
      const fileCount = countListedFiles(entry);
      const children = treeHtml(entry.children, level + 1, folderPath, currentRoot);
      const escapedName = escapeHtml(entry.name);
      const nameAttr = escapeHtml(entry.name.toLowerCase());
      const pathAttr = escapeHtml(folderPath);
      // depth 1 sits under a visible root (Modules → Converted): no trail.
      // depth ≥ 2 needs path context (Mirror / DualSubs / sgmodule).
      const trailHtml =
        level >= 2 && parentPath
          ? html`<span class="folder-trail">${escapeHtml(parentPath.split('/').join(' / '))}</span>`
          : '';
      const countLabel = fileCount === 1 ? '1 file' : `${fileCount} files`;
      let depthClass = 'is-branch';
      if (level === 0) depthClass = 'is-root';
      else if (level === 1) depthClass = 'is-section';
      const copyScopeAttr = level === 0 ? ' data-copy-scope' : '';
      const stripHtml =
        level === 0
          ? html`
              <div class="copied-strip" hidden>
                <span class="copied-status"></span>
                <input class="copied-url" type="text" readonly aria-label="已复制的 URL" />
                <button type="button" class="strip-close" aria-label="关闭">✕</button>
              </div>
            `
          : '';
      const summaryInner = html`
        <summary class="folder-summary ${depthClass}" style="--depth: ${String(level)}">
          <span class="folder-summary-main">
            ${trailHtml}
            <span class="folder-name">${escapedName}</span>
          </span>
          <span class="folder-count" title="${countLabel}">${String(fileCount)}</span>
        </summary>
      `;

      if (level === 0) {
        result += html`
          <li
            class="folder"
            data-name="${nameAttr}"
            data-path="${pathAttr}"
            data-depth="${String(level)}"
            data-count="${String(fileCount)}"
            data-root="${escapeHtml(entry.name)}"
            style="--depth: ${String(level)}"
          >
            <details ${openAttr}${defaultOpenAttr}${copyScopeAttr}>
              ${summaryInner}
              ${stripHtml}
              <ul>
                ${children}
              </ul>
            </details>
          </li>
        `;
      } else {
        result += html`
          <li
            class="folder"
            data-name="${nameAttr}"
            data-path="${pathAttr}"
            data-depth="${String(level)}"
            data-count="${String(fileCount)}"
            style="--depth: ${String(level)}"
          >
            <details>
              ${summaryInner}
              <ul>
                ${children}
              </ul>
            </details>
          </li>
        `;
      }
    } else if (shouldListFile(entry.name)) {
      const encodedPath = encodeURI(entry.path);
      const pathAttr = escapeHtml(encodedPath);
      const escapedName = escapeHtml(entry.name);
      const platformRoot = rootName || '';
      result += html`
        <li
          class="file"
          data-name="${escapeHtml(entry.name.toLowerCase())}"
          data-path="${pathAttr}"
          data-platform-root="${escapeHtml(platformRoot)}"
        >
          <div class="file-row">
            <span class="file-main">
              ${platformRoot
                ? html`<span class="root-badge" data-root-badge>${escapeHtml(platformRoot)}</span>`
                : ''}
              <a class="file-link" href="${pathAttr}" target="_blank" rel="noopener noreferrer"
                >${escapedName}</a
              >
            </span>
            <button
              type="button"
              class="copy-btn"
              data-path="${pathAttr}"
              aria-label="Copy URL for ${escapedName}"
            >
              Copy URL
            </button>
          </div>
        </li>
      `;
    }
  }
  return result;
}

/**
 * Direction contract (2026-07, user-pinned):
 * THESIS: 规则是主实体,客户端格式是规则的输出;拒绝"四平台树 + 扩展名猜格式"的类目默认。
 * OWN-WORLD: warm paper austere workbench;Plex Sans/Mono;发丝线;ghost buttons;单 accent。
 * STORY: 访客搜规则名 → 展开卡片 → 按客户端名复制 URL → 驻留确认条核验。
 * FIRST VIEWPORT: 窄列;header → lede → sticky 搜索/chips → Rules 卡片索引(默认折叠)。
 * FORM: accordion rule cards(候选序第 1,优于 table / master-detail / chip-matrix /
 *       client-tabs);用户三选一钉定;无 seed(user-pinned direction)。
 */
function generateHtml(tree: TreeTypeArray) {
  const builtAt = buildTimestampGmt8();
  const { rules, restRoots } = collectRules(tree);
  const clientCount = CLIENT_DIRS.filter(c =>
    tree.some(e => e.type === TreeFileType.DIRECTORY && e.name === c.dir)
  ).length;
  const otherFileCount = restRoots.reduce((total, entry) => total + countListedFiles(entry), 0);

  return html`
    <!DOCTYPE html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>NRRule · personal rules index</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
        <meta name="description" content="Luck 自用的 Surge / Clash / Loon 规则镜像与索引" />
        <meta property="og:title" content="NRRule · personal rules index" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://github.com/lucking7/MirrRule" />
        <meta property="og:description" content="Luck 自用的 Surge / Clash / Loon 规则镜像与索引" />
        <meta name="twitter:card" content="summary" />
        <link rel="canonical" href="https://github.com/lucking7/NRRule" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <style>
          /* Impeccable · Austere Workbench (evolved 2026-07)
           * font system: IBM Plex only — Sans (UI) + Mono (paths / data)
           * light & dark tokens both verified ≥ WCAG AA 4.5:1 for text roles
           */
          :root {
            --color-paper: oklch(96% 0.01 85);
            --color-surface: oklch(98.5% 0.008 85);
            --color-ink: oklch(22% 0.02 60);
            --color-muted: oklch(28% 0.02 60);
            --color-line: oklch(86% 0.015 85);
            --color-accent: oklch(32% 0.09 45);
            --color-hot: oklch(93% 0.015 85);
            --color-focus: oklch(32% 0.09 45 / 0.28);
            /* Single family: Plex Sans for UI, Plex Mono for paths / data only */
            --font-ui: 'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif;
            --font-mono: 'IBM Plex Mono', ui-monospace, 'Menlo', 'Consolas', monospace;
            --text-base: 1rem;
            --text-sm: 0.875rem;
            --text-xs: 0.8125rem;
            --text-lg: 1.125rem;
            --text-xl: 1.375rem;
            --space-1: 0.25rem;
            --space-2: 0.5rem;
            --space-3: 0.75rem;
            --space-4: 1rem;
            --space-5: 1.25rem;
            --space-6: 1.5rem;
            --space-8: 2rem;
            --space-10: 2.5rem;
            --space-12: 3rem;
            --radius: 2px;
            --measure: 44rem;
            --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
            --dur-short: 140ms;
            color-scheme: light;
          }

          @media (prefers-color-scheme: dark) {
            :root {
              --color-paper: oklch(18% 0.015 60);
              --color-surface: oklch(21% 0.015 60);
              --color-ink: oklch(92% 0.015 85);
              --color-muted: oklch(68% 0.02 70);
              --color-line: oklch(32% 0.015 60);
              --color-accent: oklch(72% 0.08 55);
              --color-hot: oklch(26% 0.02 60);
              --color-focus: oklch(72% 0.08 55 / 0.28);
              color-scheme: dark;
            }
          }

          *,
          *::before,
          *::after {
            box-sizing: border-box;
          }

          html,
          body {
            margin: 0;
            padding: 0;
            background: var(--color-paper);
            color: var(--color-ink);
            font-family: var(--font-ui);
            font-size: var(--text-base);
            line-height: 1.5;
            overflow-x: clip;
            font-synthesis: none;
            text-rendering: optimizeLegibility;
          }

          a {
            color: var(--color-accent);
            text-decoration: none;
          }

          a:hover {
            text-decoration: underline;
            text-underline-offset: 0.12em;
          }

          a:focus-visible,
          button:focus-visible,
          input:focus-visible,
          summary:focus-visible {
            outline: 2px solid var(--color-accent);
            outline-offset: 2px;
          }

          button {
            font: inherit;
            color: inherit;
            background: transparent;
            cursor: pointer;
          }

          kbd {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            padding: 0.1rem 0.35rem;
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            color: var(--color-muted);
          }

          .shell {
            width: min(100% - 2 * var(--space-4), 52rem);
            margin: 0 auto;
            padding: var(--space-8) 0 var(--space-12);
            display: grid;
            gap: var(--space-5);
          }

          @media (min-width: 768px) {
            .shell {
              width: min(100% - 2 * var(--space-8), 52rem);
              padding-top: var(--space-10);
            }
          }

          .top {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            justify-content: space-between;
            gap: var(--space-3) var(--space-4);
            padding-bottom: var(--space-4);
            border-bottom: 1px solid var(--color-line);
          }

          .brand {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: var(--space-2) var(--space-3);
            min-width: 0;
          }

          .brand h1 {
            margin: 0;
            font-family: var(--font-ui);
            font-size: var(--text-xl);
            font-weight: 600;
            font-style: normal;
            letter-spacing: -0.02em;
            line-height: 1.2;
            color: var(--color-ink);
          }

          .brand .tag {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
            white-space: nowrap;
          }

          .meta-links {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-2) var(--space-3);
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
          }

          .meta-links a {
            color: var(--color-muted);
          }

          .meta-links a:hover {
            color: var(--color-ink);
          }

          .lede {
            margin: 0;
            max-width: var(--measure);
            font-size: var(--text-sm);
            color: var(--color-muted);
          }

          .build-line {
            margin: 0;
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
          }

          .platforms {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-2);
          }

          .chip {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            min-height: 2.75rem;
            padding: 0.4rem 0.8rem;
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            color: var(--color-muted);
            white-space: nowrap;
            transition:
              background-color var(--dur-short) var(--ease-out),
              color var(--dur-short) var(--ease-out),
              border-color var(--dur-short) var(--ease-out);
          }

          .chip:hover {
            border-color: var(--color-muted);
            color: var(--color-ink);
          }

          .chip.is-on {
            background: var(--color-ink);
            border-color: var(--color-ink);
            color: var(--color-paper);
          }

          .cmd-wrap {
            display: grid;
            gap: var(--space-2);
          }

          .cmd {
            display: flex;
            align-items: center;
            gap: var(--space-3);
            min-height: 2.75rem;
            padding: 0.65rem 0.75rem;
            background: var(--color-surface);
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
          }

          .cmd:focus-within {
            border-color: var(--color-accent);
            box-shadow: 0 0 0 3px var(--color-focus);
          }

          .cmd .prompt {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
            user-select: none;
          }

          .cmd input {
            flex: 1;
            min-width: 0;
            border: 0;
            background: transparent;
            color: var(--color-ink);
            font-family: var(--font-mono);
            font-size: var(--text-sm);
            outline: none;
            padding: 0;
          }

          .cmd input::placeholder {
            color: var(--color-muted);
            opacity: 0.8;
          }

          .cmd .cmd-actions {
            display: flex;
            align-items: center;
            gap: var(--space-2);
          }

          .cmd .clear-btn {
            position: relative;
            display: none;
            /* Action verb → Sans (data/identifiers stay Mono) */
            font-family: var(--font-ui);
            font-size: var(--text-xs);
            color: var(--color-muted);
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            padding: 0.35rem 0.5rem;
          }

          /* 44px touch floor without growing the search row: the visual chip stays
           * compact, the hit area extends past it. */
          .cmd .clear-btn::after {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            top: 50%;
            height: 2.75rem;
            translate: 0 -50%;
          }

          .cmd .clear-btn.is-visible {
            display: inline-flex;
            align-items: center;
          }

          .cmd .clear-btn:hover {
            color: var(--color-ink);
            border-color: var(--color-muted);
          }

          .quick {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-2);
          }

          .quick-chip {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            min-height: 2.75rem;
            padding: 0.35rem 0.7rem;
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            color: var(--color-muted);
            transition:
              color var(--dur-short) var(--ease-out),
              border-color var(--dur-short) var(--ease-out),
              background-color var(--dur-short) var(--ease-out);
          }

          .quick-chip:hover,
          .quick-chip.is-hot {
            color: var(--color-accent);
            border-color: var(--color-accent);
          }

          .controls {
            position: sticky;
            top: 0;
            z-index: 4;
            display: grid;
            gap: var(--space-3);
            padding: var(--space-2) 0 var(--space-3);
            background: var(--color-paper);
            border-bottom: 1px solid transparent;
          }

          .controls.is-stuck {
            border-bottom-color: var(--color-line);
          }

          .list-toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-2);
          }

          .result-count {
            min-height: 1.2em;
            margin: 0;
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
          }

          .list-toolbar .toggle-btn {
            /* Action verb → Sans (data/identifiers stay Mono) */
            font-family: var(--font-ui);
            font-size: var(--text-xs);
            min-height: 2.75rem;
            padding: 0.35rem 0.7rem;
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            color: var(--color-muted);
          }

          .list-toolbar .toggle-btn:hover {
            color: var(--color-ink);
            border-color: var(--color-muted);
          }

          .rules-section,
          .other-sections {
            display: grid;
            gap: var(--space-3);
          }

          .section-h {
            display: flex;
            align-items: baseline;
            gap: var(--space-2);
            margin: 0;
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--color-muted);
          }

          .section-h .section-count {
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            padding: 0.08rem 0.4rem;
            font-variant-numeric: tabular-nums;
          }

          /* ---- Rule cards (the core entity) ---- */

          .rule,
          .folder,
          .file {
            /* Clear the sticky controls when scrolled into view programmatically */
            scroll-margin-top: 16rem;
          }

          .rule-list {
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            background: var(--color-surface);
            overflow: hidden;
          }

          .rule {
            border-bottom: 1px solid var(--color-line);
          }

          .rule:last-child {
            border-bottom: 0;
          }

          .rule-summary {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            min-height: 3rem;
            padding: 0.3rem 0.85rem;
            cursor: pointer;
            list-style: none;
            font-family: var(--font-mono);
          }

          .rule-summary::-webkit-details-marker {
            display: none;
          }

          .rule-summary::before {
            content: '▸';
            flex: 0 0 auto;
            width: 1em;
            color: var(--color-muted);
            transition: transform var(--dur-short) var(--ease-out);
          }

          .rule[open] > .rule-summary::before {
            transform: rotate(90deg);
          }

          .rule-summary:hover {
            background: var(--color-hot);
          }

          .rule-name {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: var(--text-sm);
            font-weight: 600;
            color: var(--color-ink);
          }

          .avail {
            flex: 0 0 auto;
            display: flex;
            gap: 1px;
            font-size: var(--text-xs);
          }

          .av {
            width: 1.5em;
            text-align: center;
            font-weight: 600;
          }

          .av.is-on {
            color: var(--color-muted);
          }

          .av.is-off {
            color: var(--color-line);
          }

          .rule-body {
            border-top: 1px solid var(--color-line);
            background: color-mix(in oklch, var(--color-paper) 45%, var(--color-surface));
          }

          .fmt-list {
            list-style: none;
            margin: 0;
            padding: 0;
          }

          .fmt {
            display: grid;
            grid-template-columns: 5.5rem minmax(0, 1fr) auto;
            align-items: center;
            gap: var(--space-3);
            min-height: 3rem;
            padding: 0.2rem 0.85rem 0.2rem 2.1rem;
          }

          .fmt + .fmt {
            border-top: 1px solid var(--color-line);
          }

          .fmt-client {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            font-weight: 600;
            color: var(--color-ink);
          }

          .fmt-file {
            font-family: var(--font-mono);
            font-size: var(--text-sm);
            color: var(--color-muted);
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-decoration: underline;
            text-decoration-color: transparent;
            text-underline-offset: 0.12em;
          }

          .fmt-file:hover {
            color: var(--color-accent);
            text-decoration-color: var(--color-accent);
          }

          .fmt.is-hidden {
            display: none;
          }

          /* ---- Copy feedback strip (persistent, verifiable) ---- */

          .copied-strip {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            margin: var(--space-3) 0.85rem 0;
            padding: 0.4rem 0.6rem;
            border: 1px solid var(--color-accent);
            border-radius: var(--radius);
            background: color-mix(in oklch, var(--color-accent) 7%, var(--color-surface));
          }

          .copied-strip[hidden] {
            display: none;
          }

          .copied-status {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            font-weight: 600;
            color: var(--color-accent);
            white-space: nowrap;
          }

          .copied-strip.is-error {
            border-color: var(--color-ink);
            border-style: dashed;
          }

          .copied-strip.is-error .copied-status {
            color: var(--color-ink);
          }

          .copied-url {
            flex: 1;
            min-width: 0;
            border: 0;
            background: transparent;
            color: var(--color-ink);
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            outline: none;
            padding: 0.2rem 0;
          }

          .strip-close {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            min-height: 2.75rem;
            padding: 0.2rem 0.5rem;
            color: var(--color-muted);
          }

          .strip-close:hover {
            color: var(--color-ink);
          }

          /* ---- Generic tree for non-client roots (GeoIP / Mirror / …) ---- */

          .tree,
          .tree ul {
            list-style: none;
            margin: 0;
            padding: 0;
          }

          .tree-panel {
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            background: var(--color-surface);
            overflow: hidden;
          }

          .folder-summary {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-3);
            /* Depth-aware inset: root 0.85rem, then +0.9rem per level */
            padding: 0.55rem 0.85rem;
            padding-left: calc(0.85rem + (var(--depth, 0) * 0.9rem));
            border-bottom: 1px solid var(--color-line);
            cursor: pointer;
            list-style: none;
            font-family: var(--font-mono);
            color: var(--color-ink);
            background: transparent;
          }

          .tree summary::-webkit-details-marker {
            display: none;
          }

          .folder-summary::before {
            content: '▸';
            flex: 0 0 auto;
            display: inline-block;
            width: 1em;
            margin-right: 0.35rem;
            color: var(--color-muted);
            transition: transform var(--dur-short) var(--ease-out);
          }

          .tree details[open] > .folder-summary::before {
            transform: rotate(90deg);
          }

          /* Root section header (GeoIP, Mirror, Modules…) */
          .folder-summary.is-root {
            font-size: var(--text-xs);
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--color-muted);
            background: var(--color-surface);
            min-height: 3rem;
          }

          .folder-summary.is-root .folder-name {
            color: var(--color-muted);
          }

          /* Level-1 sections under a root (Modules → Converted / Merged / Rules) */
          .folder-summary.is-section {
            font-size: var(--text-sm);
            font-weight: 600;
            letter-spacing: 0;
            text-transform: none;
            color: var(--color-ink);
            min-height: 2.75rem;
            background: color-mix(in oklch, var(--color-paper) 55%, var(--color-surface));
            border-bottom: 1px solid var(--color-line);
          }

          .folder-summary.is-section:hover {
            background: var(--color-hot);
          }

          .folder-summary.is-section .folder-name {
            color: var(--color-ink);
          }

          .folder-summary.is-section .folder-count {
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            padding: 0.12rem 0.4rem;
            background: var(--color-surface);
          }

          /* Deeper branches (Mirror / DualSubs / sgmodule) */
          .folder-summary.is-branch {
            font-size: var(--text-xs);
            font-weight: 500;
            letter-spacing: 0;
            text-transform: none;
            color: var(--color-ink);
            min-height: 2.75rem;
          }

          .folder-summary.is-branch:hover {
            background: var(--color-hot);
          }

          .folder-summary-main {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 0.35rem 0.5rem;
            min-width: 0;
          }

          .folder-trail {
            color: var(--color-muted);
            font-weight: 400;
            font-size: var(--text-xs);
          }

          .folder-trail::after {
            content: '/';
            margin-left: 0.35rem;
            opacity: 0.7;
          }

          .folder-name {
            font-weight: 600;
            color: var(--color-ink);
          }

          .folder-count {
            flex: 0 0 auto;
            font-size: var(--text-xs);
            font-weight: 500;
            color: var(--color-muted);
            font-variant-numeric: tabular-nums;
          }

          .tree .folder ul {
            padding: 0;
          }

          .tree .folder .folder > details > ul {
            border-left: 1px solid var(--color-line);
            margin-left: calc(0.85rem + (var(--depth, 1) * 0.45rem));
          }

          .file-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: var(--space-3);
            align-items: center;
            min-height: 3rem;
            padding: 0.35rem 0.85rem;
            border-top: 1px solid var(--color-line);
          }

          .folder[data-depth] .file .file-row {
            padding-left: calc(0.85rem + ((var(--depth, 0) + 1) * 0.9rem));
          }

          .tree > .folder > details > ul > .file:first-child .file-row,
          .tree .folder .folder > details > ul > .file:first-child .file-row {
            border-top: 0;
          }

          .file-row:hover {
            background: var(--color-hot);
          }

          .file-main {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            min-width: 0;
          }

          .root-badge {
            flex: 0 0 auto;
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            font-weight: 600;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: var(--color-muted);
            border: 1px solid var(--color-line);
            border-radius: var(--radius);
            padding: 0.15rem 0.4rem;
          }

          .file-link {
            font-family: var(--font-mono);
            font-size: var(--text-sm);
            color: var(--color-muted);
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-decoration: underline;
            text-decoration-color: transparent;
            text-underline-offset: 0.12em;
          }

          .file-link:hover {
            color: var(--color-accent);
            text-decoration-color: var(--color-accent);
          }

          /* Ghost button: list rows stay quiet, state fills only on confirm.
           * Copy URL is an action verb → Sans; identifiers stay Mono. */
          .copy-btn {
            font-family: var(--font-ui);
            font-size: var(--text-xs);
            font-weight: 600;
            min-height: 2.75rem;
            min-width: 6.5rem;
            padding: 0.35rem 0.8rem;
            border: 1px solid var(--color-ink);
            border-radius: var(--radius);
            background: transparent;
            color: var(--color-ink);
            white-space: nowrap;
            transition:
              background-color var(--dur-short) var(--ease-out),
              color var(--dur-short) var(--ease-out),
              border-color var(--dur-short) var(--ease-out);
          }

          .copy-btn:hover {
            /* Ghost until confirm: hover stays quiet, no solid ink fill */
            background: var(--color-hot);
          }

          .copy-btn.is-done {
            border-color: var(--color-accent);
            color: var(--color-accent);
          }

          .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
          }

          .file.is-hidden,
          .folder.is-hidden,
          .rule.is-hidden,
          .other-sections.is-hidden {
            display: none;
          }

          .empty-state {
            display: none;
            padding: var(--space-10) var(--space-4);
            text-align: left;
            font-family: var(--font-ui);
            color: var(--color-muted);
          }

          .empty-state.is-visible {
            display: block;
          }

          .empty-state p {
            margin: 0 0 var(--space-2);
            font-size: var(--text-sm);
          }

          .empty-state .hint {
            font-family: var(--font-mono);
            font-size: var(--text-xs);
          }

          .colophon {
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: var(--space-2) var(--space-4);
            padding-top: var(--space-4);
            border-top: 1px solid var(--color-line);
            font-family: var(--font-mono);
            font-size: var(--text-xs);
            color: var(--color-muted);
          }

          .colophon a {
            color: var(--color-muted);
          }

          .colophon a:hover {
            color: var(--color-ink);
          }

          @media (max-width: 767px) {
            /* Mobile: sticky controls would eat half the viewport; keep them static */
            .controls {
              position: static;
            }

            .platforms {
              flex-wrap: nowrap;
              overflow-x: auto;
              scrollbar-width: none;
              margin: 0 calc(-1 * var(--space-4));
              padding: 0 var(--space-4);
            }

            .platforms::-webkit-scrollbar {
              display: none;
            }

            .fmt {
              grid-template-columns: 4.5rem minmax(0, 1fr) auto;
              padding-left: var(--space-4);
            }

            .copy-btn {
              min-width: 0;
              padding: 0.35rem 0.6rem;
            }

            .rule,
            .folder,
            .file {
              scroll-margin-top: 1rem;
            }
          }

          @media (prefers-reduced-motion: reduce) {
            *,
            *::before,
            *::after {
              transition: none !important;
            }
          }
        </style>
      </head>
      <body>
        <div class="shell">
          <header class="top">
            <div class="brand">
              <h1>NRRule</h1>
              <span class="tag">personal rules index</span>
            </div>
            <div class="meta-links">
              <a href="https://github.com/lucking7/MirrRule">Source</a>
              <a href="/LICENSE">AGPL-3.0</a>
              <a href="https://github.com/lucking7">@lucking7</a>
            </div>
          </header>

          <p class="lede">
            ${String(rules.length)} 条规则 × ${String(clientCount)} 客户端格式。搜规则名 → 展开卡片 →
            复制你客户端的 URL。
          </p>
          <p class="build-line">
            Last build <time datetime="${builtAt.iso}">${builtAt.display}</time>
          </p>

          <div class="controls" id="controls">
            <div class="platforms" id="platform-chips" role="toolbar" aria-label="客户端过滤">
              ${clientChipsHtml(tree)}
            </div>

            <div class="cmd-wrap">
              <div class="cmd">
                <span class="prompt" aria-hidden="true">find</span>
                <label class="sr-only" for="search-input">搜索规则与文件</label>
                <input
                  id="search-input"
                  type="search"
                  placeholder="Search rules…"
                  autocomplete="off"
                  spellcheck="false"
                  enterkeyhint="search"
                  aria-label="搜索规则与文件"
                />
                <div class="cmd-actions">
                  <button type="button" class="clear-btn" id="clear-btn" aria-label="清除搜索">
                    clear
                  </button>
                  <kbd>/</kbd>
                </div>
              </div>
              <div class="quick" id="quick-chips" aria-label="常用规则">
                ${quickChipsHtml()}
              </div>
              <div class="list-toolbar">
                <p class="result-count" id="search-result-count" aria-live="polite"></p>
                <button type="button" class="toggle-btn" id="toggle-btn">Expand all</button>
              </div>
            </div>
          </div>

          <section class="rules-section" aria-labelledby="rules-heading">
            <h2 class="section-h" id="rules-heading">
              Rules
              <span class="section-count">${String(rules.length)}</span>
            </h2>
            <div class="rule-list" id="rule-list">
              ${ruleCardsHtml(rules)}
            </div>
          </section>

          ${restRoots.length > 0
            ? html`
                <section class="other-sections" aria-labelledby="other-heading">
                  <h2 class="section-h" id="other-heading">
                    Other
                    <span class="section-count">${String(otherFileCount)}</span>
                  </h2>
                  <div class="tree-panel">
                    <ul class="tree" id="file-tree">
                      ${treeHtml(restRoots, 0)}
                    </ul>
                  </div>
                </section>
              `
            : ''}

          <div class="empty-state" id="empty-state">
            <p>无匹配结果。</p>
            <p class="hint">换个关键词,或按 Esc 清空。</p>
          </div>

          <p class="sr-only" id="status-live" aria-live="polite" aria-atomic="true"></p>

          <footer class="colophon">
            <span>MirrRule → NRRule</span>
            <span>规则索引 · 复制绝对 URL</span>
          </footer>
        </div>

        <script>
          (function () {
            const searchInput = document.getElementById('search-input');
            const clearBtn = document.getElementById('clear-btn');
            const resultCount = document.getElementById('search-result-count');
            const ruleList = document.getElementById('rule-list');
            const tree = document.getElementById('file-tree');
            const emptyState = document.getElementById('empty-state');
            const platformBar = document.getElementById('platform-chips');
            const quickBar = document.getElementById('quick-chips');
            const toggleBtn = document.getElementById('toggle-btn');
            const statusLive = document.getElementById('status-live');
            const PLATFORM_KEY = 'nrrule-platform';

            let activePlatform = 'all';
            let activeQuery = '';
            /** @type {Map<string, boolean> | null} */
            let openSnapshot = null;
            let wasSearching = false;
            let allExpanded = false;

            const ruleCards = ruleList ? [...ruleList.querySelectorAll('.rule')] : [];
            const clientNames = { List: 'Surge', Clash: 'Clash', Loon: 'Loon', 'sing-box': 'sing-box' };

            function absoluteUrl(filePath) {
              try {
                return new URL(filePath, window.location.origin).href;
              } catch {
                return filePath;
              }
            }

            function detailsKey(details) {
              if (details.classList.contains('rule')) {
                return 'r:' + (details.getAttribute('data-rule') || '');
              }
              const folder = details.closest('.folder');
              return folder ? 'f:' + (folder.getAttribute('data-path') || '') : '';
            }

            function allDetails() {
              const list = [...ruleCards];
              if (tree) list.push(...tree.querySelectorAll('details'));
              return list;
            }

            function snapshotOpenState() {
              const map = new Map();
              allDetails().forEach(function (details) {
                const key = detailsKey(details);
                if (key) map.set(key, details.open);
              });
              return map;
            }

            function defaultOpen(details) {
              if (details.classList.contains('rule')) return false;
              return details.hasAttribute('data-default-open');
            }

            function restoreOpenState(map) {
              allDetails().forEach(function (details) {
                const key = detailsKey(details);
                if (map && map.has(key)) {
                  details.open = Boolean(map.get(key));
                  return;
                }
                details.open = defaultOpen(details);
              });
            }

            function setAllOpen(open) {
              allExpanded = open;
              allDetails().forEach(function (details) {
                details.open = open;
              });
              toggleBtn.textContent = open ? 'Collapse' : 'Expand all';
              openSnapshot = null;
              wasSearching = false;
              if (statusLive) statusLive.textContent = open ? '已展开全部' : '已折叠全部';
            }

            async function copyPath(btn) {
              const filePath = btn.getAttribute('data-path');
              if (!filePath) return;
              const url = absoluteUrl(filePath);
              let ok = false;
              try {
                await navigator.clipboard.writeText(url);
                ok = true;
              } catch {
                try {
                  const ta = document.createElement('textarea');
                  ta.value = url;
                  ta.setAttribute('readonly', '');
                  ta.style.position = 'fixed';
                  ta.style.left = '-9999px';
                  document.body.appendChild(ta);
                  ta.select();
                  ok = document.execCommand('copy');
                  document.body.removeChild(ta);
                } catch {
                  ok = false;
                }
              }
              const client = btn.getAttribute('data-client');
              const scope = btn.closest('[data-copy-scope]');
              const strip = scope ? scope.querySelector('.copied-strip') : null;
              if (strip) {
                const status = strip.querySelector('.copied-status');
                const input = strip.querySelector('.copied-url');
                input.value = url;
                strip.classList.toggle('is-error', !ok);
                status.textContent = ok
                  ? client
                    ? 'Copied · ' + client
                    : 'Copied URL'
                  : '复制失败,请手动复制';
                strip.hidden = false;
                if (!ok) {
                  input.focus();
                  input.select();
                }
              }
              const prev = btn.textContent;
              btn.textContent = ok ? 'Copied' : 'Failed';
              btn.classList.add('is-done');
              window.setTimeout(function () {
                btn.textContent = prev || 'Copy URL';
                btn.classList.remove('is-done');
              }, 1400);
              if (statusLive) {
                statusLive.textContent = (ok ? '已复制 ' : '复制失败 ') + url;
              }
            }

            document.addEventListener('click', function (event) {
              const copyBtn = event.target.closest('.copy-btn');
              if (copyBtn) {
                event.preventDefault();
                copyPath(copyBtn);
                return;
              }
              const closeBtn = event.target.closest('.strip-close');
              if (closeBtn) {
                const strip = closeBtn.closest('.copied-strip');
                if (strip) strip.hidden = true;
              }
            });

            document.addEventListener('focusin', function (event) {
              if (event.target.classList && event.target.classList.contains('copied-url')) {
                event.target.select();
              }
            });

            function clientLabel(dir) {
              return clientNames[dir] || dir;
            }

            function cardHasClient(card) {
              if (activePlatform === 'all') return true;
              return (card.getAttribute('data-clients') || '')
                .split(' ')
                .includes(activePlatform);
            }

            function applyFilters() {
              const q = activeQuery.trim().toLowerCase();
              const searching = Boolean(q);

              if (searching && !wasSearching) {
                openSnapshot = snapshotOpenState();
              }
              if (!searching && wasSearching) {
                restoreOpenState(openSnapshot);
                openSnapshot = null;
              }
              wasSearching = searching;

              clearBtn.classList.toggle('is-visible', searching);
              setQuickHot(q);

              let matchCount = 0;

              // Rule cards: name match + client filter; format rows follow client filter.
              ruleCards.forEach(function (card) {
                const name = card.getAttribute('data-name') || '';
                const textOk = !q || name.includes(q);
                const show = textOk && cardHasClient(card);
                card.classList.toggle('is-hidden', !show);
                card.querySelectorAll('.fmt').forEach(function (row) {
                  row.classList.toggle(
                    'is-hidden',
                    activePlatform !== 'all' &&
                      row.getAttribute('data-client-dir') !== activePlatform
                  );
                });
                if (show) {
                  matchCount += 1;
                  if (searching) card.open = true;
                }
              });

              // Generic tree (GeoIP / Mirror / …): file-name/path match.
              if (tree) {
                const files = tree.querySelectorAll('.file');
                const folders = tree.querySelectorAll('.folder');

                files.forEach(function (li) {
                  li.classList.remove('is-hidden');
                });
                folders.forEach(function (li) {
                  li.classList.remove('is-hidden');
                });

                files.forEach(function (li) {
                  const name = li.getAttribute('data-name') || '';
                  const path = (li.getAttribute('data-path') || '').toLowerCase();
                  const folderPath =
                    (li.closest('.folder') && li.closest('.folder').getAttribute('data-path')) ||
                    '';
                  const textOk =
                    !q ||
                    name.includes(q) ||
                    path.includes(q) ||
                    folderPath.toLowerCase().includes(q);
                  li.classList.toggle('is-hidden', !textOk);
                  if (textOk) {
                    matchCount += 1;
                    if (searching) {
                      let parent = li.parentElement;
                      while (parent && parent !== tree) {
                        if (parent.classList && parent.classList.contains('folder')) {
                          parent.classList.remove('is-hidden');
                          const details = parent.querySelector(':scope > details');
                          if (details) details.open = true;
                        }
                        parent = parent.parentElement;
                      }
                    }
                  }
                });

                folders.forEach(function (folder) {
                  if (folder.classList.contains('is-hidden')) return;
                  if (!folder.querySelector('.file:not(.is-hidden)')) {
                    folder.classList.add('is-hidden');
                  }
                });

                // Hide the whole "other files" section when nothing inside is visible.
                const otherSection = tree.closest('.other-sections');
                if (otherSection) {
                  otherSection.classList.toggle(
                    'is-hidden',
                    !tree.querySelector('.file:not(.is-hidden)')
                  );
                }
              }

              const clientNote =
                activePlatform !== 'all' ? clientLabel(activePlatform) + ' formats' : '';
              if (matchCount > 0) {
                resultCount.textContent = q
                  ? matchCount + ' match' + (matchCount === 1 ? '' : 'es')
                  : clientNote;
                emptyState.classList.remove('is-visible');
              } else {
                resultCount.textContent = clientNote;
                emptyState.classList.add('is-visible');
              }
            }

            function performSearch(query) {
              activeQuery = query || '';
              applyFilters();
            }

            function setPlatform(name, persist) {
              activePlatform = name || 'all';
              document.body.setAttribute('data-platform', activePlatform);
              platformBar.querySelectorAll('.chip').forEach(function (chip) {
                const on = chip.getAttribute('data-platform') === activePlatform;
                chip.classList.toggle('is-on', on);
                chip.setAttribute('aria-pressed', on ? 'true' : 'false');
              });
              if (persist !== false) {
                try {
                  localStorage.setItem(PLATFORM_KEY, activePlatform);
                } catch {
                  /* ignore */
                }
              }
              applyFilters();
            }

            function setQuickHot(query) {
              quickBar.querySelectorAll('.quick-chip').forEach(function (chip) {
                chip.classList.toggle('is-hot', chip.getAttribute('data-query') === query);
              });
            }

            platformBar.addEventListener('click', function (event) {
              const chip = event.target.closest('.chip');
              if (!chip) return;
              setPlatform(chip.getAttribute('data-platform') || 'all');
            });

            quickBar.addEventListener('click', function (event) {
              const chip = event.target.closest('.quick-chip');
              if (!chip) return;
              const query = chip.getAttribute('data-query') || '';
              searchInput.value = query;
              performSearch(query);
              searchInput.focus();
            });

            clearBtn.addEventListener('click', function () {
              searchInput.value = '';
              performSearch('');
              searchInput.focus();
            });

            toggleBtn.addEventListener('click', function () {
              setAllOpen(!allExpanded);
            });

            searchInput.addEventListener('input', function (e) {
              performSearch(e.target.value);
            });

            document.addEventListener('keydown', function (e) {
              if (e.key === '/' && document.activeElement !== searchInput) {
                const tag = (document.activeElement && document.activeElement.tagName) || '';
                if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
                  e.preventDefault();
                  searchInput.focus();
                  searchInput.select();
                }
              }
              if (e.key === 'Escape' && document.activeElement === searchInput) {
                if (searchInput.value) {
                  searchInput.value = '';
                  performSearch('');
                } else {
                  searchInput.blur();
                }
              }
            });

            try {
              const saved = localStorage.getItem(PLATFORM_KEY);
              if (saved && platformBar.querySelector('[data-platform="' + saved + '"]')) {
                setPlatform(saved, false);
              } else {
                setPlatform('all', false);
              }
            } catch {
              setPlatform('all', false);
            }
          })();
        </script>
      </body>
    </html>
  `;
}
