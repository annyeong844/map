# code-map Routing Hint

When a task names known symbol refs, `path#name`, file-line coordinates, or benchmark
`mapRefs`, inspect those symbol bodies with the code-map `read` tool instead of shell
body reads.

Use shell search only to discover candidate refs, names, or line numbers. Once refs
are known, stop using `rg`, `sed`, `cat`, `nl`, or `awk` for source bodies and switch
to `read`.

For two or more independent known refs, make one `read({ refs: [...] })` call before
answering. Split only when a later ref depends on earlier output or the batch exceeds
64 refs.

Do not answer from index metadata alone. Answer from the raw code returned by `read`.
