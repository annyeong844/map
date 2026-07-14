#!/usr/bin/env python3
"""Python parse backend for code-map, using only the stdlib `ast`.

code-map's core is language-neutral: it stores coordinates (path + char span +
content token + searchText anchor) and judges meaning never. This backend gives
it Python by emitting the same per-file primitives the oxc/TS path does —
symbols, imports, refs — which build-index then runs through the shared pipeline
(stable ids, native fan-in, dead-code counters). Char offsets match read's
slice and the token matches code-map's sha256[:16], so Python reads come back
`exact`, same as TS.

Invocation (by build-index, not usually by hand):
    python3 extract.py <repo-root>
For incremental builds Node sends one JSON object on stdin with the already
enumerated, gitignore-aware `files` plus changed `targets`. Legacy newline-separated
targets and empty stdin remain accepted for direct use.

Scope: direct + from-import call edges (like the TS path); obj.method() / self.m()
dispatch is left unresolved — that is where the `ty` oracle adds value (sibling
code-oracle), exactly as tsgo does for TS.
"""
import ast
import hashlib
import json
import os
import sys

SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build", ".mypy_cache", ".pytest_cache", ".tox", ".ruff_cache", "site-packages"}


def token(text):  # matches src/core/util.ts token()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def list_py(root):
    out = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP]
        for fn in fns:
            if fn.endswith((".py", ".pyi")):
                rel = os.path.relpath(os.path.join(dp, fn), root).replace("\\", "/")
                out.append(rel)
    out.sort()
    return out


def to_module_file(from_file, node, fileset):
    """Resolve `from . / from pkg.sub` to a repo-relative .py path in the file set."""
    parts = from_file.split("/")
    if node.level:  # relative import: climb `level` dirs from the file's package
        base = parts[:-1]
        for _ in range(node.level - 1):
            base = base[:-1]
        mod = (node.module or "").split(".") if node.module else []
        cand = "/".join(base + mod)
    else:
        cand = (node.module or "").replace(".", "/")
    for p in (cand + ".py", cand + "/__init__.py"):
        if p in fileset:
            return p
    return None


def extract(root, only, files=None):
    all_files = list_py(root) if files is None else [f.replace("\\", "/") for f in files if f.endswith((".py", ".pyi"))]
    fileset = set(all_files)
    targets = [f for f in all_files if not only or f in only]
    entries, file_imports, file_tokens, file_refs, files_missing = [], {}, {}, {}, []

    for file in targets:
        try:
            with open(os.path.join(root, file), encoding="utf-8") as source:
                src = source.read()
        except Exception:
            files_missing.append(file)
            continue
        file_tokens[file] = token(src)
        imports = []
        file_imports[file] = imports
        try:
            tree = ast.parse(src)
        except Exception:
            file_refs[file] = {}
            continue

        lines = src.split("\n")
        # One UTF-16 base per line replaces the former `len(src)+1` Python-int
        # array (tens of MB per large file). ASCII columns are then O(1); only a
        # non-ASCII declaration line builds a small byte→UTF-16 boundary map.
        line_u16 = []
        total_u16 = 0
        for i, line in enumerate(lines):
            line_u16.append(total_u16)
            total_u16 += len(line) if line.isascii() else len(line.encode("utf-16-le")) // 2
            if i + 1 < len(lines):
                total_u16 += 1  # `\n`
        byte_to_u16 = {}

        def u16_col(line_index, byte_col):
            line = lines[line_index]
            if line.isascii():
                return min(max(byte_col, 0), len(line))
            mapping = byte_to_u16.get(line_index)
            if mapping is None:
                mapping = {0: 0}
                bcol = ucol = 0
                for ch in line:
                    bcol += len(ch.encode("utf-8"))
                    ucol += 2 if ord(ch) > 0xFFFF else 1
                    mapping[bcol] = ucol
                byte_to_u16[line_index] = mapping
            if byte_col in mapping:
                return mapping[byte_col]
            # AST columns are UTF-8 boundaries. Keep a defensive fallback for a
            # future parser that hands us an interior byte position.
            prefix = line.encode("utf-8")[:byte_col].decode("utf-8", "replace")
            return len(prefix.encode("utf-16-le")) // 2

        def off(lineno, col):
            index = lineno - 1
            if not 0 <= index < len(lines):
                return total_u16
            return line_u16[index] + u16_col(index, col)

        def sig(lineno):
            return (lines[lineno - 1].strip() if 0 <= lineno - 1 < len(lines) else "")[:200]

        refs = {}
        for ref_node in ast.walk(tree):
            name = None
            if isinstance(ref_node, ast.Name):
                name = ref_node.id
            elif isinstance(ref_node, ast.Attribute):
                name = ref_node.attr
            if name:
                refs[name] = refs.get(name, 0) + 1
        file_refs[file] = refs

        def emit(node, name, kind, classname=None, bases=None):
            cs, ce = off(node.lineno, node.col_offset), off(node.end_lineno, node.end_col_offset)
            rec = {"name": name, "kind": kind, "file": file, "charStart": cs, "charEnd": ce,
                   "line": node.lineno, "endLine": node.end_lineno,
                   "searchText": sig(node.lineno) or name, "exported": not name.startswith("_")}
            refs[name] = refs.get(name, 0) + 1  # declaration occurrence
            if name.startswith("_"):
                rec["visibility"] = "module-private"
            if classname:
                rec["className"] = classname
            if bases:
                rec["extends"] = bases[0]  # primary base — single string, matches TS `extends`
            return rec

        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.ImportFrom):
                    tgt = to_module_file(file, node, fileset)
                    for a in node.names:
                        imports.append({"source": tgt or (node.module or "."), "name": a.name})
                else:
                    for a in node.names:
                        imports.append({"source": a.name.replace(".", "/"), "name": a.asname or a.name})
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                entries.append(emit(node, node.name, "FunctionDeclaration"))
            elif isinstance(node, ast.ClassDef):
                bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
                entries.append(emit(node, node.name, "ClassDeclaration", bases=bases))
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        entries.append(emit(m, m.name, "ClassMethod", classname=node.name))

    return {"entries": entries, "fileImports": file_imports, "fileTokens": file_tokens,
            "fileRefs": file_refs, "filesMissing": files_missing}


if __name__ == "__main__":
    root = sys.argv[1]
    data = sys.stdin.read() if not sys.stdin.isatty() else ""
    files = None
    only = set()
    if data.strip():
        try:
            request = json.loads(data)
            if isinstance(request, dict) and isinstance(request.get("files"), list):
                files = request["files"]
                only = {str(f).replace("\\", "/") for f in request.get("targets", [])}
            else:
                raise ValueError("legacy input")
        except Exception:
            only = {ln.strip().replace("\\", "/") for ln in data.splitlines() if ln.strip()}
    json.dump(extract(root, only, files), sys.stdout)
