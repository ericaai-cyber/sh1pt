import { describe, it, expect } from 'vitest';
import { renderPack } from '@profullstack/sh1pt-actions-fleet-core';
import { loadBuiltinPacks } from './index.js';

describe('built-in packs', () => {
  it('loads the node-pnpm-ci pack', async () => {
    const catalog = await loadBuiltinPacks();
    const entry = catalog.get('node-pnpm-ci');
    expect(entry).toBeDefined();
    expect(entry?.manifest.name).toBe('Node pnpm CI');
    expect(entry?.manifest.files[0]?.destination).toBe('.github/workflows/ci.yml');
  });

  it('renders node-pnpm-ci with default inputs', async () => {
    const catalog = await loadBuiltinPacks();
    const entry = catalog.get('node-pnpm-ci');
    if (!entry) throw new Error('node-pnpm-ci not in catalog');
    const result = await renderPack({
      packDir: entry.packDir,
      manifest: entry.manifest,
      inputs: {},
    });
    const file = result.files[0];
    expect(file?.destination).toBe('.github/workflows/ci.yml');
    expect(file?.content).toContain("node-version: '22'");
    expect(file?.content).toContain('version: 9');
    expect(file?.content).toContain('pnpm install --frozen-lockfile');
    expect(file?.content).toContain('${{ github.workflow }}');
    expect(file?.content).toContain('# Managed by sh1pt Actions Fleet');
  });

  it('honors overridden inputs', async () => {
    const catalog = await loadBuiltinPacks();
    const entry = catalog.get('node-pnpm-ci');
    if (!entry) throw new Error('node-pnpm-ci not in catalog');
    const result = await renderPack({
      packDir: entry.packDir,
      manifest: entry.manifest,
      inputs: { nodeVersion: '20', testCommand: 'pnpm run test:ci' },
    });
    const file = result.files[0];
    expect(file?.content).toContain("node-version: '20'");
    expect(file?.content).toContain('pnpm run test:ci');
  });
});
