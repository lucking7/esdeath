import { TreeFileType } from './tree-dir.ts';
import type { TreeType } from './tree-dir.ts';
import { fastStringCompare } from './misc.ts';

/**
 * Real public/ output roots in index display order: client ruleset dirs first,
 * then GeoIP data, then mirrored artifacts. Only names that can actually appear
 * in public/ belong here — this map drives both index sorting and the
 * public/_headers ruleset sections. The fallback priority is a separate
 * constant so it never leaks into Object.keys consumers.
 */
export const priorityOrder: Record<string, number> = {
  List: 40,
  Loon: 50,
  Clash: 70,
  'sing-box': 80,
  GeoIP: 90,
  Mock: 140,
  Modules: 200,
  Scripts: 210,
  Mirror: 220
};

const DEFAULT_PRIORITY = Number.MAX_VALUE;

export function prioritySorter(a: TreeType, b: TreeType) {
  // 1. 类型优先：目录 > 文件
  if (a.type !== b.type) {
    return a.type === TreeFileType.DIRECTORY ? -1 : 1;
  }

  // 2. 优先级数值排序
  const priorityDiff =
    (priorityOrder[a.name] ?? DEFAULT_PRIORITY) -
    (priorityOrder[b.name] ?? DEFAULT_PRIORITY);

  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  // 3. 同优先级内按字母序
  return fastStringCompare(a.name, b.name);
}
