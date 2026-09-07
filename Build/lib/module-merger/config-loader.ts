import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import type {
  MergeConfig,
  MergeConfigFile,
  MergeOptions,
  OutputConfig
} from './types';

type ValidatedMergeConfig = MergeConfigFile & Required<Pick<MergeConfigFile, 'modules' | 'output'>>;

export interface LoadedMergeConfig {
  config: MergeConfig,
  absolutePath: string,
  baseDir: string
}

const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  deduplicateHostnames: true,
  stripComments: true,
  addDividers: true,
  dividerLength: 30
};

export async function loadMergeConfig(configPath: string): Promise<LoadedMergeConfig> {
  const absolutePath = resolveAbsolute(configPath);
  const raw = await fs.readFile(absolutePath, 'utf-8');
  const parsed = YAML.parse(raw) as MergeConfigFile | undefined;

  if (!parsed) {
    throw new Error('配置文件内容为空');
  }

  validateBasicFields(parsed);

  const baseDir = path.dirname(absolutePath);
  const options: MergeOptions = {
    ...DEFAULT_MERGE_OPTIONS
  };
  if (parsed.options) {
    Object.assign(options, parsed.options);
  }

  const normalizedOutput: OutputConfig = {
    sgmodule: resolveRelative(parsed.output.sgmodule, baseDir),
    rulelist: resolveRelative(parsed.output.rulelist, baseDir),
    template: resolveRelative(parsed.output.template, baseDir)
  };
  if (normalizedOutput.sgmodule === normalizedOutput.rulelist) {
    throw new Error('output.sgmodule 和 output.rulelist 必须是不同文件');
  }

  const config: MergeConfig = {
    ...parsed,
    modules: parsed.modules.map(source => ({ ...source })),
    output: normalizedOutput,
    options
  };

  return {
    config,
    absolutePath,
    baseDir
  };
}

function resolveAbsolute(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
}

function resolveRelative(target: string, baseDir: string): string {
  if (path.isAbsolute(target)) {
    return target;
  }

  const usesRelativeBase = target.startsWith('./') || target.startsWith('../');
  const base = usesRelativeBase ? baseDir : process.cwd();
  return path.resolve(base, target);
}

function validateBasicFields(config: MergeConfigFile): asserts config is ValidatedMergeConfig {
  if (!config.name) {
    throw new Error('配置文件必须包含 name');
  }

  const modules = config.modules;
  if (!modules?.length) {
    throw new Error('配置文件必须至少包含一个 module');
  }

  const output = config.output;
  if (!output?.sgmodule || !output.rulelist || !output.template) {
    throw new Error('output.sgmodule、output.rulelist、output.template 不能为空');
  }

  const invalidSource = modules.find(source => !source.url || !source.header);
  if (invalidSource) {
    throw new Error(`模块 ${invalidSource.header} 缺少 url 或 header`);
  }

  const headers = new Set<string>();
  const keys = new Set<string>();
  for (const source of modules) {
    const header = source.header.trim();
    const key = (source.key ?? source.header).trim();
    if (!header || !key || /[\n\r,:{}]/.test(header)) {
      throw new Error(`模块名称或 key 无效: ${source.header}`);
    }
    if (headers.has(header) || keys.has(key)) {
      throw new Error(`模块 header 和 key 必须唯一: ${source.header}`);
    }
    headers.add(header);
    keys.add(key);
  }
}
