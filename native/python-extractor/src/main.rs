use rayon::prelude::*;
use ruff_python_ast::statement_visitor::{self, StatementVisitor};
use ruff_python_ast::visitor::{self, Visitor};
use ruff_python_ast::{Expr, PythonVersion, Stmt};
use ruff_python_parser::{Mode, ParseOptions, parse};
use ruff_text_size::{Ranged, TextRange};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const MAX_THREADS: usize = 8;

#[derive(Deserialize)]
struct Request {
    files: Vec<String>,
    #[serde(default)]
    targets: Vec<String>,
}

#[derive(Serialize)]
struct Output {
    v: u8,
    p: Vec<ParsedFile>,
    i: Vec<InvalidFile>,
    m: Vec<String>,
}

struct Entry {
    name: String,
    kind: &'static str,
    char_start: usize,
    char_end: usize,
    line: usize,
    end_line: usize,
    search_text: String,
    anchor_offset: Option<usize>,
    name_path: Option<String>,
    class_name: Option<String>,
    extends: Option<String>,
}

struct ImportEdge {
    source: String,
    name: String,
}

impl Serialize for Entry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let kind = match self.kind {
            "FunctionDeclaration" => 0_u8,
            "ClassDeclaration" => 1,
            "ClassMethod" => 2,
            "assign-var" => 3,
            "ann-var" => 4,
            "TypeAlias" => 5,
            _ => unreachable!("unsupported Python symbol kind"),
        };
        let mut tuple = serializer.serialize_tuple(11)?;
        tuple.serialize_element(&self.name)?;
        tuple.serialize_element(&kind)?;
        tuple.serialize_element(&self.char_start)?;
        tuple.serialize_element(&self.char_end)?;
        tuple.serialize_element(&self.line)?;
        tuple.serialize_element(&self.end_line)?;
        tuple.serialize_element(&self.search_text)?;
        tuple.serialize_element(&self.anchor_offset)?;
        tuple.serialize_element(&self.name_path)?;
        tuple.serialize_element(&self.class_name)?;
        tuple.serialize_element(&self.extends)?;
        tuple.end()
    }
}

impl Serialize for ImportEdge {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(&self.source)?;
        tuple.serialize_element(&self.name)?;
        tuple.end()
    }
}

#[derive(Serialize)]
struct ParsedFile(
    String,
    String,
    Vec<Entry>,
    Vec<ImportEdge>,
    FxHashMap<String, u32>,
);

#[derive(Serialize)]
struct InvalidFile(String, String);

enum FileResult {
    Parsed {
        file: String,
        entries: Vec<Entry>,
        imports: Vec<ImportEdge>,
        token: String,
        refs: FxHashMap<String, u32>,
    },
    Invalid {
        file: String,
        token: String,
    },
    Missing(String),
}

struct LineIndex {
    byte_starts: Vec<usize>,
    utf16_starts: Vec<usize>,
}

impl LineIndex {
    fn new(source: &str) -> Self {
        let mut byte_starts = vec![0];
        let mut utf16_starts = vec![0];
        let mut utf16 = 0;
        for (byte, ch) in source.char_indices() {
            utf16 += ch.len_utf16();
            // Python accepts LF, CRLF, and bare CR source newlines. Avoid
            // counting CRLF twice, but retain the otherwise-legal CR-only form.
            if ch == '\n' || (ch == '\r' && source.as_bytes().get(byte + 1) != Some(&b'\n')) {
                byte_starts.push(byte + 1);
                utf16_starts.push(utf16);
            }
        }
        Self {
            byte_starts,
            utf16_starts,
        }
    }

    fn line_index(&self, byte: usize) -> usize {
        self.byte_starts.partition_point(|start| *start <= byte) - 1
    }

    fn line_number(&self, byte: usize) -> usize {
        self.line_index(byte) + 1
    }

    fn utf16_offset(&self, source: &str, byte: usize) -> usize {
        let line = self.line_index(byte);
        self.utf16_starts[line] + source[self.byte_starts[line]..byte].encode_utf16().count()
    }

    fn line_text<'a>(&self, source: &'a str, line: usize) -> &'a str {
        let start = self.byte_starts[line];
        let end = self
            .byte_starts
            .get(line + 1)
            .copied()
            .unwrap_or(source.len());
        source[start..end].trim_end_matches(['\r', '\n'])
    }

    fn signature_start(&self, source: &str, name_start: usize) -> usize {
        let line = self.line_index(name_start);
        let start = self.byte_starts[line];
        let leading = source[start..name_start]
            .char_indices()
            .find(|(_, ch)| !matches!(ch, ' ' | '\t' | '\u{000c}' | '\u{feff}'))
            .map_or(name_start - start, |(offset, _)| offset);
        start + leading
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScopeKind {
    Function,
    Class,
}

struct DefinitionCollector<'a> {
    source: &'a str,
    lines: &'a LineIndex,
    entries: Vec<Entry>,
    refs: FxHashMap<String, u32>,
    scope: Vec<String>,
    scope_kinds: Vec<ScopeKind>,
}

struct DefinitionSpec<'a> {
    name: &'a str,
    name_range: TextRange,
    node_range: TextRange,
    decorators: &'a [ruff_python_ast::Decorator],
    kind: &'static str,
    class_name: Option<String>,
    name_path: Option<String>,
    extends: Option<String>,
}

impl DefinitionCollector<'_> {
    fn emit(&mut self, spec: DefinitionSpec<'_>) {
        let DefinitionSpec {
            name,
            name_range,
            node_range,
            decorators,
            kind,
            class_name,
            name_path,
            extends,
        } = spec;
        let signature_start = self
            .lines
            .signature_start(self.source, name_range.start().to_usize());
        let start = decorators
            .first()
            .map_or(signature_start, |decorator| decorator.start().to_usize());
        let end = node_range.end().to_usize();
        let start_utf16 = self.lines.utf16_offset(self.source, start);
        let signature_utf16 = self.lines.utf16_offset(self.source, signature_start);
        let signature_line = self.lines.line_index(signature_start);
        let search_text = self
            .lines
            .line_text(self.source, signature_line)
            .trim()
            .trim_start_matches('\u{feff}')
            .chars()
            .take(200)
            .collect::<String>();
        *self.refs.entry(name.to_owned()).or_default() += 1;
        self.entries.push(Entry {
            name: name.to_owned(),
            kind,
            char_start: start_utf16,
            char_end: self.lines.utf16_offset(self.source, end),
            line: self.lines.line_number(start),
            end_line: self.lines.line_number(end),
            search_text: if search_text.is_empty() {
                name.to_owned()
            } else {
                search_text
            },
            anchor_offset: (signature_utf16 != start_utf16)
                .then_some(signature_utf16 - start_utf16),
            name_path,
            class_name,
            extends,
        });
    }

    fn full_name(&self, name: &str) -> String {
        if self.scope.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{}", self.scope.join("/"), name)
        }
    }

    fn emit_binding(
        &mut self,
        name: &str,
        name_range: TextRange,
        anchor_end: usize,
        node_range: TextRange,
        kind: &'static str,
    ) {
        let mut start = node_range.start().to_usize();
        if start == 0 && self.source.starts_with('\u{feff}') {
            start = '\u{feff}'.len_utf8();
        }
        let anchor = name_range.start().to_usize();
        let end = node_range.end().to_usize();
        let start_utf16 = self.lines.utf16_offset(self.source, start);
        let anchor_utf16 = self.lines.utf16_offset(self.source, anchor);
        let search_text = self.source[anchor..anchor_end]
            .trim_end()
            .chars()
            .take(200)
            .collect::<String>();
        self.refs.entry(name.to_owned()).or_default();
        self.entries.push(Entry {
            name: name.to_owned(),
            kind,
            char_start: start_utf16,
            char_end: self.lines.utf16_offset(self.source, end),
            line: self.lines.line_number(start),
            end_line: self.lines.line_number(end),
            search_text: if search_text.is_empty() {
                name.to_owned()
            } else {
                search_text
            },
            anchor_offset: (anchor_utf16 != start_utf16).then_some(anchor_utf16 - start_utf16),
            name_path: None,
            class_name: None,
            extends: None,
        });
    }
}

fn collect_binding_names<'a>(target: &'a Expr, names: &mut Vec<(&'a str, TextRange)>) {
    match target {
        Expr::Name(name) => names.push((name.id.as_str(), name.range())),
        Expr::List(list) => {
            for element in &list.elts {
                collect_binding_names(element, names);
            }
        }
        Expr::Tuple(tuple) => {
            for element in &tuple.elts {
                collect_binding_names(element, names);
            }
        }
        Expr::Starred(starred) => collect_binding_names(&starred.value, names),
        _ => {}
    }
}

impl<'a> StatementVisitor<'a> for DefinitionCollector<'_> {
    fn visit_stmt(&mut self, stmt: &'a Stmt) {
        match stmt {
            Stmt::FunctionDef(function) => {
                let name = function.name.as_str();
                let full_name = self.full_name(name);
                let is_method = self.scope_kinds.last() == Some(&ScopeKind::Class);
                let class_name = is_method.then(|| self.scope.join("/"));
                let name_path = (!is_method && full_name != name).then_some(full_name);
                self.emit(DefinitionSpec {
                    name,
                    name_range: function.name.range(),
                    node_range: function.range(),
                    decorators: &function.decorator_list,
                    kind: if is_method {
                        "ClassMethod"
                    } else {
                        "FunctionDeclaration"
                    },
                    class_name,
                    name_path,
                    extends: None,
                });
                self.scope.push(name.to_owned());
                self.scope_kinds.push(ScopeKind::Function);
                statement_visitor::walk_stmt(self, stmt);
                self.scope_kinds.pop();
                self.scope.pop();
                return;
            }
            Stmt::ClassDef(class) => {
                let name = class.name.as_str();
                let full_name = self.full_name(name);
                let name_path = (full_name != name).then_some(full_name);
                let extends = class.arguments.as_ref().and_then(|arguments| {
                    arguments.args.first().and_then(|base| match base {
                        Expr::Name(name) => Some(name.id.as_str().to_owned()),
                        _ => None,
                    })
                });
                self.emit(DefinitionSpec {
                    name,
                    name_range: class.name.range(),
                    node_range: class.range(),
                    decorators: &class.decorator_list,
                    kind: "ClassDeclaration",
                    class_name: None,
                    name_path,
                    extends,
                });
                self.scope.push(name.to_owned());
                self.scope_kinds.push(ScopeKind::Class);
                statement_visitor::walk_stmt(self, stmt);
                self.scope_kinds.pop();
                self.scope.pop();
                return;
            }
            Stmt::Assign(assign) if self.scope.is_empty() => {
                let mut names = Vec::new();
                for target in &assign.targets {
                    collect_binding_names(target, &mut names);
                }
                for (name, range) in names {
                    self.emit_binding(
                        name,
                        range,
                        assign.value.start().to_usize(),
                        assign.range(),
                        "assign-var",
                    );
                }
            }
            Stmt::AnnAssign(assign) if self.scope.is_empty() => {
                let mut names = Vec::new();
                collect_binding_names(&assign.target, &mut names);
                let anchor_end = assign
                    .value
                    .as_ref()
                    .map_or_else(|| assign.end().to_usize(), |value| value.start().to_usize());
                for (name, range) in names {
                    self.emit_binding(name, range, anchor_end, assign.range(), "ann-var");
                }
            }
            Stmt::TypeAlias(alias) if self.scope.is_empty() => {
                if let Expr::Name(name) = alias.name.as_ref() {
                    self.emit_binding(
                        name.id.as_str(),
                        name.range(),
                        alias.value.start().to_usize(),
                        alias.range(),
                        "TypeAlias",
                    );
                }
            }
            _ => {}
        }
        statement_visitor::walk_stmt(self, stmt);
    }
}

struct ReferenceCollector<'a> {
    refs: &'a mut FxHashMap<String, u32>,
}

impl<'a> Visitor<'a> for ReferenceCollector<'_> {
    fn visit_stmt(&mut self, stmt: &'a Stmt) {
        if let Stmt::If(if_stmt) = stmt {
            self.visit_expr(&if_stmt.test);
            self.visit_body(&if_stmt.body);
            for clause in &if_stmt.elif_else_clauses {
                if let Some(test) = &clause.test {
                    self.visit_expr(test);
                }
                self.visit_body(&clause.body);
            }
            return;
        }
        visitor::walk_stmt(self, stmt);
    }

    fn visit_expr(&mut self, expr: &'a Expr) {
        let name = match expr {
            Expr::Name(name) => Some(name.id.as_str()),
            Expr::Attribute(attribute) => Some(attribute.attr.as_str()),
            _ => None,
        };
        if let Some(count) = name.and_then(|name| self.refs.get_mut(name)) {
            *count += 1;
        }
        visitor::walk_expr(self, expr);
    }
}

fn source_token(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    let mut result = String::with_capacity(16);
    for byte in &digest[..8] {
        use std::fmt::Write;
        write!(&mut result, "{byte:02x}").expect("writing to String cannot fail");
    }
    result
}

fn resolve_import(
    from_file: &str,
    level: u32,
    module: Option<&str>,
    files: &FxHashSet<String>,
) -> Option<String> {
    let mut parts = from_file.split('/').collect::<Vec<_>>();
    parts.pop();
    let candidate = if level > 0 {
        for _ in 1..level {
            parts.pop();
        }
        parts.extend(
            module
                .unwrap_or("")
                .split('.')
                .filter(|part| !part.is_empty()),
        );
        parts.join("/")
    } else {
        module.unwrap_or("").replace('.', "/")
    };
    [
        format!("{candidate}.py"),
        format!("{candidate}.pyi"),
        format!("{candidate}/__init__.py"),
        format!("{candidate}/__init__.pyi"),
    ]
    .into_iter()
    .find(|path| files.contains(path))
}

fn extract_imports(suite: &[Stmt], from_file: &str, files: &FxHashSet<String>) -> Vec<ImportEdge> {
    let mut imports = Vec::new();
    for stmt in suite {
        match stmt {
            Stmt::ImportFrom(import) => {
                let module = import.module.as_ref().map(|module| module.as_str());
                let source = resolve_import(from_file, import.level, module, files)
                    .unwrap_or_else(|| module.unwrap_or(".").to_owned());
                for alias in &import.names {
                    imports.push(ImportEdge {
                        source: source.clone(),
                        name: alias.name.as_str().to_owned(),
                    });
                }
            }
            Stmt::Import(import) => {
                for alias in &import.names {
                    imports.push(ImportEdge {
                        source: alias.name.as_str().replace('.', "/"),
                        name: alias
                            .asname
                            .as_ref()
                            .unwrap_or(&alias.name)
                            .as_str()
                            .to_owned(),
                    });
                }
            }
            _ => {}
        }
    }
    imports
}

fn process_file(root: &Path, file: &str, files: &FxHashSet<String>) -> FileResult {
    let path = root.join(file);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return FileResult::Missing(file.to_owned()),
    };
    let source = match String::from_utf8(bytes) {
        Ok(source) => source,
        Err(error) => {
            let bytes = error.into_bytes();
            let lossy = String::from_utf8_lossy(&bytes);
            return FileResult::Invalid {
                file: file.to_owned(),
                token: source_token(&lossy),
            };
        }
    };
    let token = source_token(&source);
    let options =
        ParseOptions::from(Mode::Module).with_target_version(PythonVersion::latest_preview());
    let parsed = match parse(&source, options) {
        Ok(parsed) => parsed
            .try_into_module()
            .expect("module mode returns a module"),
        Err(_) => {
            return FileResult::Invalid {
                file: file.to_owned(),
                token,
            };
        }
    };
    let lines = LineIndex::new(&source);
    let imports = extract_imports(parsed.suite(), file, files);
    let mut definitions = DefinitionCollector {
        source: &source,
        lines: &lines,
        entries: Vec::new(),
        refs: FxHashMap::default(),
        scope: Vec::new(),
        scope_kinds: Vec::new(),
    };
    definitions.visit_body(parsed.suite());
    let mut references = ReferenceCollector {
        refs: &mut definitions.refs,
    };
    for stmt in parsed.suite() {
        references.visit_stmt(stmt);
    }
    FileResult::Parsed {
        file: file.to_owned(),
        entries: definitions.entries,
        imports,
        token,
        refs: definitions.refs,
    }
}

fn run(root: PathBuf, request: Request) -> Output {
    let files = request
        .files
        .into_iter()
        .filter(|file| file.ends_with(".py") || file.ends_with(".pyi"))
        .map(|file| file.replace('\\', "/"))
        .collect::<Vec<_>>();
    let file_set = files.iter().cloned().collect::<FxHashSet<_>>();
    let target_set = request
        .targets
        .into_iter()
        .map(|file| file.replace('\\', "/"))
        .collect::<FxHashSet<_>>();
    let targets = files
        .iter()
        .filter(|file| target_set.is_empty() || target_set.contains(*file))
        .collect::<Vec<_>>();
    let threads = env::var("CODE_MAP_PY_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|threads| *threads > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(1, usize::from)
                .min(MAX_THREADS)
        });
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .expect("failed to build parser thread pool");
    let results = pool.install(|| {
        targets
            .par_iter()
            .map(|file| process_file(&root, file, &file_set))
            .collect::<Vec<_>>()
    });
    let mut output = Output {
        v: 1,
        p: Vec::new(),
        i: Vec::new(),
        m: Vec::new(),
    };
    for result in results {
        match result {
            FileResult::Parsed {
                file,
                entries,
                imports,
                token,
                refs,
            } => {
                output
                    .p
                    .push(ParsedFile(file, token, entries, imports, refs));
            }
            FileResult::Invalid { file, token } => {
                output.i.push(InvalidFile(file, token));
            }
            FileResult::Missing(file) => output.m.push(file),
        }
    }
    output
}

fn main() -> ExitCode {
    let Some(root) = env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: extract <root>");
        return ExitCode::from(2);
    };
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("failed to read request: {error}");
        return ExitCode::FAILURE;
    }
    let request = match serde_json::from_str::<Request>(&input) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("invalid request: {error}");
            return ExitCode::from(2);
        }
    };
    let output = run(root, request);
    if let Err(error) = serde_json::to_writer(io::stdout().lock(), &output) {
        eprintln!("failed to write response: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
