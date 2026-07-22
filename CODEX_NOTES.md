# Codex notes

## Implementation

- Added `scripts/check.sh`, an executable Bash helper that discovers and caches
  flake check names, selects them by regex, applies local source overrides,
  intent-adds untracked files, genuinely rebuilds existing outputs, tallies
  repeated runs, and prints compact failure excerpts from `nix log`.
- Added the check helper to the build/test guidance in `contributing.md`.
- Left `flake.nix` unchanged. Its dev shells list packages directly and do not
  have an existing mechanism for wiring repository scripts, so there was no
  natural integration point.

This is a pure jj workspace with no `.git` directory. The script uses
`git rev-parse` in normal Git-backed worktrees and has a narrow `.jj` fallback
based on its own location so it can run here. This workspace also has no
`checkouts/` directory, so the default-override validation found no applicable
checkout and correctly emitted no override notices or staleness warnings.

## Validation runs

All requested validation was run after the `contributing.md` edit:

- `scripts/check.sh 'formatting'` — exit 0; the output did not exist, so the
  script used a plain build; `formatting` finished with 1 pass, 0 fail.
- `scripts/check.sh 'file-check'` — exit 0; rebuilt the existing
  `file-check-detect` output with `--rebuild`; 1 pass, 0 fail.
- `scripts/check.sh --no-overrides 'file-check'` — exit 0; rebuilt the existing
  `file-check-detect` output with `--rebuild`; 1 pass, 0 fail.
- `scripts/check.sh -n 2 'formatting'` — exit 0; both iterations reported
  `rebuilding existing output`; final tally was 2 pass, 0 fail. `formatting`
  was used because `basic-init-check-heap` does not exist and it is the
  cheapest available check.
- `shellcheck scripts/check.sh` — exit 0, no diagnostics.
- `shfmt -d -i 2 -s scripts/check.sh` — exit 0, no diff.
- `bash -n scripts/check.sh` — exit 0.
- From `packages/file`, `../../scripts/check.sh --help` — exit 0, confirming
  invocation from another directory inside the repository.

During development, the first static pass reported ShellCheck SC2319 and an
expected shfmt indentation diff; a later attempted regex-validation form
reported SC2234. Both were corrected before the validation runs above. A
deliberate `scripts/check.sh '['` run exited 2 with the intended invalid-regex
diagnostic.
