import process from 'node:process';
import { dirname } from 'node:path';
import fs from 'node:fs';
import type { PathLike } from 'node:fs';
import fsp from 'node:fs/promises';
import { appendArrayInPlace } from 'foxts/append-array-in-place';

export function fastStringCompare(a: string, b: string) {
  const lenA = a.length;
  const lenB = b.length;
  const minLen = lenA < lenB ? lenA : lenB;

  for (let i = 0; i < minLen; ++i) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);

    if (ca > cb) return 1;
    if (ca < cb) return -1;
  }

  if (lenA === lenB) {
    return 0;
  }

  return lenA > lenB ? 1 : -1;
};

interface Write {
  (
    destination: string,
    input: NodeJS.TypedArray | string,
  ): Promise<void>
}

export type VoidOrVoidArray = void | VoidOrVoidArray[];

export function mkdirp(dir: string) {
  if (fs.existsSync(dir)) {
    return;
  }
  return fsp.mkdir(dir, { recursive: true });
}

export const writeFile: Write = async (destination: string, input, dir = dirname(destination)): Promise<void> => {
  const p = mkdirp(dir);
  if (p) {
    await p;
  }
  return fsp.writeFile(destination, input, { encoding: 'utf-8' });
};

export function withBannerArray(title: string, description: string[] | readonly string[], date: Date, content: string[]) {
  const result: string[] = [
    '#########################################',
    `# ${title}`,
    `# Last Updated: ${date.toISOString()}`,
    `# Size: ${content.length}`
  ];

  appendArrayInPlace(result, description.map(line => (line ? `# ${line}` : '#')));

  result.push('#########################################');

  appendArrayInPlace(result, content);

  result.push('################## EOF ##################', '');

  return result;
};

function _notSupported(name: string) {
  return (...args: unknown[]) => {
    console.error(`${name}: not supported.`, args);
    throw new Error(`${name}: not implemented.`);
  };
}

export function withIdentityContent(title: string, description: string[] | readonly string[], date: Date, content: string[]) {
  return content;
};

export function isDirectoryEmptySync(path: PathLike) {
  const directoryHandle = fs.opendirSync(path);

  try {
    return directoryHandle.readSync() === null;
  } finally {
    directoryHandle.closeSync();
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STARTS_WITH_DIGIT = /^\d/;

const GEOSITE_PREFIXES: ReadonlyArray<{ prefix: string; type: string; strip?: string }> = [
  { prefix: '+.', type: 'DOMAIN-SUFFIX' },
  { prefix: 'full:', type: 'DOMAIN' },
  { prefix: 'domain:', type: 'DOMAIN-SUFFIX', strip: '+.' },
  { prefix: 'keyword:', type: 'DOMAIN-KEYWORD' },
];

/**
 * 简单规则格式转换（输入应已 trim）：
 * - `+.example.com` → `DOMAIN-SUFFIX,example.com`
 * - `full:example.com` → `DOMAIN,example.com`
 * - `domain:example.com` → `DOMAIN-SUFFIX,example.com`
 * - `keyword:example` → `DOMAIN-KEYWORD,example`
 * - `.example.com` → `DOMAIN-SUFFIX,example.com`
 * - `example.com`（纯域名，无逗号）→ `DOMAIN,example.com`
 * - 其他规则原样返回
 */
export function smartConvertRule(rule: string): string {
  if (!rule || rule.includes(',')) return rule;

  for (const { prefix, type, strip } of GEOSITE_PREFIXES) {
    if (rule.startsWith(prefix)) {
      let value = rule.slice(prefix.length);
      if (strip && value.startsWith(strip)) value = value.slice(strip.length);
      if (value) return `${type},${value}`;
    }
  }

  if (rule.startsWith('.')) {
    const domain = rule.slice(1);
    if (domain) return `DOMAIN-SUFFIX,${domain}`;
  } else if (
    !rule.startsWith('#') &&
    !rule.startsWith('!') &&
    !rule.startsWith('//') &&
    !rule.startsWith(';') &&
    !STARTS_WITH_DIGIT.test(rule)
  ) {
    return `DOMAIN,${rule}`;
  }

  return rule;
}

export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  });
}
