import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import {
	CHECKPOINT_TYPE,
	type CodeCheckpoint,
	type SourceManifest,
	changedFileCount,
	diffManifests,
	findBestCheckpoint,
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
const RESTORE_CODE = "Restore source files";
const KEEP_CODE = "Keep current source files";
const CANCEL_NAVIGATION = "Cancel navigation";

type CheckpointEntry = { entry: CustomEntry<CodeCheckpoint>; checkpoint: CodeCheckpoint };
type UserMessageEntry = Extract<SessionEntry, { type: "message" }>;
type RewindTarget = { entry: UserMessageEntry; checkpoint?: CheckpointEntry };

interface RewindState {
	root?: string;
	blobDirectory?: string;
	config?: ResolvedCodeRewindConfig;
	baseline?: SourceManifest;
	redo?: SourceManifest;
	skipTreeRestoreFor?: string;
	/** 已被清理、不再可回退的检查点 entry id 集合（持久化到 pruned.json）。 */
	pruned?: Set<string>;
	prunedFile?: string;
}

export default function (pi: ExtensionAPI) {
	const state: RewindState = {};

	const updateStatus = (ctx: ExtensionContext) => {
		const count = rewindTargets(ctx.sessionManager, state.pruned).length;
		ctx.ui.setStatus(STATUS_KEY, count > 0 ? `Rewind ${count}` : undefined);
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
		updateStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await initialize(ctx);
		} catch (error) {
			state.root = undefined;
			state.config = undefined;
			state.baseline = undefined;
			ctx.ui.setStatus(STATUS_KEY, "rewind unavailable");
			if (ctx.hasUI) ctx.ui.notify(`Code rewind disabled: ${errorMessage(error)}`, "warning");
		}
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
			updateStatus(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Code checkpoint failed: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (!isReady(state)) return undefined;
		if (state.skipTreeRestoreFor === event.preparation.targetId) {
			state.skipTreeRestoreFor = undefined;
			return undefined;
		}
		if (!ctx.hasUI) return undefined;

		const target = findCheckpointForTarget(ctx.sessionManager, event.preparation.targetId, state.pruned);
		if (!target) return undefined;

		try {
			const current = await scanSourceFiles(state.root, state.config);
			const diff = diffManifests(current, target.checkpoint.files);
			if (changedFileCount(diff) === 0) return undefined;

			const summary = formatDiffSummary(diff);
			const choice = await ctx.ui.select(
				`Source files differ at the selected conversation point:\n${summary}`,
				[RESTORE_CODE, KEEP_CODE, CANCEL_NAVIGATION],
			);
			if (!choice || choice === CANCEL_NAVIGATION) return { cancel: true };
			if (choice === KEEP_CODE) return undefined;

			await restoreWithRedo(state, current, target.checkpoint.files);
			state.baseline = target.checkpoint.files;
			ctx.ui.notify("Source files restored for the selected conversation point", "info");
			return undefined;
		} catch (error) {
			ctx.ui.notify(`Source restore failed: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
	});

	pi.registerCommand("rewind", {
		description: "Restore source files and optionally navigate to a checkpoint",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!isReady(state)) {
				ctx.ui.notify("Code rewind is not available", "warning");
				return;
			}

			const targets = rewindTargets(ctx.sessionManager, state.pruned);
			const labels = targets.map((target, index) => rewindTargetLabel(index, target));
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
				return;
			}

			const offset = state.redo ? 1 : 0;
			const target = targets[labels.indexOf(choice) - offset];
			if (!target) return;

			if (target.checkpoint) {
				try {
					const current = await scanSourceFiles(state.root, state.config);
					const diff = diffManifests(current, target.checkpoint.checkpoint.files);
					if (changedFileCount(diff) > 0) {
						const proceed = await ctx.ui.confirm(
							`Source files that would be restored:\n${formatDiffSummary(diff)}`,
							"Continue to restore options?",
						);
						if (!proceed) return;
					}
				} catch (error) {
					ctx.ui.notify(`Code rewind could not scan source files: ${errorMessage(error)}`, "error");
					return;
				}
			}

			const mode = await ctx.ui.select(
				"Rewind mode",
				target.checkpoint
					? [
						"Restore conversation and source files",
						"Restore source files only",
						"Restore conversation only",
						"Cancel",
					]
					: ["Restore conversation only", "Cancel"],
			);
			if (!mode || mode === "Cancel") return;

			if (target.checkpoint && mode !== "Restore conversation only") {
				const restored = await restoreCurrentManifest(state, ctx, target.checkpoint.checkpoint.files, "Source files restored");
				if (!restored) return;
			}
			if (mode !== "Restore source files only") {
				state.skipTreeRestoreFor = target.entry.id;
				await ctx.navigateTree(target.entry.id, { summarize: true });
			}
		},
	});

	// Keep Pi's built-in double-Escape /tree behavior. session_before_tree supplies
	// the restore/keep/cancel choice before navigation, so this extension does not
	// register a competing shortcut without navigation privileges.
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
	ctx: ExtensionCommandContext,
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

function rewindTargets(
	sessionManager: ExtensionContext["sessionManager"],
	pruned?: Set<string>,
): RewindTarget[] {
	return sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		// 检查点 cpN 挂在 userN 的 assistant 回复之下，是 userN 的后代；
		// 因此以用户消息自身为锚向下找第一个检查点，才能对应当前这一轮。
		const checkpoint = findCheckpointForTarget(sessionManager, entry.id, pruned);
		return [{ entry: entry as UserMessageEntry, checkpoint }];
	});
}

function userMessageText(entry: UserMessageEntry): string {
	const content = entry.message.content;
	const text = typeof content === "string"
		? content
		: content.map((part) => part.type === "text" ? part.text : "[image]").join(" ");
	return text.replace(/\s+/g, " ").trim();
}

function rewindTargetLabel(index: number, target: RewindTarget): string {
	const time = new Date(target.entry.timestamp).toLocaleTimeString();
	const prompt = userMessageText(target.entry);
	const preview = prompt.length > 72 ? `${prompt.slice(0, 71)}…` : prompt;
	return `#${index + 1} ${time} ${preview || "[empty message]"}`;
}

function checkpointEntries(entries: SessionEntry[], pruned?: Set<string>): CheckpointEntry[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !isCodeCheckpoint(entry.data)) return [];
		if (pruned?.has(entry.id)) return [];
		return [{ entry: entry as CustomEntry<CodeCheckpoint>, checkpoint: entry.data }];
	});
}

function findCheckpointForTarget(
	sessionManager: ExtensionContext["sessionManager"],
	targetId: string,
	pruned?: Set<string>,
): CheckpointEntry | undefined {
	if (!targetId) return undefined;
	const found = findBestCheckpoint(
		sessionManager.getEntries(),
		targetId,
		(entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE && isCodeCheckpoint(entry.data),
		pruned,
	);
	if (!found || found.type !== "custom") return undefined;
	return { entry: found as CustomEntry<CodeCheckpoint>, checkpoint: found.data as CodeCheckpoint };
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
