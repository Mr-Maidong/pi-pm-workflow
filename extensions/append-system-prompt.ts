import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const appendSystemPath = fileURLToPath(new URL("../SYSPROMPT.md", import.meta.url));

function loadAppendSystemPrompt(): string {
	try {
		return readFileSync(appendSystemPath, "utf-8").trim();
	} catch (error) {
		console.error(`[append-system-prompt] Failed to read ${appendSystemPath}:`, error);
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const appendSystemPrompt = loadAppendSystemPrompt();
	if (!appendSystemPrompt) return;

	pi.on("before_agent_start", async (event) => {
		// Avoid duplicating the package prompt if another loader already appended it.
		if (event.systemPrompt.includes(appendSystemPrompt)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${appendSystemPrompt}`,
		};
	});
}
