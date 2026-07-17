# Security policy

## Supported versions

Security fixes are provided for the latest `0.9.x` release candidate. Pre-RC snapshots are unsupported.

## Reporting

Please use GitHub's private vulnerability reporting for `annyeong844/map`. If that is unavailable, open an issue asking for a private contact without including exploit details.

## Security model

code-map is a local developer tool. It reads source files under the indexed root, writes the requested `.map-index.json`, and exposes one read-only MCP tool. It makes no application network requests.

- Treat source repositories and index files as untrusted input. Read paths are constrained to the indexed root, and stale coordinates are re-anchored or rejected rather than silently trusted.
- The optional Python backend starts a local Python 3 process. `CODE_MAP_PYTHON` is an explicit executable override and should not point to untrusted programs.
- `map setup --apply` changes only the selected user's agent configuration. Run it without `--apply` first to inspect the plan.
- The first npm publication uses a shortest-lived granular token only as the protected `NPM_BOOTSTRAP_TOKEN` GitHub environment secret so the CI-built five-platform native bundle ships intact. Delete it immediately after bootstrap; the workflow then rejects lingering bootstrap credentials and uses GitHub OIDC trusted publishing with provenance.
- `code-oracle` is not included in the core npm tarball during the RC cycle. It launches separately installed language servers and has a larger trust surface.
