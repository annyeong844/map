import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const defaultProbe = (command, args) => {
    const result = spawnSync(command, [...args, '--version'], {
        stdio: 'ignore',
        windowsHide: true,
    });
    return result.status === 0;
};
let cachedDefaultCommand;
/** Find Python 3 without assuming Unix's `python3` spelling on Windows. */
export function resolvePythonCommand(options = {}) {
    const override = options.override ?? process.env.CODE_MAP_PYTHON;
    if (override)
        return { command: override, args: [], display: override };
    const cacheable = options.platform === undefined &&
        options.override === undefined &&
        options.probe === undefined;
    if (cacheable && cachedDefaultCommand)
        return cachedDefaultCommand;
    const platform = options.platform ?? process.platform;
    const probe = options.probe ?? defaultProbe;
    const candidates = platform === 'win32'
        ? [
            { command: 'py', args: ['-3'], display: 'py -3' },
            { command: 'python3', args: [], display: 'python3' },
            { command: 'python', args: [], display: 'python' },
        ]
        : [
            { command: 'python3', args: [], display: 'python3' },
            { command: 'python', args: [], display: 'python' },
        ];
    for (const candidate of candidates) {
        if (probe(candidate.command, candidate.args)) {
            if (cacheable)
                cachedDefaultCommand = candidate;
            return candidate;
        }
    }
    throw new Error(`Python 3 was not found (tried ${candidates.map((candidate) => candidate.display).join(', ')}). ` +
        'Install Python 3 or set CODE_MAP_PYTHON to its executable.');
}
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function nativePythonBinaryPath(platform = process.platform, arch = process.arch, root = packageRoot) {
    const executable = platform === 'win32' ? 'code-map-python.exe' : 'code-map-python';
    return resolve(root, 'native', 'bin', `${platform}-${arch}`, executable);
}
/** Prefer the packaged Rust extractor, retaining stdlib Python as a portable fallback. */
export function resolvePythonBackend(options = {}) {
    const requested = options.backend ?? process.env.CODE_MAP_PY_BACKEND ?? 'auto';
    if (!['auto', 'native', 'stdlib'].includes(requested)) {
        throw new Error(`Invalid CODE_MAP_PY_BACKEND=${requested}; expected auto, native, or stdlib.`);
    }
    const pythonOverride = options.override ?? process.env.CODE_MAP_PYTHON;
    if (requested === 'stdlib' || (requested === 'auto' && pythonOverride)) {
        return {
            kind: 'stdlib',
            ...resolvePythonCommand({ ...options, override: pythonOverride }),
        };
    }
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const nativeOverride = options.nativeOverride ?? process.env.CODE_MAP_PY_NATIVE;
    const nativePath = nativeOverride ??
        nativePythonBinaryPath(platform, arch, options.packageRoot ?? packageRoot);
    const pathExists = options.exists ?? existsSync;
    if (pathExists(nativePath)) {
        return {
            kind: 'native',
            command: nativePath,
            args: [],
            display: nativePath,
        };
    }
    if (requested === 'native') {
        throw new Error(`Native Python extractor was not found at ${nativePath}. ` +
            'Run npm run build:native or set CODE_MAP_PY_NATIVE to its executable.');
    }
    return { kind: 'stdlib', ...resolvePythonCommand(options) };
}
