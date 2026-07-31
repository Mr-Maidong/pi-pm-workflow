# pm-workflow

Pi Package:产品经理(PM)工作流一体化包。包含三个扩展工具、一个自定义状态栏扩展,以及 pm-prototype 原型开发技能。

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

```bash
pi install /absolute/path/to/pm-workflow      # 全局
# 或项目级
pi install -l /absolute/path/to/pm-workflow
```

临时试用(仅当前运行):

```bash
pi -e /absolute/path/to/pm-workflow
```

> **提示**:若全局 `~/.agents/skills/pm-prototype` 已存在同名技能,可与包内技能并存;只需保留其一,建议移除全局副本以免技能列表重复。

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

## 说明

- question/questionnaire 源码源自 pi 官方示例(`examples/extensions/`),context-statusline 为用户自建扩展,均未改动逻辑,仅打包分发。
- 工具名 `question` / `questionnaire` 若与未来内置工具冲突,可通过包过滤或改名区分。
