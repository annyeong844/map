#!/usr/bin/env python3
"""SPIKE: a Python extractor for code-map, using only the stdlib `ast`.

Proves the gate: Python's mature, zero-install stdlib can produce code-map's
coordinate index (symbols + imports + calls + caller→callee edges) — the same
shape the oxc extractor emits for TS — so the existing core (locate/read/graph)
routes Python with no changes. Char offsets are computed to match read's slice;
the drift token matches code-map's sha256[:16] so reads come back `exact`.

Usage:  python3 py-extract.py <repo-root>  > index.json
Scope:  direct + from-import call edges (like the TS oxc path); obj.method()
        dispatch is left unresolved (that's where `ty` would add value).
"""
import ast
import hashlib
import json
import os
import sys

SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build", ".mypy_cache", ".pytest_cache", ".tox"}


def token(text):  # matches src/core/util.ts token()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def list_py(root):
    out = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP]
        for fn in fns:
            if fn.endswith(".py"):
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


def extract(root):
    files = list_py(root)
    fileset = set(files)
    entries, file_imports, file_calls, file_tokens = [], {}, {}, {}
    used_ids = {}

    def mk_id(file, name, kind, line):
        base = f"{file}#{name}"
        cand = base
        if cand in used_ids:
            cand = f"{base}#{kind}"
        if cand in used_ids:
            cand = f"{base}@{line}"
        n = used_ids.get(cand, 0) + 1
        used_ids[cand] = n
        return cand if n == 1 else f"{cand}~{n}"

    for file in files:
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

        def emit(node, name, kind, classname=None):
            cs, ce = off(node.lineno, node.col_offset), off(node.end_lineno, node.end_col_offset)
            vis = "module-private" if name.startswith("_") else None
            e = {
                "id": mk_id(file, name, kind, node.lineno),
                "name": name, "kind": kind, "file": file,
                "line": node.lineno, "endLine": node.end_lineno,
                "charStart": cs, "charEnd": ce,
                "searchText": sig(node.lineno) or name,
                "fanIn": 0, "intraRefs": 2,
                "definitionId": f"{file}#{kind}:{cs}-{ce}",
            }
            if classname:
                e["className"] = classname
            if vis:
                e["visibility"] = vis
            return e

        def collect_calls(node, caller):
            for n in ast.walk(node):
                if isinstance(n, ast.Call):
                    fn = n.func
                    if isinstance(fn, ast.Name):
                        calls.append({"caller": caller, "callee": fn.id, "member": False})
                    elif isinstance(fn, ast.Attribute):
                        calls.append({"caller": caller, "callee": fn.attr, "member": True})

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
                entries.append(emit(node, node.name, "ClassDeclaration"))
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        entries.append(emit(m, m.name, "ClassMethod", node.name))
                        collect_calls(m, m.name)

    # call edges: direct calls resolved same-file, else via from-import target file
    def_by = {}
    for e in entries:
        def_by.setdefault(e["file"], {}).setdefault(e["name"], e["id"])
    edges = set()
    for file, calls in file_calls.items():
        local = def_by.get(file, {})
        imps = file_imports.get(file, [])
        for c in calls:
            if c["member"]:
                continue
            frm = local.get(c["caller"])
            if not frm:
                continue
            to = local.get(c["callee"])
            if not to:
                imp = next((i for i in imps if i["name"] == c["callee"]), None)
                if imp and imp["source"] in def_by:
                    to = def_by[imp["source"]].get(c["callee"])
            if to and to != frm:
                edges.add((frm, to))

    return {
        "meta": {"tool": "code-map", "version": 6, "generated": "spike", "builtAtMs": 0,
                 "root": os.path.abspath(root), "entryCount": len(entries)},
        "fileTokens": file_tokens, "fileStats": {}, "fileImports": file_imports,
        "publicFiles": [], "fileCalls": file_calls,
        "callEdges": [list(e) for e in sorted(edges)], "entries": entries,
    }


if __name__ == "__main__":
    json.dump(extract(sys.argv[1]), sys.stdout)
