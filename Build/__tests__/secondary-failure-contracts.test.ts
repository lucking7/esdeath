/* eslint-disable @typescript-eslint/no-require-imports -- CJS project, node:test requires require() for SWC compat */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

describe('shared secondary pipeline failure contract', () => {
  it('fails only when a required asset fails', () => {
    const { hasRequiredFailures } = require('../integration/mirror-sync/sync-engine');
    assert.equal(hasRequiredFailures({ total: 1, succeeded: 0, skipped: 0, failed: [
      { asset: 'optional', error: 'offline', required: false },
    ] }), false);
    assert.equal(hasRequiredFailures({ total: 1, succeeded: 0, skipped: 0, failed: [
      { asset: 'required', error: 'offline', required: true },
    ] }), true);
  });

  it('does not overwrite a valid destination when post-processing fails', async () => {
    const { FileType, syncRepository } = require('../integration/mirror-sync/sync-engine');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mirrrule-post-process-'));
    const destination = path.join(dir, 'sgmodule', 'asset.sgmodule');
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'valid-existing-content');
    const result = await syncRepository({
      repo: 'owner/repo', outputDir: dir, allowedTypes: [FileType.SGMODULE],
      postProcess() { throw new Error('processor failed'); },
    }, {
      fetchRelease: () => Promise.resolve({
        tag_name: 'v1', name: 'v1', html_url: 'https://example.test',
        assets: [{ name: 'asset.sgmodule', url: 'asset-url', browser_download_url: 'asset-url', size: 20 }],
      }),
      download: () => Promise.resolve(Buffer.from('different raw content')),
    });
    assert.equal(result.failed.length, 1);
    assert.equal(await fsp.readFile(destination, 'utf8'), 'valid-existing-content');
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('fmz200 CLI decision', () => {
  it('rejects required partial and total failures but accepts success', () => {
    const { assertFmz200Success } = require('../download-fmz200-split');
    assert.doesNotThrow(() => assertFmz200Success({ total: 2, succeeded: 2, failed: [], skipped: 0 }));
    assert.throws(() => assertFmz200Success({ total: 2, succeeded: 1, skipped: 0, failed: [
      { asset: 'one', error: 'failed', required: true },
    ] }));
    assert.throws(() => assertFmz200Success({ total: 2, succeeded: 0, skipped: 0, failed: [
      { asset: 'one', error: 'failed', required: true },
      { asset: 'two', error: 'failed', required: true },
    ] }));
  });
});

describe('mock/modules CLI decision', () => {
  it('rejects required per-file and extraction failures', () => {
    const { assertMockModulesSuccess } = require('../download-mock-modules');
    for (const asset of ['Mock/file.txt', 'tar-extraction']) {
      assert.throws(() => assertMockModulesSuccess({ total: 1, succeeded: 0, skipped: 0, failed: [
        { asset, error: 'injected failure', required: true },
      ] }));
    }
  });
});
