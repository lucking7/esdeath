/**
 * 简单的模板引擎
 * 支持占位符替换: {{variable}} 和 {{{section}}}
 */

import fs from 'node:fs/promises';

/**
 * 模板引擎类
 */
export const TemplateEngine = {
  /**
   * 渲染模板
   * @param template 模板字符串
   * @param data 数据对象
   * @returns 渲染后的字符串
   */
  render(
    template: string,
    data: Record<string, string | number | boolean | null | undefined>
  ): string {
    // 单次替换，避免解释正文中的 $& / $$，或再次展开插入的 Surge 参数。
    return template.replaceAll(/{{{([^{}]+)}}}|{{([^{}]+)}}/g, (match, triple: string | undefined, double: string | undefined) => {
      const key = triple ?? double!;
      return Object.hasOwn(data, key) ? String(data[key] ?? '') : match;
    });
  },

  /**
   * 从文件加载模板
   * @param filePath 模板文件路径
   * @returns 模板内容
   */
  async loadTemplate(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  },
};
