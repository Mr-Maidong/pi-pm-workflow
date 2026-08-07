import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	CHECKPOINT_TYPE,
	type CodeCheckpoint,
	type SourceManifest,
	changedFileCount,
	diffManifests,
	formatDiffSummary,
	isCodeCheckpoint,
	loadConfig,
	manifestsEqual,
	pruneOrphanedBlobs,
	referencedBlobHashes,
	restoreManifest,
	saveManifestBlobs,
	scanSourceFiles,
	type ResolvedCodeRewindConfig,
} from "../lib/code-rewind-core.js";

const STATUS_KEY = "code-rewind";
const DOUBLE_ESCAPE_MS = 500;

type CheckpointEntry = { entry: CustomEntry<CodeCheckpoint>; checkpoint: CodeCheckpoint };

interface RewindState {
	root?: string;
	blobDirectory?: string;
	config?: ResolvedCodeRewindConfig;
	baseline?: SourceManifest;
	redo?: SourceManifest;
	/** 已被清理、不再可回退的检查点 entry id 集合（持久化到 pruned.json）。 */
	pruned?: Set<string>;
	prunedFile?: string;
	unsubscribeTerminalInput?: () => void;
	lastEscapeTime?: number;
	panelOpen?: boolean;
}

export default function (pi: ExtensionAPI) {
	const state: RewindState = {};

	const updateStatus = (ctx: ExtensionContext) => {
		const count = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned).length;
		ctx.ui.setStatus(STATUS_KEY, count > 0 ? `Rewind ${count}` : undefined);
	};

	const openRewindPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (state.panelOpen) return;
		if (!isReady(state)) {
			ctx.ui.notify("Code rewind is not available", "warning");
			return;
		}

		state.panelOpen = true;
		try {
			const targets = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned);
			const labels = targets.map((target, index) => checkpointLabel(index, target));
			if (state.redo) labels.unshift("Redo last source restore");
			if (labels.length === 0) {
				ctx.ui.notify("No code checkpoints are available", "warning");
				return;
			}

			const choice = await ctx.ui.select("Code rewind checkpoint", labels);
			if (!choice) return;
			if (choice === "Redo last source restore" && state.redo) {
				await restoreCurrentManifest(state, ctx, state.redo, "Source files restored to the pre-rewind state");
				state.redo = undefined;
				updateStatus(ctx);
				return;
			}

			const offset = state.redo ? 1 : 0;
			const target = targets[labels.indexOf(choice) - offset];
			if (!target) return;

			try {
				const current = await scanSourceFiles(state.root, state.config);
				const diff = diffManifests(current, target.checkpoint.files);
				if (changedFileCount(diff) > 0) {
					const proceed = await ctx.ui.confirm(
						`Source files that would be restored:\n${formatDiffSummary(diff)}`,
						"Restore source files to this checkpoint?",
					);
					if (!proceed) return;
				} else {
					ctx.ui.notify("Source files already match this checkpoint", "info");
					// 即使无差异，仍截断后续检查点，保持线性回退语义。
				}
			} catch (error) {
				ctx.ui.notify(`Code rewind could not scan source files: ${errorMessage(error)}`, "error");
				return;
			}

			const restored = await restoreCurrentManifest(
				state,
				ctx,
				target.checkpoint.files,
				`Source files restored to #${labels.indexOf(choice) - offset + 1}`,
			);
			if (!restored) return;

			// 恢复到序号 N 后，丢弃 N 之后的检查点，使其不可再回退。
			await discardCheckpointsAfter(state, ctx, target.entry.id, updateStatus);
			updateStatus(ctx);
		} finally {
			state.panelOpen = false;
		}
	};

	const setupDoubleEscape = (ctx: ExtensionContext): void => {
		state.unsubscribeTerminalInput?.();
		state.unsubscribeTerminalInput = undefined;
		state.lastEscapeTime = 0;
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		state.unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "escape")) return;
			if (state.panelOpen) return;
			if (!ctx.isIdle()) return;
			if (ctx.ui.getEditorText().trim()) return;

			const now = Date.now();
			if (state.lastEscapeTime && now - state.lastEscapeTime < DOUBLE_ESCAPE_MS) {
				state.lastEscapeTime = 0;
				// 吞掉第二次 Esc，避免触发 Pi 内置的 /tree 双击行为。
				void openRewindPanel(ctx);
				return { consume: true };
			}
			state.lastEscapeTime = now;
			return;
		});
	};

	const initialize = async (ctx: ExtensionContext): Promise<void> => {
		state.root = ctx.cwd;
		state.config = await loadConfig(ctx.cwd);
		const blobDirectory = join(
			ctx.sessionManager.getSessionDir(),
			"code-rewind",
			ctx.sessionManager.getSessionId(),
			"blobs",
		);
		state.blobDirectory = blobDirectory;
		await mkdir(blobDirectory, { recursive: true });
		const prunedFile = join(dirname(blobDirectory), "pruned.json");
		state.prunedFile = prunedFile;
		state.pruned = await loadPruned(prunedFile);
		state.baseline = await scanSourceFiles(state.root, state.config);

		// Reloads can fire session_start repeatedly. Reuse an identical checkpoint
		// instead of appending another session-start entry for unchanged code.
		const latest = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned).at(-1);
		if (!latest || !manifestsEqual(latest.checkpoint.files, state.baseline)) {
			await persistCheckpoint(pi, state, ctx, "session-start", state.baseline, updateStatus);
		}
		setupDoubleEscape(ctx);
		updateStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await initialize(ctx);
		} catch (error) {
			state.root = undefined;
			state.config = undefined;
			state.baseline = undefined;
			state.unsubscribeTerminalInput?.();
			state.unsubscribeTerminalInput = undefined;
			ctx.ui.setStatus(STATUS_KEY, "rewind unavailable");
			if (ctx.hasUI) ctx.ui.notify(`Code rewind disabled: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		state.unsubscribeTerminalInput?.();
		state.unsubscribeTerminalInput = undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!isReady(state)) return;
		try {
			state.baseline = await scanSourceFiles(state.root, state.config);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Code rewind could not scan source files: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!isReady(state)) return;
		try {
			const current = await scanSourceFiles(state.root, state.config);
			const latest = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned).at(-1);
			if (latest && manifestsEqual(latest.checkpoint.files, current)) {
				state.baseline = current;
				return;
			}
			if (state.baseline && manifestsEqual(state.baseline, current)) return;
			await persistCheckpoint(pi, state, ctx, "after-agent", current, updateStatus);
			state.baseline = current;
			// 新检查点产生后，旧的 redo 快照不再有意义。
			state.redo = undefined;
			updateStatus(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Code checkpoint failed: ${errorMessage(error)}`, "warning");
		}
	});

	pi.registerCommand("rewind", {
		description: "Restore source files to a previous code checkpoint",
		handler: async (_args, ctx) => {
			await openRewindPanel(ctx);
		},
	});
}

function isReady(state: RewindState): state is Required<Pick<RewindState, "root" | "blobDirectory" | "config">> & RewindState {
	return Boolean(state.root && state.blobDirectory && state.config);
}

async function persistCheckpoint(
	pi: ExtensionAPI,
	state: RewindState,
	ctx: ExtensionContext,
	phase: CodeCheckpoint["phase"],
	files: SourceManifest,
	updateStatus: (ctx: ExtensionContext) => void,
): Promise<void> {
	if (!isReady(state)) return;
	await saveManifestBlobs(state.root, state.blobDirectory, files);
	const checkpoint: CodeCheckpoint = {
		version: 1,
		phase,
		anchorEntryId: ctx.sessionManager.getLeafId(),
		timestamp: Date.now(),
		files,
	};
	pi.appendEntry(CHECKPOINT_TYPE, checkpoint);

	// 每个新检查点落库后触发清理：保留最近 retention 个，删除更旧检查点的孤儿 blob。
	await pruneCheckpoints(state, ctx, updateStatus);
}

async function restoreWithRedo(
	state: Required<Pick<RewindState, "root" | "blobDirectory" | "config">> & RewindState,
	current: SourceManifest,
	target: SourceManifest,
): Promise<void> {
	await saveManifestBlobs(state.root, state.blobDirectory, current);
	await restoreManifest(state.root, state.blobDirectory, current, target, state.config);
	state.redo = current;
}

async function restoreCurrentManifest(
	state: Required<Pick<RewindState, "root" | "blobDirectory" | "config">> & RewindState,
	ctx: ExtensionContext,
	target: SourceManifest,
	successMessage: string,
): Promise<boolean> {
	try {
		const current = await scanSourceFiles(state.root, state.config);
		await restoreWithRedo(state, current, target);
		state.baseline = target;
		ctx.ui.notify(successMessage, "info");
		return true;
	} catch (error) {
		ctx.ui.notify(`Source restore failed: ${errorMessage(error)}`, "error");
		return false;
	}
}

function checkpointLabel(index: number, target: CheckpointEntry): string {
	const time = new Date(target.checkpoint.timestamp).toLocaleTimeString();
	const phase = target.checkpoint.phase === "session-start" ? "session start" : "after agent";
	const fileCount = Object.keys(target.checkpoint.files).length;
	return `#${index + 1} ${time} ${phase} (${fileCount} files)`;
}

function checkpointEntries(entries: SessionEntry[], pruned?: Set<string>): CheckpointEntry[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !isCodeCheckpoint(entry.data)) return [];
		if (pruned?.has(entry.id)) return [];
		return [{ entry: entry as CustomEntry<CodeCheckpoint>, checkpoint: entry.data }];
	});
}

async function loadPruned(file: string): Promise<Set<string>> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as { ids?: string[] };
		return new Set(Array.isArray(parsed.ids) ? parsed.ids : []);
	} catch {
		return new Set();
	}
}

async function savePruned(file: string, pruned: Set<string>): Promise<void> {
	await writeFile(file, JSON.stringify({ ids: [...pruned] }), "utf8");
}

/** 恢复到某个检查点后，丢弃其后的全部检查点（线性回退，不可再前进到被丢弃的序号）。 */
async function discardCheckpointsAfter(
	state: RewindState,
	ctx: ExtensionContext,
	keptCheckpointId: string,
	updateStatus: (ctx: ExtensionContext) => void,
): Promise<void> {
	if (!state.config || !state.blobDirectory || !state.pruned || !state.prunedFile) return;
	const visible = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned);
	const keepIndex = visible.findIndex((checkpoint) => checkpoint.entry.id === keptCheckpointId);
	if (keepIndex < 0) return;

	const toKeep = visible.slice(0, keepIndex + 1);
	const toPrune = visible.slice(keepIndex + 1);
	if (toPrune.length === 0) {
		updateStatus(ctx);
		return;
	}

	for (const checkpoint of toPrune) state.pruned.add(checkpoint.entry.id);

	const needed = referencedBlobHashes(toKeep.map((checkpoint) => checkpoint.checkpoint.files));
	if (state.baseline) referencedBlobHashes([state.baseline]).forEach((hash) => needed.add(hash));
	if (state.redo) referencedBlobHashes([state.redo]).forEach((hash) => needed.add(hash));

	try {
		await pruneOrphanedBlobs(state.blobDirectory, needed);
		await savePruned(state.prunedFile, state.pruned);
		updateStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Discarded ${toPrune.length} later checkpoint${toPrune.length === 1 ? "" : "s"}`, "info");
		}
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`Code rewind cleanup failed: ${errorMessage(error)}`, "warning");
	}
}

/** 保留最近 retention 个检查点，将更旧的标记为已清理并删除其不再被引用的孤儿 blob。 */
async function pruneCheckpoints(
	state: RewindState,
	ctx: ExtensionContext,
	updateStatus: (ctx: ExtensionContext) => void,
): Promise<void> {
	if (!state.config || !state.blobDirectory || !state.pruned || !state.prunedFile) return;
	const retention = state.config.retention;
	const visible = checkpointEntries(ctx.sessionManager.getBranch(), state.pruned);
	if (visible.length <= retention) return;

	const toPrune = visible.slice(0, visible.length - retention);
	for (const checkpoint of toPrune) state.pruned.add(checkpoint.entry.id);

	// 仅保留仍在用的 blob：保留的检查点 + 当前 baseline + redo 快照所引用的 hash。
	const keep = visible.slice(-retention);
	const needed = referencedBlobHashes(keep.map((checkpoint) => checkpoint.checkpoint.files));
	if (state.baseline) referencedBlobHashes([state.baseline]).forEach((hash) => needed.add(hash));
	if (state.redo) referencedBlobHashes([state.redo]).forEach((hash) => needed.add(hash));

	try {
		await pruneOrphanedBlobs(state.blobDirectory, needed);
		await savePruned(state.prunedFile, state.pruned);
		updateStatus(ctx);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`Code rewind cleanup failed: ${errorMessage(error)}`, "warning");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
