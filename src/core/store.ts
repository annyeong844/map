import { readFileSync, writeFileSync } from 'node:fs';
import type { MapIndex } from './types.ts';

export const DEFAULT_INDEX_PATH = '.map-index.json';

export function saveIndex(index: MapIndex, path = DEFAULT_INDEX_PATH): void {
  writeFileSync(path, JSON.stringify(index, null, 0));
}

export function loadIndex(path = DEFAULT_INDEX_PATH): MapIndex {
  const idx = JSON.parse(readFileSync(path, 'utf8')) as MapIndex;
  if (idx?.meta?.tool !== 'code-map') {
    throw new Error(`${path} is not a code-map index.`);
  }
  return idx;
}
