import { readFileSync } from 'node:fs';

interface PackageManifest { version: string }

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

/** One runtime version source for the CLI and MCP handshake. */
export const VERSION = manifest.version;
