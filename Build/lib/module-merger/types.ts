/**
 * 模块合并器类型定义
 */

/**
 * 模块合并配置
 */
export interface MergeConfig {
  /** 模块名称 */
  name: string,
  /** 版本号 */
  version: string,
  /** 描述 */
  description: string,
  /** 分类 */
  category: string,
  /** 作者 */
  author: string,
  /** 要合并的模块列表 */
  modules: ModuleSource[],
  /** 输出配置 */
  output: OutputConfig,
  /** 合并选项 */
  options: MergeOptions
}

/**
 * 原始配置文件 (options 允许部分填写)
 */
export interface MergeConfigFile extends Omit<MergeConfig, 'modules' | 'output' | 'options'> {
  modules?: ModuleSource[],
  output?: OutputConfig,
  options?: Partial<MergeOptions>
}

/**
 * 模块来源
 */
export interface ModuleSource {
  /** 模块的 URL 地址 */
  url: string,
  /** 模块的显示名称(用于分隔符) */
  header: string,
  /** 可选的模块唯一键（用于命令行筛选和参数命名） */
  key?: string,
  /** 是否默认启用此模块（未指定时默认为 true） */
  enabledByDefault?: boolean,
  /** 是否为该模块生成脚本开关参数（未指定时默认为 true） */
  scriptToggle?: boolean,
  /** 脚本开关参数是否默认开启（未指定时默认为 false，即默认关闭） */
  scriptDefaultOn?: boolean
}

/**
 * 输出配置
 */
export interface OutputConfig {
  /** 合并后的 .sgmodule 文件路径 */
  sgmodule: string,
  /** 提取的规则列表文件路径 */
  rulelist: string,
  /** 模板文件路径 */
  template: string
}

/**
 * 合并选项
 */
export interface MergeOptions {
  /** 是否去重 MITM hostnames */
  deduplicateHostnames: boolean,
  /** 是否移除注释 */
  stripComments: boolean,
  /** 是否添加分隔符 */
  addDividers: boolean,
  /** 分隔符长度 */
  dividerLength: number
}

/**
 * 运行时选项
 */
export interface MergeRuntimeOptions {
  /** 是否仅模拟输出 */
  dryRun?: boolean,
  /** 仅合并指定 key 的模块（逗号分隔，优先级最高） */
  only?: string[],
  /** 额外启用的模块 key 列表 */
  enable?: string[],
  /** 额外禁用的模块 key 列表 */
  disable?: string[]
}

/**
 * Section 类型使用字符串,便于扩展
 */
export type SectionType = string;

/**
 * 解析后的 Section
 */
export interface ParsedSection {
  /** Section 类型 */
  type: SectionType,
  /** Section 内容 */
  content: string,
  /** 来源模块的 header */
  header?: string
}

/**
 * 已加载的模块
 */
export interface LoadedModule {
  header: string,
  url: string,
  content: string,
  source: 'local' | 'remote'
}

/**
 * 模块加载失败信息
 */
export interface ModuleLoadError {
  header: string,
  url: string,
  reason: string
}

/**
 * 合并结果
 */
export interface MergeResult {
  /** 合并后的 sgmodule 内容 */
  sgmodule: string,
  /** 提取的规则列表内容 */
  rulelist: string,
  /** 统计信息 */
  stats: MergeStats,
}

/**
 * 合并统计信息
 */
interface MergeStats {
  /** 处理的模块数量 */
  modulesProcessed: number,
  /** 提取的 Section 数量 */
  sectionsExtracted: number,
  /** 去重的 hostname 数量 */
  hostnamesDeduplicated: number
}

/**
 * 模板数据
 */
export interface TemplateData {
  /** 模块名称 */
  name: string,
  /** 描述 */
  description: string,
  /** 分类 */
  category: string,
  /** 作者 */
  author: string,
  /** 当前日期 */
  currentDate: string,
  /** 模板头部额外行（arguments 等） */
  header_extra: string,
  /** 动态生成的 sections 内容 */
  sections_body: string,
  /** 其他动态字段 */
  [key: string]: string
}
