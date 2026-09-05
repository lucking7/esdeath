import { asyncWriteToStream } from 'foxts/async-write-to-stream';
import { fastStringArrayJoin } from 'foxts/fast-string-array-join';
import fs from 'node:fs';
import readline from 'node:readline';
import { dirname } from 'node:path';
import picocolors from 'picocolors';
import type { Span } from '../trace';
import { writeFile, mkdirp } from './misc';
import { createCompareSource, fileEqualWithCommentComparator } from 'foxts/compare-source';

function readFileByLine(file: string): AsyncIterable<string> {
  return readline.createInterface({
    input: fs.createReadStream(file/* , { encoding: 'utf-8' } */),
    crlfDelay: Infinity
  });
}

const fileEqual = createCompareSource(fileEqualWithCommentComparator);

/**
 * 输出文件（兼容旧代码）
 * @param filePath - 文件路径
 * @param content - 文件内容
 */
async function _outputFile(filePath: string, content: string): Promise<void> {
  await mkdirp(dirname(filePath));
  return writeFile(filePath, content);
}

export async function compareAndWriteFile(span: Span, linesA: string[], filePath: string) {
  const isEqual = await span.traceChildAsync<boolean>(`compare ${filePath}`, async () => {
    if (fs.existsSync(filePath)) {
      return fileEqual(linesA, readFileByLine(filePath));
    }

    console.log(`${filePath} does not exists, writing...`);
    return false;
  });

  if (isEqual) {
    console.log(picocolors.gray(picocolors.dim(`same content, bail out writing: ${filePath}`)));
    return;
  }

  return span.traceChildAsync<void>(`writing ${filePath}`, async () => {
    const linesALen = linesA.length;

    // The default highwater mark is normally 16384,
    // So we make sure direct write to file if the content is
    // most likely less than 500 lines
    if (linesALen < 500) {
      return writeFile(filePath, fastStringArrayJoin(linesA, '\n') + '\n');
    }

    // 确保目录存在（对于大文件使用 createWriteStream 时）
    const p = mkdirp(dirname(filePath));
    if (p) await p;

    const writeStream = fs.createWriteStream(filePath);

    try {
      for (let i = 0; i < linesALen; i++) {
        const p = asyncWriteToStream(writeStream, linesA[i] + '\n');
        // eslint-disable-next-line no-await-in-loop -- stream high water mark
        if (p) await p;
      }

      // Wait for stream to fully close
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => {
          writeStream.close(err => {
            if (err) reject(err);
            else resolve();
          });
        });
        writeStream.on('error', reject);
        writeStream.end();
      });
    } catch (error) {
      writeStream.destroy();
      throw error;
    }
  });
}
