import { readFileSync } from 'node:fs';
function hasVersion(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        typeof value.version === 'string');
}
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!hasVersion(manifest)) {
    throw new Error('package.json has no string version.');
}
/** One runtime version source for the CLI and MCP handshake. */
export const VERSION = manifest.version;
