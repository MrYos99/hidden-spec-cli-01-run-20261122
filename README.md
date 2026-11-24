# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MrYos99/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/MrYos99/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a small, deterministic patch applier: one tool that reads four patch
formats and applies them to a file tree, changing every file or none at all.

## Formats

- **Unified diff** — `diff --git` sections and bare `---`/`+++` sections, with
  hunks, renames, creations and deletions.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, each preceded by the file path.
- **V4A patch format** — `*** Begin Patch` / `*** End Patch`, with
  `*** Add File:` / `*** Delete File:` / `*** Update File:` sections,
  `@@` anchors and `*** Move to:`.
- **JSON edits** — one JSON array of edit objects, or JSON Lines; `create`,
  `str_replace` and `insert` commands.

The format is detected automatically from the patch text, or forced with
`--format=NAME` (`unified`, `search-replace`, `v4a`, `json`, `auto`).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted for standard input. The working
directory is the tree root.

- `--check` — dry run: same output and exit code, nothing is written.
- `--strict` — tier-0 matching only (no whitespace-tolerant matching).

## Matching

An old block is found at the first of three tiers that has at least one
occurrence: exact lines, lines equal after stripping trailing spaces/tabs,
lines equal after stripping leading and trailing spaces/tabs. A context line
is written back as the file's own matched line, never the patch's. At tier 2,
new lines are re-indented from the old block's leading whitespace to the
file's.

## Output and exit codes

- Exit 0 — one line per changed path in UTF-8 byte order, then
  `ok: <n> files` (or `ok: 1 file`). `A` created, `D` deleted, `M` changed,
  `R <old> -> <new>` for a successful move. A file whose bytes are unchanged
  is not listed.
- Exit 1 — one `error: <code> <path>` line per failed edit, in patch order,
  then `failed: <k> of <n> edits`. Nothing is written: a failed edit never
  stops later edits from running, but when any edit failed, no file is
  written at all.
- Exit 2 — one line: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` (N is the 1-based patch line).

## Notes

- Node.js 22 standard library only; no dependencies, no network.
- Deterministic: the same patch on the same tree always gives the same exit
  code, stdout and files.
- Paths are checked for safety before anything else (`..`, absolute paths and
  backslashes are refused with `error: unsafe <path>`).
- Files keep their own line break (CRLF or LF) and their final line break,
  unless the patch's `\ No newline at end of file` marker says otherwise.
  Created files use LF and end with a line break unless the format says
  otherwise.

## Development

`node check.ts <practice.json>` runs the local practice checks
(100 checks; the kit's practice set).

## License

MIT — see `LICENSE`.

Entry for the make.fun bounty
[HIDDEN-SPEC-CLI-01](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
