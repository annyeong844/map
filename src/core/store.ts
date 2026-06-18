import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MapIndex } from './types.ts';

export const DEFAULT_INDEX_PATH = '.map-index.json';

/** Write atomically: a temp file in the same dir, then rename (atomic on POSIX),
 * so an interrupted write never leaves a truncated index on disk. */
export function saveIndex(index: MapIndex, path = DEFAULT_INDEX_PATH): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 0));
  renameSync(tmp, path);
}

export function loadIndex(path = DEFAULT_INDEX_PATH): MapIndex {
  const idx = JSON.parse(readFileSync(path, 'utf8')) as MapIndex;
  if (idx?.meta?.tool !== 'code-map') {
    throw new Error(`${path} is not a code-map index.`);
  }
  return idx;
}
