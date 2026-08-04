# Code Rewind Implementation TODO

## Goal

Add a Pi extension that restores source-code files together with the selected conversation-tree point. The implementation must not alter normal Git history, Git index, dependencies, binary assets, build outputs, or virtual environments.

## Confirmed Scope

- [x] Restore only configured source-code files.
- [x] Cover `edit`, `write`, `bash`, Python, Node, formatters, and other processes by scanning eligible source files at turn boundaries.
- [x] Support source-file creation, modification, deletion, and rename-as-delete-plus-create.
- [x] Bind each checkpoint to the Pi session-tree custom entry that persists it; resolve targets through the ancestor path rather than timestamps.
- [x] On `/tree` navigation, show a code restore choice before navigation. Cancellation or restore failure cancels navigation.
- [ ] Add a dedicated double-Escape restore-mode selector. Current behavior intentionally retains Pi's default double-Escape `/tree`; `/tree` offers conversation-only or conversation-plus-code, while `/rewind` also offers code-only.
- [ ] Add checkpoint/blob retention and safe pruning.

## Explicit Non-Goals for v1

- [x] Do not restore `node_modules`, virtual environments, build output, caches, binaries, or files outside the project root.
- [x] Do not restore Git branch, commit history, index, stash, or Git configuration.
- [x] Do not promise exact restoration at intermediate tool-call nodes; v1 supports session-start and completed agent-turn boundaries.
- [x] Do not silently overwrite code in non-interactive mode.

## Source File Policy

- [x] Add project-level `code-rewind.json` configuration for source extensions, include paths, exclude paths, and maximum file size.
- [x] Define defaults for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.cs`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.less`, `.html`, `.sql`, `.sh`.
- [x] Exclude `.git`, `node_modules`, `.venv`, `venv`, `dist`, `build`, `coverage`, cache directories, user-configured exclusions, and paths ignored by Git's ignore rules.
- [x] Resolve and validate paths against the project root before reading, writing, or deleting them.

## Data Model

- [x] Create a content-addressed blob store for source-file contents, keyed by SHA-256.
- [x] Store checkpoint manifests separately from blobs. v1 uses complete eligible-source manifests `{ exists, blobHash?, mode? }`, rather than delta manifests, to keep branch restoration unambiguous.
- [x] Persist schema version, `anchorEntryId`, phase, timestamp, and complete source state in `pi.appendEntry("code-rewind-checkpoint", data)`.
- [ ] Add explicit checkpoint IDs, session IDs, and changed-path summaries to metadata.
- [ ] On `session_start`, verify all ancestor-reachable checkpoint blobs and report missing/corrupt storage.
- [x] Store blobs durably under Pi's session directory and document that session export/import must include the corresponding `code-rewind/<session-id>/blobs` directory.
- [ ] Define a cleanup lifecycle for obsolete blob directories.

## Checkpoint Capture

- [x] On `session_start`, create a full baseline checkpoint for the current source state.
- [x] On `turn_start`, scan eligible source files and retain an in-memory baseline manifest.
- [x] On `agent_settled`, scan again and create an `after-agent` checkpoint only when the source manifest changed.
- [x] Deduplicate blobs by SHA-256. Manifests are complete snapshots; existing blob content is not written again.
- [x] Anchor `after-agent` checkpoints to the leaf that existed immediately before appending the checkpoint entry.
- [x] Handle agent turns with no eligible source-file changes without creating a checkpoint.
- [ ] Detect source files changed by background processes after `agent_settled` and warn that their state falls outside the stable turn boundary.

## Tree Mapping And Restore

- [x] Resolve target source state from checkpoint entries reachable on the target `entryId` ancestor chain.
- [ ] Add a Pi integration test for user-message selection semantics, where `/tree` moves the leaf to the user message's parent.
- [x] Run restore planning and confirmation in `session_before_tree`, using `event.preparation.targetId`.
- [x] Save the current source manifest and blobs before restore as an in-memory redo state.
- [x] Show created, modified, and deleted source-file diff summaries before restore.
- [x] Restore files with sibling temporary files, SHA-256 validation, and atomic rename.
- [x] Delete only eligible source files absent from the target manifest.
- [x] On restore failure, attempt to roll back already-applied source files, surface diagnostics, and cancel `/tree` navigation.
- [x] Allow Pi tree navigation only after a successful restore or an explicit "keep current source files" choice.

## Commands And UX

- [x] Add `/rewind` to browse ancestor-reachable checkpoints and preview source diffs.
- [x] Add restore choices: conversation plus code, code only, conversation only, and cancel.
- [x] Add redo for the most recent successful source restore during the running extension session.
- [x] Document and retain Pi's default `doubleEscapeAction` / `/tree` behavior instead of registering a competing shortcut without navigation privileges.
- [x] Add a compact footer status indicator with checkpoint count and unavailable state.
- [x] In headless/non-interactive mode, do not execute destructive source restore flows.

## Safety And Limits

- [x] Enforce a configurable maximum source-file size. Default: 1 MiB.
- [ ] Add a maximum total checkpoint/blob storage budget.
- [ ] Add checkpoint retention and reference-aware blob garbage collection.
- [ ] Preserve file mode where platform support permits and document the v1 symlink policy. Current behavior preserves mode for regular files and skips symlinks.
- [x] Refuse to restore paths that escape project root, refer to excluded directories, or no longer match the source-file policy.
- [ ] Distinguish external modifications after the latest checkpoint from ordinary target-state diff entries in the restore UI.

## Tests

- [x] Unit test source-file filtering, root containment, size limits, manifest diffing, blob hashing, and restore-plan behavior.
- [x] Unit test file creation, modification, deletion, and restoration.
- [ ] Add rename, empty file, Unicode content, and executable-script cases.
- [ ] Add Python/shell/formatter integration tests that modify eligible source files inside a real agent turn.
- [x] Unit test excluded directories, oversized source files, and binary-extension files remain untouched.
- [ ] Add sibling-branch tests proving only ancestor-reachable checkpoints are selected.
- [ ] Add restore failure tests proving `/tree` navigation is cancelled and applied files are rolled back.
- [ ] Add reload/restart, redo persistence, retention, and garbage-collection tests.
- [ ] Manually verify double-Escape, `/tree`, `/fork`, `/reload`, and headless behavior in temporary Git and non-Git projects.

## Reference Material

- Use `pi-rewind` as UX and operational reference only: picker, diff preview, redo, checkpoint count, and `/tree` prompting.
- Do not copy its Git ref/`commit-tree`/`reset --hard` implementation or timestamp-based tree mapping.
- Use current Pi extension events: `turn_start`, `agent_settled`, `session_before_tree`, `session_tree`, `session_start`, and `session_shutdown`.
