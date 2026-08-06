import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export const CHECKPOINT_TYPE = "code-rewind-checkpoint";
export const CHECKPOINT_VERSION = 1;

/** 默认保留的最近检查点数量；超过后自动清理更旧的检查点及其 blob 快照。 */
export const DEFAULT_RETENTION = 30;

const DEFAULT_EXTENSIONS = [
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
	".java", ".kt", ".cs", ".vue", ".svelte", ".astro", ".css", ".scss",
	".less", ".html", ".sql", ".sh",
];

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
	".git", "node_modules", ".venv", "venv", "env", "dist", "build", "coverage",
	".cache", ".pytest_cache", ".mypy_cache", ".tox", "__pycache__",
]);

export interface CodeRewindConfig {
	include?: string[];
	exclude?: string[];
	extensions?: string[];
	maxFileSize?: number;
	/** 保留的最近检查点数量，超过后自动清理更旧的检查点及其 blob 快照（默认 30）。 */
	retention?: number;
}

export interface ResolvedCodeRewindConfig {
	include: string[];
	exclude: string[];
	extensions: Set<string>;
	maxFileSize: number;
	retention: number;
}

export interface SourceFileState {
	exists: boolean;
	blobHash?: string;
	mode?: number;
}

export type SourceManifest = Record<string, SourceFileState>;

export interface CodeCheckpoint {
	version: number;
	phase: "session-start" | "after-agent";
	anchorEntryId: string | null;
	timestamp: number;
	files: SourceManifest;
}

export interface RestoreDiff {
	created: string[];
	modified: string[];
	deleted: string[];
}

export function resolveConfig(config: CodeRewindConfig = {}): ResolvedCodeRewindConfig {
	return {
		include: config.include?.map(normalizeRelativePath) ?? [],
		exclude: config.exclude?.map(normalizeRelativePath) ?? [],
		extensions: new Set((config.extensions ?? DEFAULT_EXTENSIONS).map((extension) => extension.toLowerCase())),
		maxFileSize: config.maxFileSize ?? 1024 * 1024,
		retention: Math.max(1, Math.floor(config.retention ?? DEFAULT_RETENTION)),
	};
}

export async function loadConfig(root: string): Promise<ResolvedCodeRewindConfig> {
	try {
		const parsed = JSON.parse(await readFile(join(root, "code-rewind.json"), "utf8")) as CodeRewindConfig;
		return resolveConfig(parsed);
	} catch (error) {
		if (isMissingFileError(error)) return resolveConfig();
		throw new Error(`Invalid code-rewind.json: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function scanSourceFiles(root: string, config: ResolvedCodeRewindConfig): Promise<SourceManifest> {
	const manifest: SourceManifest = {};
	const rootPath = resolve(root);
	const candidates: Array<{ path: string; fullPath: string }> = [];

	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(directory, entry.name);
			const path = toProjectPath(rootPath, fullPath);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (!shouldVisitDirectory(path, config)) continue;
				await visit(fullPath);
				continue;
			}
			if (!entry.isFile() || !isEligibleSourcePath(path, config)) continue;
			candidates.push({ path, fullPath });
		}
	};

	await visit(rootPath);
	const ignoredPaths = await findGitIgnoredPaths(rootPath, candidates.map((candidate) => candidate.path));
	for (const candidate of candidates) {
		if (ignoredPaths.has(candidate.path)) continue;
		const fileStat = await stat(candidate.fullPath);
		if (fileStat.size > config.maxFileSize) continue;
		const content = await readFile(candidate.fullPath);
		manifest[candidate.path] = {
			exists: true,
			blobHash: hashContent(content),
			mode: fileStat.mode & 0o777,
		};
	}
	return manifest;
}

export async function saveManifestBlobs(root: string, blobDirectory: string, manifest: SourceManifest): Promise<void> {
	await mkdir(blobDirectory, { recursive: true });
	for (const [path, state] of Object.entries(manifest)) {
		if (!state.exists || !state.blobHash) continue;
		const sourcePath = resolveProjectPath(root, path);
		const content = await readFile(sourcePath);
		if (hashContent(content) !== state.blobHash) {
			throw new Error(`Source file changed while checkpointing: ${path}`);
		}
		await writeBlob(blobDirectory, state.blobHash, content);
	}
}

/** 收集一组 manifest 中所有引用的 blob hash（用于判断哪些 blob 仍需保留）。 */
export function referencedBlobHashes(manifests: SourceManifest[]): Set<string> {
	const hashes = new Set<string>();
	for (const manifest of manifests) {
		for (const state of Object.values(manifest)) {
			if (state.exists && state.blobHash) hashes.add(state.blobHash);
		}
	}
	return hashes;
}

/** 删除 blob 目录中不再被任何保留 manifest 引用的孤儿 blob，返回删除数量。 */
export async function pruneOrphanedBlobs(blobDirectory: string, needed: Set<string>): Promise<number> {
	let names: string[];
	try {
		names = await readdir(blobDirectory);
	} catch (error) {
		if (isMissingFileError(error)) return 0;
		throw error;
	}
	let deleted = 0;
	for (const name of names) {
		if (name.endsWith(".tmp")) continue; // 跳过 atomicWrite 的临时文件
		if (needed.has(name)) continue;
		await rm(join(blobDirectory, name), { force: true });
		deleted++;
	}
	return deleted;
}

export interface TreeRef {
	id: string;
	parentId: string | null;
}

/**
 * 在按追加顺序排列的 entries 中，找到第一个以 targetId 为祖先的条目。
 *
 * 用于把会话中的检查点(通常挂在某轮 assistant 消息之下)对回到它所属的那一轮对话：
 * 检查点 cpN 是 userN 的后代，因此从 userN 向下找第一个检查点即可得到 cpN，
 * 而不是祖先路径上的 cp(N-1)。
 */
export function findFirstDescendant<T extends TreeRef>(
	entries: readonly T[],
	targetId: string,
	isTarget: (entry: T) => boolean,
	prunedIds?: ReadonlySet<string>,
): T | undefined {
	const parents = new Map<string, string | null>();
	for (const entry of entries) parents.set(entry.id, entry.parentId);
	for (const entry of entries) {
		if (prunedIds?.has(entry.id)) continue;
		if (!isTarget(entry)) continue;
		let cursor = entry.parentId;
		while (cursor) {
			if (cursor === targetId) return entry;
			cursor = parents.get(cursor) ?? null;
		}
	}
	return undefined;
}

/**
 * 为某个对话点找到最合适的检查点：
 *  1. 优先返回该对话点的后代检查点（after-agent 检查点挂在 assistant 回复之下，
 *     对应当前这一轮的代码状态，避免与上一轮错位）。
 *  2. 若没有（例如该轮未改代码、或仅有 session-start 检查点），回退到祖先路径上
 *     最近的一个检查点（session-start 或更早一轮）。
 *
 * sessions 中检查点有两种摆放：session-start 在第一个用户消息之前（是对话点的祖先），
 * after-agent 在 assistant 回复之后（是对话点的后代），因此必须同时处理两个方向。
 */
export function findBestCheckpoint<T extends TreeRef>(
	entries: readonly T[],
	targetId: string,
	isTarget: (entry: T) => boolean,
	prunedIds?: ReadonlySet<string>,
): T | undefined {
	const descendant = findFirstDescendant(entries, targetId, isTarget, prunedIds);
	if (descendant) return descendant;

	const byId = new Map<string, T>();
	for (const entry of entries) byId.set(entry.id, entry);
	let cursor: string | null = targetId;
	while (cursor) {
		const entry = byId.get(cursor);
		if (entry && isTarget(entry) && !prunedIds?.has(entry.id)) return entry;
		cursor = entry?.parentId ?? null;
	}
	return undefined;
}

export function manifestsEqual(left: SourceManifest, right: SourceManifest): boolean {
	const leftPaths = Object.keys(left).sort();
	const rightPaths = Object.keys(right).sort();
	if (leftPaths.length !== rightPaths.length) return false;
	return leftPaths.every((path, index) => {
		if (path !== rightPaths[index]) return false;
		const a = left[path];
		const b = right[path];
		return a.exists === b.exists && a.blobHash === b.blobHash && a.mode === b.mode;
	});
}

export function diffManifests(current: SourceManifest, target: SourceManifest): RestoreDiff {
	const diff: RestoreDiff = { created: [], modified: [], deleted: [] };
	const paths = new Set([...Object.keys(current), ...Object.keys(target)]);
	for (const path of [...paths].sort()) {
		const before = current[path];
		const after = target[path];
		if (!before && after?.exists) {
			diff.created.push(path);
			continue;
		}
		if (before?.exists && !after) {
			diff.deleted.push(path);
			continue;
		}
		if (before && after && (before.blobHash !== after.blobHash || before.mode !== after.mode)) {
			diff.modified.push(path);
		}
	}
	return diff;
}

export function changedFileCount(diff: RestoreDiff): number {
	return diff.created.length + diff.modified.length + diff.deleted.length;
}

export function formatDiffSummary(diff: RestoreDiff, limit = 12): string {
	const lines: string[] = [];
	for (const path of diff.created) lines.push(`+ ${path}`);
	for (const path of diff.modified) lines.push(`~ ${path}`);
	for (const path of diff.deleted) lines.push(`- ${path}`);
	const visible = lines.slice(0, limit);
	if (lines.length > visible.length) visible.push(`... ${lines.length - visible.length} more file(s)`);
	return visible.join("\n");
}

export async function restoreManifest(
	root: string,
	blobDirectory: string,
	current: SourceManifest,
	target: SourceManifest,
	config: ResolvedCodeRewindConfig,
): Promise<RestoreDiff> {
	const diff = diffManifests(current, target);
	if (changedFileCount(diff) === 0) return diff;

	const applied: string[] = [];
	try {
		for (const path of [...diff.deleted, ...diff.modified, ...diff.created]) {
			const state = target[path];
			if (!isEligibleSourcePath(path, config)) throw new Error(`Refusing to restore ineligible path: ${path}`);
			if (!state?.exists) {
				await rm(resolveProjectPath(root, path), { force: true });
			} else {
				await restoreFile(root, blobDirectory, path, state);
			}
			applied.push(path);
		}
		return diff;
	} catch (error) {
		for (const path of applied.reverse()) {
			try {
				const state = current[path];
				if (!state?.exists) await rm(resolveProjectPath(root, path), { force: true });
				else await restoreFile(root, blobDirectory, path, state);
			} catch {
				// Preserve the original restore error; the caller gets the affected path from it.
			}
		}
		throw error;
	}
}

export function isCodeCheckpoint(value: unknown): value is CodeCheckpoint {
	if (!value || typeof value !== "object") return false;
	const checkpoint = value as Partial<CodeCheckpoint>;
	return checkpoint.version === CHECKPOINT_VERSION
		&& (checkpoint.phase === "session-start" || checkpoint.phase === "after-agent")
		&& typeof checkpoint.timestamp === "number"
		&& checkpoint.files !== undefined;
}

async function findGitIgnoredPaths(root: string, paths: string[]): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	return new Promise((resolveIgnored) => {
		const child = spawn("git", ["check-ignore", "--stdin", "-z", "--no-index"], {
			cwd: root,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => resolveIgnored(new Set()));
		child.on("close", (code) => {
			if (code !== 0) {
				resolveIgnored(new Set());
				return;
			}
			const output = Buffer.concat(chunks).toString("utf8");
			resolveIgnored(new Set(output.split("\0").filter(Boolean).map(normalizeRelativePath)));
		});
		child.stdin.end(`${paths.join("\0")}\0`);
	});
}

export function resolveProjectPath(root: string, path: string): string {
	const rootPath = resolve(root);
	const resolvedPath = resolve(rootPath, path);
	if (resolvedPath !== rootPath && !resolvedPath.startsWith(`${rootPath}${sep}`)) {
		throw new Error(`Path escapes project root: ${path}`);
	}
	return resolvedPath;
}

function shouldVisitDirectory(path: string, config: ResolvedCodeRewindConfig): boolean {
	const parts = path.split("/");
	if (parts.some((part) => DEFAULT_EXCLUDED_DIRECTORIES.has(part))) return false;
	return !matchesAnyPath(path, config.exclude);
}

function isEligibleSourcePath(path: string, config: ResolvedCodeRewindConfig): boolean {
	const normalized = normalizeRelativePath(path);
	if (!normalized || matchesAnyPath(normalized, config.exclude)) return false;
	if (config.include.length > 0 && !matchesAnyPath(normalized, config.include)) return false;
	return config.extensions.has(extname(normalized).toLowerCase());
}

function matchesAnyPath(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => path === pattern || path.startsWith(`${pattern}/`));
}

function toProjectPath(root: string, fullPath: string): string {
	return normalizeRelativePath(relative(root, fullPath));
}

function normalizeRelativePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function hashContent(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function writeBlob(blobDirectory: string, hash: string, content: Buffer): Promise<void> {
	const path = join(blobDirectory, hash);
	try {
		const existing = await readFile(path);
		if (hashContent(existing) === hash) return;
		throw new Error(`Blob hash collision or corruption: ${hash}`);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	await atomicWrite(path, content);
}

async function restoreFile(root: string, blobDirectory: string, path: string, state: SourceFileState): Promise<void> {
	if (!state.blobHash) throw new Error(`Missing blob hash for ${path}`);
	const content = await readFile(join(blobDirectory, state.blobHash));
	if (hashContent(content) !== state.blobHash) throw new Error(`Checkpoint blob is corrupt: ${path}`);
	const targetPath = resolveProjectPath(root, path);
	await mkdir(dirname(targetPath), { recursive: true });
	await atomicWrite(targetPath, content);
	if (state.mode !== undefined) await chmod(targetPath, state.mode);
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
	const temporaryPath = `${path}.code-rewind-${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, content, { mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
