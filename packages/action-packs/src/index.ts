import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadCatalog, type CatalogEntry } from '@profullstack/sh1pt-actions-fleet-core';

const here = dirname(fileURLToPath(import.meta.url));

// Resolved relative to the published source layout. In dev, src/ sits next to packs/.
// At publish time `files` includes both `dist` and `packs`, so dist/ also sits next to packs/.
export const BUILTIN_PACKS_DIR = resolve(here, '..', 'packs');

export async function loadBuiltinPacks(): Promise<Map<string, CatalogEntry>> {
  return loadCatalog(BUILTIN_PACKS_DIR);
}
