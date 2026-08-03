import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+y", {
		description: "Retry the last failed model request",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current request to finish", "warning");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const lastMessageIndex = branch.findLastIndex((entry) => entry.type === "message");
			if (lastMessageIndex < 0) {
				ctx.ui.notify("No failed model request to retry", "warning");
				return;
			}

			const lastEntry = branch[lastMessageIndex];
			if (
				lastEntry.type !== "message" ||
				lastEntry.message.role !== "assistant" ||
				lastEntry.message.stopReason !== "error"
			) {
				ctx.ui.notify("The last model request did not fail", "info");
				return;
			}

			for (let index = lastMessageIndex - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type !== "message") continue;
				if (entry.message.role !== "user") continue;

				pi.sendUserMessage(entry.message.content);
				ctx.ui.notify("Retrying the last failed request", "info");
				return;
			}

			ctx.ui.notify("Could not find the failed request's user message", "warning");
		},
	});
}
