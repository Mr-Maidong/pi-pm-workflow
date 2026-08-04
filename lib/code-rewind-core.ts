import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export const CHECKPOINT_TYPE = "code-rewind-checkpoint";
export const CHECKPOINT_VERSION = 1;

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
}

export interface ResolvedCodeRewindConfig {
	include: string[];
	exclude: string[];
	extensions: Set<string>;
	maxFileSize: number;
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
