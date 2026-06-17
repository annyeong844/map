#!/usr/bin/env node
import { resolve as resolvePath } from 'node:path';
import { buildIndex, type BuildReport } from '../core/build-index.ts';
import { grep } from '../core/grep.ts';
import { locate } from '../core/locate.ts';
import { read } from '../core/read.ts';
import { DEFAULT_INDEX_PATH, loadIndex, saveIndex } from '../core/store.ts';

function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else if (a === '-i') {
      flags.caseInsensitive = true;
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

const USAGE = `code-map — routes to coordinates, not meaning.

  map index   [--root <dir>] [--out <.map-index.json>] [--force]   (root defaults to .)
  map locate  <query>  [--kind k] [--file f] [--limit n] [--json]
  map read    <id|query>                                  [--json]
  map grep    <pattern> [--fixed] [-i] [--file f] [--limit n] [--json]
  map stats

  Global: --index <path>   (default ./.map-index.json)

A query may be a name (buildIndex), a path-scoped name (alias-map#buildAliasMap),
or a path fragment (alias-map#). 'read' takes an id from 'locate', or a bare name.`;

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const indexPath = (flags.index as string) ?? DEFAULT_INDEX_PATH;
  const json = !!flags.json;

  switch (cmd) {
    case 'index': {
      const root = resolvePath((flags.root as string) ?? '.');
      const out = (flags.out as string) ?? indexPath;
      // Load the prior index (if any) for incremental reuse; first build has none.
      let previous = null;
      if (!flags.force) {
        try {
          previous = loadIndex(out);
        } catch {
          previous = null;
        }
      }
      const report = await buildIndex({ root, previous, force: !!flags.force });
      // Nothing changed → leave the existing index untouched.
      if (!report.unchanged) saveIndex(report.index, out);
      if (json) {
        console.log(JSON.stringify({ out, unchanged: report.unchanged, ...summary(report) }, null, 2));
      } else if (report.unchanged) {
        console.log(`No changes — index current (${report.index.meta.entryCount} symbols, ${report.filesIndexed} files). Not rewritten.`);
      } else {
        console.log(`Indexed ${report.index.meta.entryCount} symbols across ${report.filesIndexed} files`);
        console.log(`  exported defs: ${report.defs}   methods: ${report.methods}   private defs: ${report.privateDefs}`);
        console.log(`  reused: ${report.reused}   re-read: ${report.changed}${flags.force ? ' (forced full)' : ''}`);
        if (report.filesMissing.length) console.log(`  ${report.filesMissing.length} files unreadable (anchors weakened) — first: ${report.filesMissing[0]}`);
        console.log(`  root: ${report.index.meta.root}`);
        console.log(`  -> ${out}`);
      }
      return;
    }

    case 'locate': {
      const query = _[1];
      if (!query) die('locate needs a <query>.');
      const idx = loadIndex(indexPath);
      const hits = locate(idx, query, {
        kind: flags.kind as string,
        file: flags.file as string,
        limit: flags.limit ? Number(flags.limit) : undefined,
      });
      if (json) return void console.log(JSON.stringify(hits, null, 2));
      if (!hits.length) return void console.log(`no match for "${query}"`);
      for (const h of hits) {
        console.log(`${h.id}`);
        console.log(`    ${h.kind}  ${h.file}:${h.line}${h.endLine ? `-${h.endLine}` : ''}  [${h.match}, fan-in ${h.fanIn}]`);
        console.log(`    ${h.signature}`);
      }
      return;
    }

    case 'read': {
      const ref = _.slice(1).join(' ');
      if (!ref) die('read needs an <id|query>.');
      const idx = loadIndex(indexPath);
      const r = read(idx, ref);
      if (json) return void console.log(JSON.stringify(r, null, 2));
      console.log(`# ${r.id}  [${r.status}]  ${r.file}:${r.line}${r.endLine ? `-${r.endLine}` : ''}`);
      if (r.note) console.log(`# note: ${r.note}`);
      if (r.raw != null) {
        console.log('---');
        console.log(r.raw);
      }
      if (r.candidates?.length) {
        console.log('candidates:');
        for (const c of r.candidates) console.log(`  ${String(c.line).padStart(6)}  ${c.preview}`);
      }
      return;
    }

    case 'grep': {
      const pattern = _[1];
      if (!pattern) die('grep needs a <pattern>.');
      const idx = loadIndex(indexPath);
      const matches = grep(idx.meta.root, pattern, {
        fixed: !!flags.fixed,
        caseInsensitive: !!flags.caseInsensitive,
        file: flags.file as string,
        limit: flags.limit ? Number(flags.limit) : undefined,
      });
      if (json) return void console.log(JSON.stringify(matches, null, 2));
      for (const m of matches) console.log(`${m.file}:${m.line}: ${m.text.trim()}`);
      if (!matches.length) console.log('no matches');
      return;
    }

    case 'stats': {
      const idx = loadIndex(indexPath);
      const byKind: Record<string, number> = {};
      for (const e of idx.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      const out = { ...idx.meta, files: Object.keys(idx.fileTokens).length, byKind };
      if (json) return void console.log(JSON.stringify(out, null, 2));
      console.log(`code-map index  (built ${idx.meta.generated})`);
      console.log(`  root: ${idx.meta.root}`);
      console.log(`  symbols: ${idx.meta.entryCount}   files: ${out.files}`);
      for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(6)}  ${k}`);
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

function summary(report: BuildReport) {
  return {
    entries: report.index.meta.entryCount,
    files: report.filesIndexed,
    defs: report.defs,
    methods: report.methods,
    privateDefs: report.privateDefs,
    reused: report.reused,
    changed: report.changed,
    filesMissing: report.filesMissing.length,
    root: report.index.meta.root,
  };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
