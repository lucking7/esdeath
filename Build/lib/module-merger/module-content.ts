import { createHash } from 'node:crypto';
import type { LoadedModule, ParsedSection } from './types';
import { SectionParser } from './section-parser';

/** Import source-local parameters and script identifiers into a shared module. */
export function prepareModuleContent(module: LoadedModule, stripComments: boolean, toggleName?: string) {
  const namespace = `m_${createHash('sha256').update(module.header).digest('hex').slice(0, 16)}`;
  const defaults = new Map<string, string>();
  const names = new Map<string, string>();
  const preamble = module.content.split(/^\s*\[/m, 1)[0];
  for (const match of preamble.matchAll(/^#!arguments[\t ]*=(.*)$/gm)) {
    for (const entry of splitArguments(match[1])) {
      const colon = entry.indexOf(':');
      const name = entry.slice(0, colon).trim();
      if (colon < 1 || !name || /[\n\r,{}]/.test(name) || names.has(name)) {
        throw new Error(`${module.header}: 无效或重复的参数 ${entry}`);
      }
      const importedName = `${namespace}_${name}`;
      names.set(name, importedName);
      defaults.set(importedName, entry.slice(colon + 1).trim());
    }
  }

  const sections = SectionParser.parse(module.content, { header: module.header, stripComments });
  if (!sections.some(section => section.content.split('\n').some(isActiveLine))) {
    throw new Error(`${module.header}: 没有可合并的有效 section`);
  }
  for (const section of sections) {
    section.content = section.content.split('\n').map(line => {
      if (!isActiveLine(line)) return line;
      return line.replaceAll(/{{{([^{}]+)}}}/g, (_match, name: string) => {
        const importedName = names.get(name);
        if (!importedName) {
          throw new Error(`${module.header}: 参数 ${name} 未定义`);
        }
        return `{{{${importedName}}}}`;
      });
    }).join('\n');
  }

  renameScripts(sections, namespace, module.header, toggleName);

  const description = /^#!arguments-desc[\t ]*=(.*)$/m.exec(preamble)?.[1].trim();
  const argumentsDesc = description
    ? description.replaceAll(/(^|\\n)([^\n:\\]+):/g, (match, separator: string, name: string) => {
      const importedName = names.get(name.trim());
      return importedName ? `${separator}${importedName}:` : match;
    })
    : Array.from(names, ([name, importedName]) => `${importedName}: ${module.header} / ${name}`).join(String.raw`\n`);

  return { sections, defaults, argumentsDesc };
}

function isActiveLine(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !/^(?:#|\/\/|!)/.test(trimmed);
}

/** Commas inside quoted or escaped defaults belong to the value. */
function splitArguments(raw: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === ',') {
      entries.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || escaped) throw new Error('参数默认值的引号或转义未闭合');
  entries.push(raw.slice(start));
  return entries.filter(entry => entry.trim());
}

function renameScripts(sections: ParsedSection[], namespace: string, header: string, toggleName?: string): void {
  const scriptsByName = new Map<string, string[]>();
  const sequence = { value: 0 };
  for (const section of sections) {
    if (section.type !== 'Script') continue;
    section.content = section.content.split('\n').map(line => {
      if (!isActiveLine(line)) return line;
      const trimmed = line.trim();
      const equals = trimmed.indexOf('=');
      const left = trimmed.slice(0, equals).trim();
      const definition = trimmed.slice(equals + 1).trim();
      const toggles = /^(?:{{{[^{}]+}}})*/.exec(left)![0];
      const originalName = left.slice(toggles.length).trim();
      if (equals < 1 || !originalName || !/^type\s*=/.test(definition)) {
        throw new Error(`${header}: 无效的 Script 行: ${line}`);
      }
      const renamed = `${namespace}_${++sequence.value}_${originalName}`;
      const existing = scriptsByName.get(originalName) ?? [];
      existing.push(renamed);
      scriptsByName.set(originalName, existing);
      return `${toggleName ? `{{{${toggleName}}}}` : ''}${toggles}${renamed} = ${definition}`;
    }).join('\n');
  }

  for (const section of sections) {
    if (section.type !== 'Panel') continue;
    section.content = section.content.replaceAll(/(\bscript-name\s*=)([^\n\r,]+)/g, (_match, prefix: string, rawName: string) => {
      const name = rawName.trim().replaceAll(/^["']|["']$/g, '');
      const candidates = scriptsByName.get(name);
      if (candidates?.length !== 1) {
        throw new Error(`${header}: Panel 引用的脚本 ${name} 缺失或重名`);
      }
      return `${prefix}${candidates[0]}`;
    });
  }
}
