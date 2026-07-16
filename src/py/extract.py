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
STATEMENT_CONTAINERS = (ast.stmt, ast.ExceptHandler)
if hasattr(ast, "match_case"):  # Python 3.10+
    STATEMENT_CONTAINERS += (ast.match_case,)


def token(text):  # matches src/core/util.ts token()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def source_lines(src):
    """Return logical Python lines and UTF-16 starts without normalizing bytes."""
    lines = []
    starts = [0]
    char_starts = [0]
    line_start = 0
    total_u16 = 0
    i = 0
    while i < len(src):
        ch = src[i]
        if ch == "\r" or ch == "\n":
            lines.append(src[line_start:i])
            total_u16 += 1
            i += 1
            if ch == "\r" and i < len(src) and src[i] == "\n":
                total_u16 += 1
                i += 1
            line_start = i
            starts.append(total_u16)
            char_starts.append(i)
            continue
        total_u16 += 2 if ord(ch) > 0xFFFF else 1
        i += 1
    lines.append(src[line_start:])
    return lines, starts, char_starts, total_u16


def binding_names(target):
    stack = [target]
    while stack:
        item = stack.pop()
        item_type = type(item)
        if item_type is ast.Name:
            yield item
        elif item_type is ast.Starred:
            stack.append(item.value)
        elif item_type is ast.Tuple or item_type is ast.List:
            stack.extend(reversed(item.elts))


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
    for p in (cand + ".py", cand + ".pyi", cand + "/__init__.py", cand + "/__init__.pyi"):
        if p in fileset:
            return p
    return None


def extract(root, only, files=None):
    all_files = list_py(root) if files is None else [f.replace("\\", "/") for f in files if f.endswith((".py", ".pyi"))]
    fileset = set(all_files)
    onlyset = set(only or ())
    targets = [f for f in all_files if not onlyset or f in onlyset]
    entries, file_imports, file_tokens, file_refs, files_missing, files_invalid = [], {}, {}, {}, [], []

    for file in targets:
        path = os.path.join(root, file)
        try:
            # Preserve CRLF bytes so hashes and UTF-16 coordinates match Node's
            # readFile(..., "utf8") view of the same on-disk source.
            with open(path, encoding="utf-8", newline="") as source:
                src = source.read()
        except UnicodeDecodeError:
            try:
                with open(path, "rb") as source:
                    src = source.read().decode("utf-8", "replace")
            except Exception:
                files_missing.append(file)
                continue
            file_tokens[file] = token(src)
            file_imports[file] = []
            file_refs[file] = {}
            files_invalid.append(file)
            continue
        except Exception:
            files_missing.append(file)
            continue
        file_tokens[file] = token(src)
        imports = []
        file_imports[file] = imports
        # ast.parse(str) rejects a leading U+FEFF even though a UTF-8 BOM is a
        # legal Python source prefix. Parse without it, then add its one UTF-16
        # unit back to every absolute coordinate so Node still slices `src`.
        parse_src = src[1:] if src.startswith("\ufeff") else src
        source_prefix_u16 = len(src) - len(parse_src)
        try:
            tree = ast.parse(parse_src)
        except Exception:
            file_refs[file] = {}
            files_invalid.append(file)
            continue

        lines, line_u16, line_chars, parsed_u16 = source_lines(parse_src)
        total_u16 = source_prefix_u16 + parsed_u16
        # One UTF-16 base per line replaces the former `len(src)+1` Python-int
        # array (tens of MB per large file). ASCII columns are then O(1); only a
        # non-ASCII declaration line builds a small byte→UTF-16 boundary map.
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
            return source_prefix_u16 + line_u16[index] + u16_col(index, col)

        def sig(lineno):
            return (lines[lineno - 1].strip() if 0 <= lineno - 1 < len(lines) else "")[:200]

        def char_off(lineno, byte_col):
            index = lineno - 1
            if not 0 <= index < len(lines):
                return len(parse_src)
            prefix = lines[index].encode("utf-8")[:byte_col].decode("utf-8")
            return line_chars[index] + len(prefix)

        refs = {}
        file_refs[file] = refs

        def emit(node, name, kind, classname=None, bases=None, namepath=None):
            signature_start = off(node.lineno, node.col_offset)
            decorators = getattr(node, "decorator_list", ())
            if decorators:
                first_decorator = min(decorators, key=lambda item: (item.lineno, item.col_offset))
                start_line = first_decorator.lineno
                cs = off(first_decorator.lineno, max(0, first_decorator.col_offset - 1))
            else:
                start_line = node.lineno
                cs = signature_start
            ce = off(node.end_lineno, node.end_col_offset)
            rec = {"name": name, "kind": kind, "file": file, "charStart": cs, "charEnd": ce,
                   "line": start_line, "endLine": node.end_lineno,
                   "searchText": sig(node.lineno) or name, "exported": not name.startswith("_")}
            if signature_start != cs:
                rec["anchorOffset"] = signature_start - cs
            refs[name] = refs.get(name, 0) + 1  # declaration occurrence
            if namepath and namepath != name:
                rec["namePath"] = namepath
            if name.startswith("_"):
                rec["visibility"] = "module-private"
            if classname:
                rec["className"] = classname
            if bases:
                rec["extends"] = bases[0]  # primary base — single string, matches TS `extends`
            return rec

        def emit_binding(node, target, value, kind):
            name = target.id
            cs = off(node.lineno, node.col_offset)
            anchor = off(target.lineno, target.col_offset)
            ce = off(node.end_lineno, node.end_col_offset)
            anchor_start_char = char_off(target.lineno, target.col_offset)
            anchor_end_char = char_off(
                value.lineno if value is not None else node.end_lineno,
                value.col_offset if value is not None else node.end_col_offset,
            )
            search_text = parse_src[anchor_start_char:anchor_end_char].rstrip()[:200]
            rec = {"name": name, "kind": kind, "file": file, "charStart": cs, "charEnd": ce,
                   "line": node.lineno, "endLine": node.end_lineno,
                   "searchText": search_text or name, "exported": not name.startswith("_")}
            refs.setdefault(name, 0)
            if anchor != cs:
                rec["anchorOffset"] = anchor - cs
            if name.startswith("_"):
                rec["visibility"] = "module-private"
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

        # Definitions can occur only in statement bodies. Keep this lexical walk
        # out of expression-only branches. The sentinel avoids an enter/leave
        # tuple per statement.
        scope = []
        scope_kinds = []
        scope_exit = object()
        stack = [tree]
        while stack:
            item = stack.pop()
            if item is scope_exit:
                scope_kinds.pop()
                scope.pop()
                continue

            node_type = type(item)
            opens_scope = False
            if node_type is ast.FunctionDef or node_type is ast.AsyncFunctionDef:
                namepath = "/".join((*scope, item.name))
                is_method = bool(scope_kinds and scope_kinds[-1] == "class")
                classname = "/".join(scope) if is_method else None
                kind = "ClassMethod" if is_method else "FunctionDeclaration"
                entries.append(emit(item, item.name, kind, classname=classname,
                                    namepath=None if is_method else namepath))
                scope.append(item.name)
                scope_kinds.append("function")
                opens_scope = True
            elif node_type is ast.ClassDef:
                bases = [item.bases[0].id] if item.bases and type(item.bases[0]) is ast.Name else None
                namepath = "/".join((*scope, item.name))
                entries.append(emit(item, item.name, "ClassDeclaration", bases=bases,
                                    namepath=namepath))
                scope.append(item.name)
                scope_kinds.append("class")
                opens_scope = True
            elif not scope and node_type is ast.Assign:
                for target_group in item.targets:
                    for target in binding_names(target_group):
                        entries.append(emit_binding(item, target, item.value, "assign-var"))
            elif not scope and node_type is ast.AnnAssign:
                for target in binding_names(item.target):
                    entries.append(emit_binding(item, target, item.value, "ann-var"))
            elif not scope and hasattr(ast, "TypeAlias") and node_type is ast.TypeAlias:
                for target in binding_names(item.name):
                    entries.append(emit_binding(item, target, item.value, "TypeAlias"))

            if opens_scope:
                stack.append(scope_exit)
            for field_name in reversed(item._fields):
                value = getattr(item, field_name, None)
                if isinstance(value, list):
                    for child in reversed(value):
                        if isinstance(child, STATEMENT_CONTAINERS):
                            stack.append(child)
                elif isinstance(value, STATEMENT_CONTAINERS):
                    stack.append(value)

        # Node only consumes reference counts for declarations emitted above.
        # Filtering during the one full AST walk preserves their exact counts but
        # avoids building and serializing a dictionary of every unrelated local.
        for ref_node in ast.walk(tree):
            node_type = type(ref_node)
            if node_type is ast.Name:
                name = ref_node.id
            elif node_type is ast.Attribute:
                name = ref_node.attr
            else:
                continue
            declaration_count = refs.get(name)
            if declaration_count is not None:
                refs[name] = declaration_count + 1

    return {"entries": entries, "fileImports": file_imports, "fileTokens": file_tokens,
            "fileRefs": file_refs, "filesMissing": files_missing, "filesInvalid": files_invalid}


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
