# pm-workflow

Pi Package: 产品经理(PM)工作流一体化包。包含三个扩展工具、状态栏、失败重试扩展，以及 PM 原型开发流程和通用系统附加提示词。

## 包含内容

### 扩展(extensions/)

| 扩展 | 注册内容 | 用途 |
|------|---------|------|
| `question.ts` | 工具 `question` | 单个问题 + 编号选项(1. A 2. B 3. C ... N. Type something.),用户键盘选择或自由输入 |
| `questionnaire.ts` | 工具 `questionnaire` | 一次多个问题,顶部 tab 切换,全部答完统一提交 |
| `context-statusline.ts` | `/statusline` 命令 + 自定义 footer | 状态栏右侧显示模型名 + 上下文占用进度条 + 百分比,左侧显示工作目录 + git 分支;启动自动启用,`/statusline` 切换 |
| `retry-last-request.ts` | `Ctrl+Y` 快捷键 | 模型请求失败且 Pi 空闲时,重新发送最近一次失败请求的用户消息;覆盖 Pi 默认的 `Ctrl+Y` yank 行为 |
| `code-rewind.ts` | `/rewind` + 双击 `Esc` | 为源码文件保存线性检查点;agent 回合结束即更新;双击 Esc 或 `/rewind` 打开回退面板;可同步回退对话,恢复后丢弃其后的检查点 |

### 技能(skills/)

| 技能 | 用途 |
|------|------|
| `pm-prototype` | 需求澄清(优先使用 question/questionnaire 工具提问)→ 脚手架 → 原型开发 → 验证交付的完整 PM 原型流程 |

## 安装

### 方式一:GitHub git 源(推荐,团队分发)

```bash
# 固定版本(推荐)
pi install git:github.com/Mr-Maidong/pi-pm-workflow@v1.0.0
# 跟随 main 最新
pi install git:github.com/Mr-Maidong/pi-pm-workflow
```

### 方式二:本地路径(开发模式)

```bash
pi install D:/Workbase/pi-packages/pi-pm-workflow        # 全局
pi install -l D:/Workbase/pi-packages/pi-pm-workflow     # 项目级
```

### 临时试用(仅当前运行)

```bash
pi -e git:github.com/Mr-Maidong/pi-pm-workflow
```

## 技能冲突说明(多 agent 共用场景)

`~/.agents/skills/` 是 Agent Skills 标准目录,**Claude Code / Codex 等多个 agent 共用**,请勿删除其中的 `pm-prototype`。若目标机器已有全局同名技能,在 settings.json 中对本包做技能过滤,避免 Pi 侧同名冲突:

```json
{
  "packages": [
    {
      "source": "git:github.com/Mr-Maidong/pi-pm-workflow@v1.0.0",
      "skills": ["!skills/pm-prototype"]
    }
  ]
}
```

- 效果:Pi 与所有 agent 统一使用全局技能,包内技能被显式排除,无冲突警告
- 全新环境(无全局技能):去掉 `"skills"` 过滤行即可使用包内技能(包自包含)

## 使用

### 1. 选项式提问(question / questionnaire)

LLM 在需求澄清/决策确认时调用工具,用户在 TUI 中看到:

```
────────────────────────────────────────────────
  原型输出目录放哪里?
  > 1. 当前目录下新建
    2. 单独目录
    3. Type something.
  ↑↓ navigate • Enter to select • Esc to cancel
────────────────────────────────────────────────
```

- `↑`/`↓` 选择,`Enter` 确认
- 选中 `Type something.` 进入输入模式,`Enter` 提交、`Esc` 返回选项
- `Esc` 取消提问(返回 cancelled)
- 非交互模式(如 `pi -p`)返回 `UI not available` 错误,不会卡死

调用示例:

```
question { question: "筛选条布局?", options: [{ label: "单行", description: "最简约" }, { label: "两行" }] }

questionnaire { questions: [{ id: "scope", label: "范围", prompt: "原型范围?", options: [...] }, ...] }
```

### 2. 上下文状态栏(context-statusline)

启动后自动生效,footer 右侧显示:

```
main ● 1.2k ↓300 $0.012       DeepSeek V4 Flash  ██████░░░░ 58% (116k/200k)
```

- 进度条颜色:绿(<60%)→ 黄(60-84%)→ 红(≥85%)
- `/statusline` 命令切换启用/停用

### 3. 失败请求重试(retry-last-request)

当模型请求失败且 Pi 回到空闲状态时,TUI 会提示 `Press Ctrl+Y to retry.`。按 `Ctrl+Y` 后会显示 `Retrying the last failed request`,并以隐藏的 custom message 重发原始请求,因此不会在 transcript 中再次打印用户问题:

- 自动复用失败请求对应的最近一条用户消息,但不会在 TUI 中重复显示该消息
- 请求仍在执行时不会追加新请求
- 最近一条模型消息不是 `stopReason: "error"` 时不会重试
- 没有可重试请求时显示提示
- 该扩展覆盖 Pi 默认的 `Ctrl+Y` yank 快捷键

### 4. 源码回退(code-rewind)

扩展在 session 启动时和每个 agent 回合完成后扫描受支持的源码文件。它不依赖 Git,不会修改 Git history、index 或分支;内容 blob 保存在 Pi session 目录的 `code-rewind/<session-id>/blobs` 下,因此复制或导出 session 时需要一并保留该目录。

- 编辑器为空且 Pi 空闲时,**双击 `Esc`** 直接打开 code rewind 面板(会拦截第二次 Esc,不再触发 Pi 默认的 `/tree`)。双击 Esc 路径仅回退源码。
- `/rewind` 打开同一面板:按序号选择线性 checkpoint;可选 **Conversation + code**（源码 + 对话树一起回退）或 **Code only**（仅源码）。
- 若当前有 5 个序号,恢复到序号 2 后会丢弃 3–5,之后不能再回到被丢弃的检查点(线性回退,不可前进)。
- 每个 agent 回合结束后,若源码相对最近检查点有变化,立即写入新 checkpoint(不依赖 `/reload`)。
- 对话回退通过 Pi 的 `navigateTree` 把 leaf 移到检查点 entry,不生成 branch summary;历史仍保留在 session 树中,只是当前分支回到该点。
- 非交互模式不执行代码恢复。
- 每个新 checkpoint 落库后自动清理:默认只保留最近 **30** 个检查点,更旧的检查点会被标记为不可回退,其不再被引用的 blob 快照会被删除,避免长会话下磁盘无限增长。

默认只处理 `.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`、`.py`、`.go`、`.rs`、`.java`、`.kt`、`.cs`、`.vue`、`.svelte`、`.astro`、`.css`、`.scss`、`.less`、`.html`、`.sql`、`.sh`,并排除 `.git`、`node_modules`、`.venv`、`dist`、`build`、`coverage`、Git ignore 文件(`.gitignore`、`.git/info/exclude`) 与常见缓存目录。单文件默认上限为 1 MiB。

在项目根目录创建可选的 `code-rewind.json` 调整规则;`include` 和 `exclude` 使用项目相对目录前缀:

```json
{
  "include": ["src", "packages/app"],
  "exclude": ["src/generated"],
  "extensions": [".ts", ".tsx", ".vue"],
  "maxFileSize": 1048576,
  "retention": 30
}
```

## 维护约定(多 agent 共用环境)

- **权威版本 = 全局** `~/.agents/skills/pm-prototype`(Claude Code 等 agent 共用)
- `SYSPROMPT.md` 是本包的系统附加提示词源文件，由 `extensions/append-system-prompt.ts` 在每次 agent run 开始前注入
- `retry-last-request.ts` 使用 `before_agent_start` 之外的快捷键 API,仅在用户手动按键时触发重试，不会自动循环重试
- 修改 `pm-prototype` 技能流程:改全局 → 同步到包内:

```bash
cp -r ~/.agents/skills/pm-prototype/* D:/Workbase/pi-packages/pi-pm-workflow/skills/pm-prototype/
```

- 修改扩展:直接改包内 `extensions/*.ts`(Pi 侧唯一来源,无共享副本)

## 开发迭代(发布新版本)

```bash
cd D:/Workbase/pi-packages/pi-pm-workflow
git add -A && git commit -m "feat: ..."
git push origin main
pi update --all                # 本地更新到最新
# 发布新 tag(可选,固定版本用户需同步升级)
git tag v1.1.0 && git push origin v1.1.0
```

## 说明

- question/questionnaire 源码源自 pi 官方示例(`examples/extensions/`),context-statusline 和 retry-last-request 为用户自建扩展。
- `append-system-prompt.ts` 读取包内 `SYSPROMPT.md`,通过 `before_agent_start` 追加到当前 system prompt。
- 工具名 `question` / `questionnaire` 若与未来内置工具冲突,可通过包过滤或改名区分。
