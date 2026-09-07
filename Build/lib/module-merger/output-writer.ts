/* eslint-disable no-await-in-loop -- Staging, replacement and rollback require ordered I/O. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Stage both outputs before replacement; restore earlier replacements on an I/O failure. */
export async function writeModuleOutputs(outputs: Array<{ path: string, content: string }>): Promise<void> {
  const entries = outputs.map(output => ({
    ...output,
    staged: `${output.path}.${randomUUID()}.tmp`,
    backup: `${output.path}.${randomUUID()}.bak`,
    existed: false,
    replaced: false,
    retainBackup: false,
  }));

  try {
    for (const entry of entries) {
      await fs.mkdir(path.dirname(entry.path), { recursive: true });
      const stat = await fs.lstat(entry.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && !stat.isFile()) throw new Error(`输出不是普通文件: ${entry.path}`);
      if (stat) {
        await fs.copyFile(entry.path, entry.backup, fs.constants.COPYFILE_EXCL);
        entry.existed = true;
      }
      await fs.writeFile(entry.staged, entry.content, { flag: 'wx' });
    }

    for (const entry of entries) {
      await fs.rename(entry.staged, entry.path);
      entry.replaced = true;
    }
  } catch (error) {
    const errors = [error];
    for (const entry of entries.toReversed()) {
      if (!entry.replaced) continue;
      try {
        if (entry.existed) await fs.rename(entry.backup, entry.path);
        else await fs.rm(entry.path);
      } catch (rollbackError) {
        entry.retainBackup = true;
        errors.push(new Error(`回滚失败，备份保留在 ${entry.backup}`, { cause: rollbackError }));
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, '模块输出失败且回滚未完成', { cause: error });
    throw error;
  } finally {
    for (const entry of entries) {
      await fs.rm(entry.staged, { force: true });
      if (!entry.retainBackup) await fs.rm(entry.backup, { force: true });
    }
  }
}
