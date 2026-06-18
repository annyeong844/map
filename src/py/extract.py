#!/usr/bin/env python3
"""Python parse backend for code-map, using only the stdlib `ast`.

code-map's core is language-neutral: it stores coordinates (path + char span +
content token + searchText anchor) and judges meaning never. This backend gives
it Python by emitting the same per-file primitives the oxc/TS path does —
symbols, imports, calls — which build-index then runs through the SHARED pipeline
(stable ids, native fan-in, the Level-1 call graph). Char offsets match read's
slice and the token matches code-map's sha256[:16], so Python reads come back
`exact`, same as TS.

Invocation (by build-index, not usually by hand):
    python3 extract.py <repo-root>
Restrict to specific files for INCREMENTAL rebuilds by writing newline-separated
repo-relative paths to stdin; the full tree is still walked for import resolution,
but only the requested files are parsed and emitted. No stdin → emit every file.

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
    return out


def line_starts(src):
    starts = [0]
    for i, ch in enumerate(src):
        if ch == "\n":
            starts.append(i + 1)
    return starts


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


def extract(root, only):
    fileset = set(list_py(root))                       # full tree → import resolution
    targets = [f for f in sorted(fileset) if not only or f in only]
    entries, file_imports, file_calls, file_tokens = [], {}, {}, {}

    for file in targets:
        try:
            src = open(os.path.join(root, file), encoding="utf-8").read()
            tree = ast.parse(src)
        except Exception:
            continue
        file_tokens[file] = token(src)
        starts = line_starts(src)
        lines = src.split("\n")

        def off(lineno, col):
            ln = lines[lineno - 1] if 0 <= lineno - 1 < len(lines) else ""
            char_col = len(ln.encode("utf-8")[:col].decode("utf-8", "replace"))
            return starts[lineno - 1] + char_col

        def sig(lineno):
            return (lines[lineno - 1].strip() if 0 <= lineno - 1 < len(lines) else "")[:200]

        imports, calls = [], []
        file_imports[file] = imports
        file_calls[file] = calls

        def emit(node, name, kind, classname=None, bases=None):
            cs, ce = off(node.lineno, node.col_offset), off(node.end_lineno, node.end_col_offset)
            rec = {"name": name, "kind": kind, "file": file, "charStart": cs, "charEnd": ce,
                   "searchText": sig(node.lineno) or name, "exported": not name.startswith("_")}
            if name.startswith("_"):
                rec["visibility"] = "module-private"
            if classname:
                rec["className"] = classname
            if bases:
                rec["extends"] = bases[0]  # primary base — single string, matches TS `extends`
            return rec

        def collect_calls(node, caller, klass=None):
            for n in ast.walk(node):
                if isinstance(n, ast.Call):
                    fn = n.func
                    if isinstance(fn, ast.Name):
                        calls.append({"caller": caller, "callee": fn.id, "member": False})
                    elif isinstance(fn, ast.Attribute):
                        c = {"caller": caller, "callee": fn.attr, "member": True}
                        # self.m() is Python's `this.m()` — deterministic to the enclosing class
                        if isinstance(fn.value, ast.Name) and fn.value.id == "self":
                            c["recv"] = "this"
                            if klass:
                                c["callerClass"] = klass
                        else:
                            c["recv"] = "other"
                        calls.append(c)

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
                collect_calls(node, node.name)
            elif isinstance(node, ast.ClassDef):
                bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
                entries.append(emit(node, node.name, "ClassDeclaration", bases=bases))
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        entries.append(emit(m, m.name, "ClassMethod", classname=node.name))
                        collect_calls(m, m.name, klass=node.name)

    return {"entries": entries, "fileImports": file_imports, "fileCalls": file_calls, "fileTokens": file_tokens}


if __name__ == "__main__":
    root = sys.argv[1]
    data = sys.stdin.read() if not sys.stdin.isatty() else ""
    only = {ln.strip().replace("\\", "/") for ln in data.splitlines() if ln.strip()}
    json.dump(extract(root, only), sys.stdout)
