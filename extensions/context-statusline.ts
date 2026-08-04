/**
 * Context Statusline Extension
 *
 * 在状态栏（footer）最右侧显示：
 *   模型名称 + 当前 session 上下文占用进度条 + 百分比
 *
 * 例如：  main  ● 1.2k ↓300 $0.012        Claude Sonnet 4.5  ██████░░░░ 58% (116k/200k)
 *
 * 左侧显示：当前目录末级名称 + Git 分支（首字母大写、accent 色）+ 未提交行数 + 其它扩展 setStatus() 状态。
 *
 * 数据来源：
 *   - ctx.model.name / ctx.model.id          模型名称
 *   - ctx.getContextUsage()                  { tokens, contextWindow, percent }
 *
 * 使用：
 *   - 启动时自动启用
 *   - /statusline 命令可切换 启用/停用（停用后恢复内置 footer）
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThemeColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const BAR_WIDTH = 10;
const STATUS_KEY = "context-statusline";

/**
 * 进度条语义色(真彩 ANSI,不依赖主题):
 * dark 主题的 success 映射为 #b5bd68(黄绿),视觉上接近黄色,故此处直接使用标准绿/橙/红。
 */
const BAR_PALETTE: Record<"success" | "warning" | "error", string> = {
	success: "\x1b[38;2;86;200;90m", // 纯绿 #56c85a
	warning: "\x1b[38;2;255;170;40m", // 橙黄 #ffaa28
	error: "\x1b[38;2;244;67;54m", // 红 #f44336
};
const RESET_FG = "\x1b[39m";

function formatGitChangeSummary(numstat: string): string {
	let additions = 0;
	let deletions = 0;
	for (const line of numstat.split("\n")) {
		const [added, deleted] = line.split("\t");
		const addedLines = Number.parseInt(added, 10);
		const deletedLines = Number.parseInt(deleted, 10);
		if (Number.isFinite(addedLines)) additions += addedLines;
		if (Number.isFinite(deletedLines)) deletions += deletedLines;
	}
	return additions || deletions ? `+${additions}/-${deletions}` : "";
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	// 保存当前 session 的 ctx 与渲染触发器，供事件回调强制刷新 footer。
	let activeCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let gitChangeSummary = "";
	let gitChangeRefreshInFlight = false;

	/** 数字格式化：< 1000 原样，否则用 k 表示 */
	const fmt = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	/** 根据百分比选择进度条颜色：绿 -> 黄 -> 红 */
	const barColor = (p: number): ThemeColor => {
		if (p >= 85) return "error";
		if (p >= 60) return "warning";
		return "success";
	};

	/** 生成进度条字符串，如 ██████░░░░ */
	const makeBar = (percent: number): string => {
		const clamped = Math.max(0, Math.min(100, percent));
		const filled = Math.round((clamped / 100) * BAR_WIDTH);
		return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
	};

	const refreshGitChangeSummary = async (ctx: ExtensionContext): Promise<void> => {
		if (gitChangeRefreshInFlight) return;
		gitChangeRefreshInFlight = true;
		try {
			const result = await pi.exec("git", ["diff", "--numstat", "HEAD"], { cwd: ctx.cwd, timeout: 2_000 });
			const nextSummary = result.code === 0 ? formatGitChangeSummary(result.stdout) : "";
			if (nextSummary !== gitChangeSummary) {
				gitChangeSummary = nextSummary;
				requestRender?.();
			}
		} catch {
			if (gitChangeSummary) {
				gitChangeSummary = "";
				requestRender?.();
			}
		} finally {
			gitChangeRefreshInFlight = false;
		}
	};

	/** 安装自定义 footer */
	const installFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData.onBranchChange(() => {
				void refreshGitChangeSummary(ctx);
				tui.requestRender();
			});
			const gitChangeTimer = setInterval(() => void refreshGitChangeSummary(ctx), 3_000);

			return {
				invalidate() {},
				dispose: () => {
					clearInterval(gitChangeTimer);
					unsubBranch();
				},

				render(width: number): string[] {
					// ---- 左侧：当前工作目录 + git 分支 + 其它扩展状态 ----
					const leftParts: string[] = [];

					// 仅显示当前工作目录最后一级，并将首字母大写。
					const cwd = ctx.sessionManager.getCwd();
					const directoryName = basename(cwd) || cwd;
					const cwdDisplay = directoryName.charAt(0).toUpperCase() + directoryName.slice(1);
					leftParts.push(theme.fg("muted", cwdDisplay));

					for (const text of footerData.getExtensionStatuses().values()) {
						if (text) leftParts.push(text);
					}
					const branch = footerData.getGitBranch();
					if (branch) {
						// 首字母大写，并用 accent 色显示；未提交行数按新增/删除显示。
						const capitalized = branch.charAt(0).toUpperCase() + branch.slice(1);
						const changes = gitChangeSummary
							? ` ${theme.fg("success", gitChangeSummary.split("/")[0])}${theme.fg("dim", "/")}${theme.fg("error", gitChangeSummary.split("/")[1])}`
							: "";
						leftParts.push(`${theme.fg("accent", capitalized)}${changes}`);
					}
					const left = leftParts.join(theme.fg("dim", " │ "));

					// ---- 右侧：模型名 + 上下文进度条 + 百分比 ----
					const model = ctx.model;
					const modelName = model?.name || model?.id || "no-model";
					const usage = ctx.getContextUsage();

					let right: string;
					if (usage && usage.percent != null) {
						const pct = Math.round(usage.percent);
						const color = barColor(pct);
						const ansi = BAR_PALETTE[color as "success" | "warning" | "error"];
						const bar = ansi + makeBar(pct) + RESET_FG;
						const pctText = ansi + theme.bold(`${pct}%`) + RESET_FG;
						const tokens =
							usage.tokens != null
								? theme.fg("dim", ` (${fmt(usage.tokens)}/${fmt(usage.contextWindow)})`)
								: "";
						right = `${theme.fg("accent", modelName)}  ${bar} ${pctText}${tokens}`;
					} else {
						right = `${theme.fg("accent", modelName)}  ${theme.fg("dim", "---------- --%")}`;
					}

					// ---- 左右对齐拼接 ----
					const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
					const line = left + " ".repeat(gap) + right;
					return [truncateToWidth(line, width)];
				},
			};
		});
	};

	const refresh = () => requestRender?.();

	// 启动时自动启用
	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		await refreshGitChangeSummary(ctx);
		if (enabled) installFooter(ctx);
	});

	// 这些事件会改变模型或上下文占用，触发 footer 重新渲染
	pi.on("model_select", async (_event, ctx) => {
		activeCtx = ctx;
		refresh();
	});
	pi.on("turn_end", async (_event, ctx) => {
		refresh();
		void refreshGitChangeSummary(ctx);
	});
	pi.on("message_end", async () => refresh());
	pi.on("session_compact", async () => refresh());

	// 切换命令
	pi.registerCommand("statusline", {
		description: "切换自定义状态栏（模型名 + 上下文进度条）",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			activeCtx = ctx;
			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("自定义状态栏已启用", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("已恢复内置状态栏", "info");
			}
		},
	});
}
