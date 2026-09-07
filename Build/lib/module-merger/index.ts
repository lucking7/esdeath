/**
 * 模块合并器主入口
 */

import process from 'node:process';
import picocolors from 'picocolors';
import type { MergeResult, TemplateData, MergeRuntimeOptions, ModuleSource, SectionType } from './types';
import { prepareModuleContent } from './module-content';
import { writeModuleOutputs } from './output-writer';
import { ModuleMerger } from './merger';
import { TemplateEngine } from './template-engine';
import { loadMergeConfig } from './config-loader';
import { ModuleLoader } from './module-loader';
import { cleanPolicy, cleanPolicyForModule } from '../policy-cleaner';

/**
 * .sgmodule 输出中 Section 的固定排列顺序
 * MITM 单独处理（需要聚合 hostname），不在此列表中
 */
const SECTION_OUTPUT_ORDER: SectionType[] = [
  'General', 'Rule', 'URL Rewrite', 'Map Local', 'Script', 'Panel', 'Task',
];

/**
 * 合并模块
 * @param configPath 配置文件路径
 * @param runtimeOptions 运行时选项
 * @returns 合并结果
 */
export async function mergeModules(
  configPath: string,
  runtimeOptions: MergeRuntimeOptions = {}
): Promise<MergeResult> {
  console.log(picocolors.cyan('\nModule Merger\n'));

  // 1. 加载配置
  console.log(picocolors.gray('Loading configuration...'));
  const loadedConfig = await loadMergeConfig(configPath);
  const { config, baseDir } = loadedConfig;
  console.log(
    picocolors.green(`✓ Loaded config: ${config.name} (${config.modules.length} modules)`)
  );

  // 1.1 根据运行时选项筛选需要参与合并的模块
  const selectedModules = _applyModuleSelection(config.modules, runtimeOptions);
  if (!selectedModules.length) throw new Error('没有选中任何模块，拒绝生成空产物');
  console.log(
    picocolors.gray(
      `  - Modules selected for merge: ${selectedModules.length} / ${config.modules.length}`
    )
  );

  // 2. 下载模块（已保证按配置顺序返回）
  console.log(picocolors.cyan('\nDownloading modules...'));
  const loader = new ModuleLoader([baseDir, process.cwd()]);
  const { loaded, failures } = await loader.loadAll(selectedModules);
  loaded.forEach(module => {
    console.log(picocolors.green(`  ✓ ${module.header}`));
  });
  failures.forEach(failure => {
    console.log(picocolors.red(`  ✗ ${failure.header}: ${failure.reason}`));
  });
  if (failures.length) {
    throw new Error(`模块加载失败，未写入输出: ${failures.map(failure => `${failure.header}: ${failure.reason}`).join('; ')}`);
  }

  const merger = new ModuleMerger(config.options);
  const scriptHeaders = new Set<string>();
  const sourceByHeader = new Map(selectedModules.map(source => [source.header, source]));
  const sourceArguments = new Map<string, string>();
  const sourceDescriptions: string[] = [];

  loaded.forEach(module => {
    const toggleName = sourceByHeader.get(module.header)!.scriptToggle === false ? undefined : module.header.trim();
    const { sections, defaults, argumentsDesc } = prepareModuleContent(module, config.options.stripComments, toggleName);
    for (const [name, value] of defaults) {
      if (sourceArguments.has(name)) throw new Error(`参数名称冲突: ${name}`);
      sourceArguments.set(name, value);
    }
    if (argumentsDesc) sourceDescriptions.push(String.raw`${module.header} 源参数\n${argumentsDesc}`);
    sections.forEach(section => {
      if (section.type.toLowerCase() === 'script') {
        scriptHeaders.add(module.header);
      }
      merger.addSection(section);
    });
  });

  const scriptToggleInfo = _buildScriptToggleInfo(selectedModules, scriptHeaders);

  // 3. 合并
  console.log(picocolors.cyan('\nMerging sections...'));
  const { sections, hostnames } = merger.merge();

  // 4. 构建输出内容
  console.log(picocolors.cyan('\nBuilding output...'));

  const toggles = _buildArgumentsLines(scriptToggleInfo);
  for (const info of scriptToggleInfo) {
    if (sourceArguments.has(info.argumentName)) throw new Error(`脚本开关与源参数名称冲突: ${info.argumentName}`);
  }
  const argumentEntries = [toggles.argumentsLine, ...Array.from(sourceArguments, ([name, value]) => `${name}:${value}`)];
  const argumentsLine = argumentEntries.filter(Boolean).join(',');
  const argumentsDesc = [toggles.argumentsDesc, ...sourceDescriptions].filter(Boolean).join(String.raw`\n\n`);

  // 4.1 构建模板头部额外信息（arguments 等，仅在有脚本开关时才添加）
  const headerExtraParts: string[] = [];
  if (argumentsLine) {
    headerExtraParts.push(`#!arguments = ${argumentsLine}`, `#!arguments-desc = ${argumentsDesc}`);
  }

  // 4.2 动态构建 sections body
  const sectionParts: string[] = [];
  const usedSections = new Set<string>();

  for (const sectionType of SECTION_OUTPUT_ORDER) {
    let content = sections.get(sectionType)?.trim();
    if (!content) continue;

    usedSections.add(sectionType);

    // Rule section: 为 .sgmodule 输出补全 REJECT 等策略组
    if (sectionType === 'Rule') {
      content = content
        .split('\n')
        .map(line => cleanPolicyForModule(line))
        .join('\n');
    }

    sectionParts.push(`[${sectionType}]\n${content}`);
  }

  // MITM section（聚合所有模块的 hostname，始终输出）
  if (hostnames.length > 0) {
    sectionParts.push(`[MITM]\nhostname = %APPEND% ${hostnames.join(', ')}`);
  }
  if (!sectionParts.length) throw new Error('没有可输出的 section，拒绝生成空产物');

  // 检查是否有未被模板使用的 section 类型
  for (const [type] of sections) {
    if (type.toLowerCase() !== 'mitm' && !usedSections.has(type)) {
      console.log(
        picocolors.yellow(`  ⚠ Section [${type}] 存在于源模块中但未包含在输出中`)
      );
    }
  }

  // 4.3 渲染模板
  console.log(picocolors.cyan('\nRendering template...'));
  const template = await TemplateEngine.loadTemplate(config.output.template);

  const templateData: TemplateData = {
    name: config.name,
    description: config.description,
    category: config.category,
    author: config.author,
    currentDate: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
    header_extra: headerExtraParts.join('\n'),
    sections_body: sectionParts.join('\n\n'),
  };

  const sgmodule = TemplateEngine.render(template, templateData);
  if (argumentsLine && !sgmodule.includes(`#!arguments = ${argumentsLine}`)) {
    throw new Error('模板必须输出 header_extra 以保留模块参数');
  }

  // 5. 生成 rulelist（去除策略组，仅保留规则类型 + 匹配值 + 参数）
  const ruleContent = sections.get('Rule') || '';
  const rulelist = ruleContent
    .split('\n')
    .map(line => cleanPolicy(line))
    .join('\n');

  // 6. 写入文件
  if (runtimeOptions.dryRun) {
    console.log(picocolors.yellow('\nDRY RUN: 输出文件未写入磁盘'));
  } else {
    console.log(picocolors.cyan('\nWriting output files...'));
    await writeModuleOutputs([
      { path: config.output.sgmodule, content: sgmodule },
      { path: config.output.rulelist, content: rulelist },
    ]);

    console.log(picocolors.green(`  ✓ Saved: ${config.output.sgmodule}`));
    console.log(picocolors.green(`  ✓ Saved: ${config.output.rulelist}`));
  }

  const stats = merger.getStats();
  console.log(picocolors.green('\n✓ Merge completed'));
  console.log(picocolors.gray(`  - Modules processed: ${loaded.length}`));
  console.log(picocolors.gray(`  - Modules failed: ${failures.length}`));
  console.log(picocolors.gray(`  - Sections extracted: ${stats.sectionsExtracted}`));
  console.log(picocolors.gray(`  - Hostnames deduplicated: ${stats.hostnamesDeduplicated}`));

  return {
    sgmodule,
    rulelist,
    stats: {
      modulesProcessed: loaded.length,
      ...stats,
    },
  };
}

interface ScriptToggleInfo {
  header: string,
  argumentName: string,
  defaultOn: boolean
}

/* eslint-disable sukka/no-single-return -- helper functions use explicit early returns for readability */
/**
 * 根据运行时选项筛选需要参与合并的模块
 */
function _applyModuleSelection(
  modules: ModuleSource[],
  runtimeOptions: MergeRuntimeOptions
): ModuleSource[] {
  if (!modules.length) {
    return modules;
  }

  const onlyKeys = (runtimeOptions.only ?? []).map(_normalizeRuntimeKey);
  const enableKeys = (runtimeOptions.enable ?? []).map(_normalizeRuntimeKey);
  const disableKeys = (runtimeOptions.disable ?? []).map(_normalizeRuntimeKey);
  const availableKeys = new Set(modules.map(_getModuleKey));
  for (const key of [...onlyKeys, ...enableKeys, ...disableKeys]) {
    if (!availableKeys.has(key)) throw new Error(`未知模块 key: ${key}`);
  }

  const onlySet = onlyKeys.length ? new Set(onlyKeys) : null;
  const enableSet = new Set(enableKeys);
  const disableSet = new Set(disableKeys);

  return modules.filter(source => {
    const key = _getModuleKey(source);

    if (onlySet) {
      return onlySet.has(key);
    }

    const enabledFromSource = source.enabledByDefault;
    let enabled = enabledFromSource ?? true;

    if (enableSet.has(key)) {
      enabled = true;
    }

    if (disableSet.has(key)) {
      enabled = false;
    }

    return enabled;
  });
}

function _getModuleKey(source: ModuleSource): string {
  return source.key?.trim() ?? source.header.trim();
}

function _normalizeRuntimeKey(raw: string): string {
  return raw.trim();
}

/**
 * 构建脚本开关信息，按配置中模块顺序输出
 */
function _buildScriptToggleInfo(
  modules: ModuleSource[],
  scriptHeaders: Set<string>
): ScriptToggleInfo[] {
  const result: ScriptToggleInfo[] = [];

  for (const source of modules) {
    if (source.scriptToggle === false) {
      continue;
    }
    if (!scriptHeaders.has(source.header)) {
      continue;
    }

    const argumentName = source.header.trim();

    result.push({
      header: source.header,
      argumentName,
      defaultOn: source.scriptDefaultOn ?? false,
    });
  }

  return result;
}

/**
 * 生成 #!arguments 和 #!arguments-desc 内容
 * 默认值来自配置文件中各模块的 scriptDefaultOn 字段
 */
function _buildArgumentsLines(scriptToggles: ScriptToggleInfo[]): {
  argumentsLine: string,
  argumentsDesc: string
} {
  if (!scriptToggles.length) {
    return {
      argumentsLine: '',
      argumentsDesc: '',
    };
  }

  const argumentsLine = scriptToggles
    .map(info => {
      // 启用时必须为空，才能与源模块自己的 # 注释开关组合。
      const defaultValue = info.defaultOn ? '' : '#';
      return `${info.argumentName}:${defaultValue}`;
    })
    .join(',');

  const argumentsDesc = scriptToggles
    .map(
      info =>
        String.raw`${info.argumentName}: ${info.header}脚本开关\n删除 #（留空）启用，填入 # 禁用；源模块自身的脚本开关仍然有效`
    )
    .join(String.raw`\n\n`);

  return { argumentsLine, argumentsDesc };
}

/* eslint-enable sukka/no-single-return */

export type { MergeRuntimeOptions, MergeResult } from './types';
