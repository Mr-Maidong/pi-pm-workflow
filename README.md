# pm-workflow

Pi Package: 产品经理(PM)工作流一体化包。包含三个扩展工具、一个自定义状态栏扩展，以及 PM 原型开发流程和通用系统附加提示词。

## 包含内容

### 扩展(extensions/)

| 扩展 | 注册内容 | 用途 |
|------|---------|------|
| `question.ts` | 工具 `question` | 单个问题 + 编号选项(1. A 2. B 3. C ... N. Type something.),用户键盘选择或自由输入 |
| `questionnaire.ts` | 工具 `questionnaire` | 一次多个问题,顶部 tab 切换,全部答完统一提交 |
| `context-statusline.ts` | `/statusline` 命令 + 自定义 footer | 状态栏右侧显示模型名 + 上下文占用进度条 + 百分比,左侧显示工作目录 + git 分支;启动自动启用,`/statusline` 切换 |

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

## 维护约定(多 agent 共用环境)

- **权威版本 = 全局** `~/.agents/skills/pm-prototype`(Claude Code 等 agent 共用)
- `SYSPROMPT.md` 是本包的系统附加提示词源文件，由 `extensions/append-system-prompt.ts` 在每次 agent run 开始前注入
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

- question/questionnaire 源码源自 pi 官方示例(`examples/extensions/`),context-statusline 为用户自建扩展,均未改动逻辑,仅打包分发。
- 工具名 `question` / `questionnaire` 若与未来内置工具冲突,可通过包过滤或改名区分。
