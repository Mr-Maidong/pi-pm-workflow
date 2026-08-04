import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent/dist/core/session-manager.js";
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

interface RewindState {
	root?: string;
	blobDirectory?: string;
	config?: ResolvedCodeRewindConfig;
	baseline?: SourceManifest;
	redo?: SourceManifest;
	skipTreeRestoreFor?: string;
}

export default function (pi: ExtensionAPI) {
	const state: RewindState = {};

	const updateStatus = (ctx: ExtensionContext) => {
		const count = checkpointEntries(ctx.sessionManager.getEntries()).length;
		ctx.ui.setStatus(STATUS_KEY, count > 0 ? `rewind ${count}` : undefined);
	};

	const initialize = async (ctx: ExtensionContext): Promise<void> => {
		state.root = ctx.cwd;
		state.config = await loadConfig(ctx.cwd);
		state.blobDirectory = join(
			ctx.sessionManager.getSessionDir(),
			"code-rewind",
			ctx.sessionManager.getSessionId(),
			"blobs",
		);
		await mkdir(state.blobDirectory, { recursive: true });
		state.baseline = await scanSourceFiles(state.root, state.config);

		// A full baseline makes the first branch of a session restorable too.
		await persistCheckpoint(pi, state, ctx, "session-start", state.baseline);
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
			if (state.baseline && manifestsEqual(state.baseline, current)) return;
			await persistCheckpoint(pi, state, ctx, "after-agent", current);
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

		const target = findCheckpointForTarget(ctx.sessionManager, event.preparation.targetId);
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

			const checkpoints = checkpointEntries(ctx.sessionManager.getBranch());
			const labels = checkpoints.map(({ entry, checkpoint }, index) => checkpointLabel(index, entry, checkpoint));
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
			const target = checkpoints[labels.indexOf(choice) - offset];
			if (!target) return;

			try {
				const current = await scanSourceFiles(state.root, state.config);
				const diff = diffManifests(current, target.checkpoint.files);
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

			const mode = await ctx.ui.select("Rewind mode", [
				"Restore conversation and source files",
				"Restore source files only",
				"Restore conversation only",
				"Cancel",
			]);
			if (!mode || mode === "Cancel") return;

			if (mode !== "Restore conversation only") {
				const restored = await restoreCurrentManifest(state, ctx, target.checkpoint.files, "Source files restored");
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
	state: Required<Pick<RewindState, "root" | "blobDirectory" | "config">> & RewindState,
	ctx: ExtensionContext,
	phase: CodeCheckpoint["phase"],
	files: SourceManifest,
): Promise<void> {
	await saveManifestBlobs(state.root, state.blobDirectory, files);
	const checkpoint: CodeCheckpoint = {
		version: 1,
		phase,
		anchorEntryId: ctx.sessionManager.getLeafId(),
		timestamp: Date.now(),
		files,
	};
	pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
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

function checkpointEntries(entries: SessionEntry[]): CheckpointEntry[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_TYPE || !isCodeCheckpoint(entry.data)) return [];
		return [{ entry: entry as CustomEntry<CodeCheckpoint>, checkpoint: entry.data }];
	});
}

function findCheckpointForTarget(
	sessionManager: ExtensionContext["sessionManager"],
	targetId: string,
): CheckpointEntry | undefined {
	return checkpointEntries(sessionManager.getBranch(targetId)).at(-1);
}

function checkpointLabel(index: number, entry: CustomEntry<CodeCheckpoint>, checkpoint: CodeCheckpoint): string {
	const time = new Date(checkpoint.timestamp).toLocaleTimeString();
	const files = Object.keys(checkpoint.files).length;
	return `#${index + 1} ${time} ${checkpoint.phase} (${files} source files) [${entry.id.slice(0, 6)}]`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
