#!/usr/bin/env node
import { resolve as resolvePath } from 'node:path';
import { buildIndex } from '../core/build-index.js';
import { changed, read, readMany } from '../core/read.js';
import { DEFAULT_INDEX_PATH, loadIndex, saveIndex } from '../core/store.js';
import { VERSION } from '../version.js';
import { applySetup, formatSetupPlan, setupPlan } from './setup.js';
const MAX_BATCH_REFS = 64;
const OUTPUT_COUNT_WIDTH = 6;
function parseArgs(argv) {
    const _ = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            }
            else {
                flags[key] = next;
                i++;
            }
        }
        else if (a === '-i') {
            flags.caseInsensitive = true;
        }
        else {
            _.push(a);
        }
    }
    return { _, flags };
}
const USAGE = `code-map — token-efficient, drift-resistant reads. Coordinates, not meaning.

  map index  [--root <dir>] [--out <.map-index.json>] [--force]   (root defaults to .)
  map read   <id|query> [--snippet "<text>"]              [--json]   (exact symbol slice; snippet → sub-symbol char range)
  map changed --refs "a,b,c" [--json]                                 (refresh only drifted working-set symbols)
  map stats
  map setup  <codex|claude|gemini> [--apply] [--json]                 (wire plugin/rules + MCP; dry-run by default)
  map version

  Global: --index <path>   (default ./.map-index.json)   --version, -v

'read' takes a symbol id or a bare name/path-scoped name (it resolves the name to one
symbol internally). Use your normal grep to SEARCH; use 'read' to pull the exact slice
cheaply (a symbol's bytes, not the whole file — and drift-resistant when the file moved).`;
async function main() {
    const { _, flags } = parseArgs(process.argv.slice(2));
    const cmd = _[0];
    const indexPath = typeof flags.index === 'string' ? flags.index : DEFAULT_INDEX_PATH;
    const json = !!flags.json;
    if (flags.version || cmd === 'version' || cmd === '-v') {
        console.log(VERSION);
        return;
    }
    switch (cmd) {
        case 'index': {
            const root = resolvePath(typeof flags.root === 'string' ? flags.root : '.');
            const out = typeof flags.out === 'string' ? flags.out : indexPath;
            // Load the prior index (if any) for incremental reuse; first build has none.
            let previous = null;
            if (!flags.force) {
                try {
                    previous = loadIndex(out);
                }
                catch {
                    previous = null;
                }
            }
            const report = await buildIndex({ root, previous, force: !!flags.force });
            // Nothing changed → leave the existing index untouched.
            if (!report.unchanged)
                saveIndex(report.index, out);
            if (json) {
                console.log(JSON.stringify({ out, unchanged: report.unchanged, ...summary(report) }, null, 2));
            }
            else if (report.unchanged) {
                console.log(`No changes — index current (${report.index.meta.entryCount} symbols, ${report.filesIndexed} files). Not rewritten.`);
                if (report.filesInvalid.length) {
                    console.log(`  ${report.filesInvalid.length} Python files remain syntax-invalid (last-known-good symbols preserved) — first: ${report.filesInvalid[0]}`);
                }
            }
            else {
                console.log(`Indexed ${report.index.meta.entryCount} symbols across ${report.filesIndexed} files`);
                console.log(`  exported defs: ${report.defs}   methods: ${report.methods}   private defs: ${report.privateDefs}   nested defs: ${report.nestedDefs}`);
                console.log(`  reused: ${report.reused}   re-read: ${report.changed}${flags.force ? ' (forced full)' : ''}   fan-in: ${report.fanInReused ? 'reused' : 'recomputed'}`);
                if (report.filesMissing.length) {
                    console.log(`  ${report.filesMissing.length} files unreadable (anchors weakened) — first: ${report.filesMissing[0]}`);
                }
                if (report.filesInvalid.length) {
                    console.log(`  ${report.filesInvalid.length} Python files syntax-invalid (last-known-good symbols preserved) — first: ${report.filesInvalid[0]}`);
                }
                console.log(`  root: ${report.index.meta.root}`);
                console.log(`  -> ${out}`);
            }
            return;
        }
        case 'read': {
            // Batch: --refs "a,b,c" reads several independent symbols in one invocation (mirrors the
            // MCP `refs` array) — one process, many slices, instead of N separate calls.
            if (typeof flags.refs === 'string') {
                const idx = loadIndex(indexPath);
                const refs = [
                    ...new Set(flags.refs
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)),
                ].slice(0, MAX_BATCH_REFS);
                const results = readMany(idx, refs);
                if (json) {
                    console.log(JSON.stringify({ results }, null, 2));
                    return;
                }
                for (const r of results) {
                    console.log(`# ${r.id}  [${r.status}]  ${r.file}:${r.line}${r.endLine ? `-${r.endLine}` : ''}`);
                    if (r.note)
                        console.log(`# note: ${r.note}`);
                    if (r.raw != null) {
                        console.log('---');
                        console.log(r.raw);
                    }
                }
                return;
            }
            const ref = _.slice(1).join(' ');
            if (!ref)
                die('read needs an <id|query>.');
            const idx = loadIndex(indexPath);
            const snippet = typeof flags.snippet === 'string' ? flags.snippet : undefined;
            const r = read(idx, ref, { snippet });
            if (json) {
                console.log(JSON.stringify(r, null, 2));
                return;
            }
            console.log(`# ${r.id}  [${r.status}]  ${r.file}:${r.line}${r.endLine ? `-${r.endLine}` : ''}`);
            if (r.note)
                console.log(`# note: ${r.note}`);
            if (r.aim) {
                console.log(`# aim [${r.aim.status}]: ${r.aim.matches.map((m) => `line ${m.line} (char ${m.charStart}-${m.charEnd})`).join(', ') || 'snippet not found in symbol'}`);
                if (r.aim.status === 'ambiguous') {
                    console.log('#   AMBIGUOUS — snippet matches multiple spots in this symbol; narrow it before targeting.');
                }
            }
            if (r.raw != null) {
                console.log('---');
                console.log(r.raw);
            }
            if (r.candidates?.length) {
                console.log('candidates:');
                for (const c of r.candidates) {
                    console.log(`  ${String(c.line).padStart(OUTPUT_COUNT_WIDTH)}  ${c.preview}`);
                }
            }
            return;
        }
        case 'changed': {
            // Working-set drift delta: which of these symbols moved since the index, with the
            // current slice for only the changed ones. `--refs "a,b,c"`.
            const refs = typeof flags.refs === 'string'
                ? flags.refs
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : _.slice(1);
            if (!refs.length) {
                die('changed needs --refs "a,b,c" (or space-separated ids).');
            }
            const idx = loadIndex(indexPath);
            const d = changed(idx, refs);
            if (json) {
                console.log(JSON.stringify(d, null, 2));
                return;
            }
            console.log(`# unchanged: ${d.unchanged.length}  ·  changed: ${d.changed.length}  (files: ${d.filesChanged}/${d.filesChecked} changed)`);
            for (const r of d.changed) {
                console.log(`# ${r.id}  [${r.status}]  ${r.file}:${r.line}${r.endLine ? `-${r.endLine}` : ''}`);
                if (r.raw != null) {
                    console.log('---');
                    console.log(r.raw);
                }
            }
            if (d.unchanged.length) {
                console.log(`# (unchanged, no re-read needed: ${d.unchanged.join(', ')})`);
            }
            return;
        }
        case 'stats': {
            const idx = loadIndex(indexPath);
            const byKind = {};
            for (const e of idx.entries)
                byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
            const out = {
                ...idx.meta,
                files: Object.keys(idx.fileTokens).length,
                byKind,
            };
            if (json) {
                console.log(JSON.stringify(out, null, 2));
                return;
            }
            console.log(`code-map index  (built ${idx.meta.generated})`);
            console.log(`  root: ${idx.meta.root}`);
            console.log(`  symbols: ${idx.meta.entryCount}   files: ${out.files}`);
            for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
                console.log(`    ${String(n).padStart(OUTPUT_COUNT_WIDTH)}  ${k}`);
            }
            return;
        }
        case 'setup': {
            const host = _[1];
            if (host !== 'codex' && host !== 'claude' && host !== 'gemini') {
                die('setup needs one host: codex, claude, or gemini.');
            }
            const plan = setupPlan(host);
            if (!flags.apply) {
                console.log(json ? JSON.stringify(plan, null, 2) : formatSetupPlan(plan));
                return;
            }
            const applied = applySetup(plan);
            const result = {
                host,
                changed: applied,
                alreadyConfigured: applied.length === 0,
            };
            if (json) {
                console.log(JSON.stringify(result, null, 2));
            }
            else if (applied.length) {
                console.log(`Configured code-map for ${host}:`);
                for (const item of applied)
                    console.log(`  - ${item}`);
            }
            else {
                console.log(`code-map is already configured for ${host}.`);
            }
            return;
        }
        case undefined:
        case 'help':
        case '--help':
        case '-h':
            console.log(USAGE);
            return;
        default:
            die(`unknown command: ${cmd}\n\n${USAGE}`);
    }
}
function summary(report) {
    return {
        entries: report.index.meta.entryCount,
        files: report.filesIndexed,
        defs: report.defs,
        methods: report.methods,
        privateDefs: report.privateDefs,
        nestedDefs: report.nestedDefs,
        reused: report.reused,
        changed: report.changed,
        fanInReused: report.fanInReused,
        filesMissing: report.filesMissing.length,
        filesInvalid: report.filesInvalid.length,
        root: report.index.meta.root,
    };
}
function die(msg) {
    console.error(msg);
    process.exit(1);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
