import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diffManifests,
	findBestCheckpoint,
	findFirstDescendant,
	pruneOrphanedBlobs,
	referencedBlobHashes,
	resolveConfig,
	resolveProjectPath,
	restoreManifest,
	saveManifestBlobs,
	scanSourceFiles,
} from "../lib/code-rewind-core.js";

const run = promisify(execFile);

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "code-rewind-test-"));
	const blobs = join(root, ".blobs");
	const config = resolveConfig();

	try {
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "src", "kept.ts"), "export const value = 1;\n");
		await writeFile(join(root, "src", "deleted.py"), "print('before')\n");
		await writeFile(join(root, "node_modules", "pkg", "ignored.ts"), "ignored\n");
		await writeFile(join(root, "dist", "ignored.ts"), "ignored\n");
		await writeFile(join(root, "asset.png"), "not source\n");
		await writeFile(join(root, "src", "large.ts"), "x".repeat(64));
		await writeFile(join(root, ".gitignore"), "src/ignored.ts\n");
		await writeFile(join(root, "src", "ignored.ts"), "ignored by gitignore\n");
		await run("git", ["init", "--quiet"], { cwd: root });

		const initial = await scanSourceFiles(root, config);
		assert.deepEqual(Object.keys(initial).sort(), ["src/deleted.py", "src/kept.ts", "src/large.ts"]);
		assert.deepEqual(Object.keys(await scanSourceFiles(root, resolveConfig({ maxFileSize: 32 }))).sort(), ["src/deleted.py", "src/kept.ts"]);
		assert.throws(() => resolveProjectPath(root, "../outside.ts"));
		await saveManifestBlobs(root, blobs, initial);

		await writeFile(join(root, "src", "kept.ts"), "export const value = 2;\n");
		await rm(join(root, "src", "deleted.py"));
		await writeFile(join(root, "src", "new.ts"), "export const created = true;\n");
		const changed = await scanSourceFiles(root, config);
		await saveManifestBlobs(root, blobs, changed);

		const diff = diffManifests(changed, initial);
		assert.deepEqual(diff.created, ["src/deleted.py"]);
		assert.deepEqual(diff.deleted, ["src/new.ts"]);
		assert.deepEqual(diff.modified, ["src/kept.ts"]);

		await restoreManifest(root, blobs, changed, initial, config);
		assert.equal(await readFile(join(root, "src", "kept.ts"), "utf8"), "export const value = 1;\n");
		assert.equal(await readFile(join(root, "src", "deleted.py"), "utf8"), "print('before')\n");
		await assert.rejects(readFile(join(root, "src", "new.ts"), "utf8"));
		assert.equal(await readFile(join(root, "node_modules", "pkg", "ignored.ts"), "utf8"), "ignored\n");
		assert.equal(await readFile(join(root, "dist", "ignored.ts"), "utf8"), "ignored\n");

		// retention 配置：默认 30，非法值收敛到至少 1
		assert.equal(resolveConfig().retention, 30);
		assert.equal(resolveConfig({ retention: 5 }).retention, 5);
		assert.equal(resolveConfig({ retention: -3 }).retention, 1);

		// referencedBlobHashes：只收集存在且有 hash 的文件
		const refs = referencedBlobHashes([
			{ "a.ts": { exists: true, blobHash: "aaa" }, "gone.ts": { exists: false } },
		]);
		assert.deepEqual([...refs].sort(), ["aaa"]);

		// pruneOrphanedBlobs：删除不在 needed 集合中的 blob
		const blobsDir = join(root, "prune-blobs");
		await mkdir(blobsDir, { recursive: true });
		for (const [name, content] of [["aaa", "1"], ["bbb", "2"], ["ccc.tmp", "3"]] as const) {
			await writeFile(join(blobsDir, name), content);
		}
		const deleted = await pruneOrphanedBlobs(blobsDir, new Set(["bbb"]));
		assert.equal(deleted, 1); // ccc.tmp 被跳过，aaa 被删，bbb 保留
		const remaining = await readdir(blobsDir);
		assert.deepEqual(remaining.sort(), ["bbb", "ccc.tmp"]);

		// findFirstDescendant：检查点 cpN 挂在 userN 的 assistant 回复之下，
		// 以 userN 为锚应找到 cpN（而非祖先路径上的 cp(N-1)）。
		const mk = (id: string, parent: string | null) => ({ id, parentId: parent, type: "message", customType: undefined, data: undefined });
		const cp = (id: string, parent: string) => ({ id, parentId: parent, type: "custom", customType: "cp", data: {} });
		const isCp = (e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "cp";

		// 有 after-agent 检查点的线性会话：userN 应对齐 cpN（后代优先）
		const tree = [
			cp("cs", "head"),
			mk("user1", "cs"),
			mk("asst1", "user1"),
			cp("cp1", "asst1"),
			mk("user2", "cp1"),
			mk("asst2", "user2"),
			cp("cp2", "asst2"),
		];
		assert.equal(findFirstDescendant(tree, "user1", isCp)?.id, "cp1");
		assert.equal(findFirstDescendant(tree, "user2", isCp)?.id, "cp2"); // 不再提前一轮

		// findBestCheckpoint：后代优先，找不到再回退祖先（session-start）
		assert.equal(findBestCheckpoint(tree, "user1", isCp)?.id, "cp1");
		assert.equal(findBestCheckpoint(tree, "user2", isCp)?.id, "cp2");
		assert.equal(findBestCheckpoint(tree, "asst2", isCp)?.id, "cp2");
		assert.equal(findBestCheckpoint(tree, "user2", isCp, new Set(["cp2"]))?.id, "cp1"); // 后代已清理→回退到 cp1

		// 仅有 session-start 检查点（无 after-agent）：回退到 cs，仍可恢复源码
		const onlyStart = [
			cp("cs", "head"),
			mk("user1", "cs"),
			mk("asst1", "user1"),
			mk("user2", "asst1"),
			mk("asst2", "user2"),
		];
		assert.equal(findBestCheckpoint(onlyStart, "user1", isCp)?.id, "cs");
		assert.equal(findBestCheckpoint(onlyStart, "user2", isCp)?.id, "cs");

		// 混合：cp1 存在、cp2 缺失（该轮未改代码）→ user3 回退到 cp1
		const mixed = [
			cp("cs", "head"),
			mk("user1", "cs"),
			mk("asst1", "user1"),
			cp("cp1", "asst1"),
			mk("user2", "cp1"),
			mk("asst2", "user2"),
			mk("user3", "asst2"),
			mk("asst3", "user3"),
		];
		assert.equal(findBestCheckpoint(mixed, "user1", isCp)?.id, "cp1");
		assert.equal(findBestCheckpoint(mixed, "user3", isCp)?.id, "cp1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().then(() => console.log("code-rewind core tests passed"));
