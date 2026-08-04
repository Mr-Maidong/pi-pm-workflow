import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diffManifests,
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().then(() => console.log("code-rewind core tests passed"));
