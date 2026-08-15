---
name: release-yunxiao
description: 云效需求工作项操作。发布产品类需求到阿里云云效（发布云效、发到云效、to-prd、写PRD发布），查询/核对既有需求（MSIS-xxx、查需求、核对需求是否有同步记录），更新需求描述同步功能完成记录（同步到需求、记录到需求、补充需求记录）。写操作必须先过确认门。
---

# 云效需求工作项操作

覆盖三类任务：

- **发布**：创建产品类需求（PRD）
- **查询/核对**：按编号（serialNumber，如 MSIS-2469）定位既有需求，读取描述/评论/动态，与代码提交核对同步情况
- **更新**：将「功能完成记录」按功能项追加到既有需求描述（确认门后执行）

## 适用范围

- 只操作云效"产品类需求"工作项；普通任务、缺陷、设计讨论和本地 issue 不使用本技能。
- 发布正文必须符合 [`references/prd-template.md`](references/prd-template.md) 的五段模板；创建时将已确认的 PRD 转换为 HTML 富文本，并以 `RICHTEXT` 格式传入云效。
- 若项目根目录存在 `CONTEXT.md` 等领域文档，使用其中的产品术语。产品名称与项目编码是不同字段：标题使用用户确认的产品名称，项目编码仅用于定位云效项目。

## 流程

### A. 发布产品类需求

#### A1. 锁定需求源

确认用户明确要求发布。优先复用用户指定的本地 PRD；否则从当前对话整理一份 PRD。

完成条件：已有一份包含"需求背景与目标、用户故事、功能描述、界面设计、权限设计"的 PRD 正文，且已生成对应的 HTML 富文本版本；两者均已明确入口、验收范围与不在范围内的内容。

#### A2. 补齐发布字段

从对话推断并向用户确认以下字段；每次只询问 1–2 个缺失或不确定字段：

- 项目编码
- 产品名称与工作项标题
- 负责人
- 优先级：紧急 / 高 / 中 / 低
- 迭代（可选）
- 截止时间（可选，`YYYY-MM-DD`）

不要把项目编码自动写入标题。标题默认格式为 `【产品名称】功能名称`，除非用户指定其他格式。

完成条件：所有必填字段已确认；可选字段明确为具体值或"不关联"。

#### A3. 通过确认门

创建前展示以下摘要，并等待用户明确回复"确认发布"或同义确认：

```md
## 云效发布确认

| 字段 | 值 |
| --- | --- |
| 标题 | {subject} |
| 项目编码 | {projectCode} |
| 工作项类型 | 产品类需求 |
| 负责人 | {assignee} |
| 优先级 | {priority} |
| 迭代 | {sprintName 或 不关联} |
| 截止时间 | {deadline 或 未设置} |

是否确认发布到云效？
```

用户修改任一字段后，更新摘要并重新通过确认门。

完成条件：用户对当前摘要作出明确确认。

#### A4. 解析云效资源

确认后，按 [`references/cli.md`](references/cli.md) 解析项目、负责人、产品类需求类型、优先级和迭代。

- 项目查询为空时，列出项目并按 `customCode` 精确匹配项目编码；不要按项目名称猜测。
- 负责人精确查询为空时，列出成员并按姓名精确匹配；无法唯一匹配时停止并要求用户指定。从返回结果中取 `userId` 字段（账号 ID），**不是** `id` 字段（组织成员 ID）；`--assigned-to` 使用 `id` 会报 `Invalid.UserAccountId` 错误。
- 每次发布都读取目标项目的字段配置，按 `priority` 的 `displayValue` 获取优先级 ID；不得复用其他项目的硬编码 ID。
- 用户填写迭代时必须精确匹配迭代名称；不存在或多条匹配时停止并说明。

完成条件：已得到唯一的 `projectId`、`userId`、产品类需求 `workitemTypeId`、`priorityId`，以及（如需要）唯一 `sprintId`。

#### A5. 创建并核验

使用 `spawnSync` 或等效的非 shell 参数调用创建工作项，将已确认 PRD 的 HTML 富文本以 `RICHTEXT` 格式传入，避免正文的换行与特殊字符被 shell 破坏。创建后立即读取工作项详情，逐项核验标题、类型、负责人、优先级、迭代、截止时间、富文本正文和状态。

创建失败时，报告原始错误与已完成步骤；不要猜测工作项是否已创建。核验不一致时，停止并向用户报告差异，不擅自覆盖。

完成条件：创建返回工作项 ID，且详情与确认摘要一致；状态为云效默认"待处理"。

#### A6. 回写结果

在本地 PRD 末尾记录云效工作项编号、类型、状态、负责人、优先级、迭代和截止时间，并向用户输出相同结果摘要。

完成条件：本地 PRD 已回写，用户收到工作项编号和核验后的状态。

### B. 查询与核对既有需求

#### B1. 锁定需求编号

确认用户给出的需求编号（如 `MSIS-2469`）。编号是 `serialNumber` 字段，**不是**工作项 `id`（32 位 hash），也常不在标题中。

#### B2. 定位项目

列出项目并按 `customCode` 精确匹配（响应可能是**顶层 JSON 数组**而非 `result.list` 包裹，解析前先 `Array.isArray` 判断，参考 cli.md）。项目不唯一时停止并报告。

#### B3. 定位工作项

优先用编号精确过滤：

```bash
aliyun devops projex-search-workitems \
  --space-id {projectId} --category Req \
  --conditions '{"conditionGroups":[[{"fieldIdentifier":"serialNumber","operator":"EQ","value":["MSIS-2469"],"toValue":null,"className":"string","format":"input"}]]}'
```

**实测：`--conditions` 过滤可能不生效**——serialNumber EQ 条件下曾返回项目全量工作项列表（含多编号多页），不能信任服务端已过滤。因此无论用哪种方式搜索，都必须**本地二次过滤**：按 `serialNumber === 编号` 精确匹配（必要时跨页遍历），并断言恰好一条。搜不到时退化顺序：`subject` CONTAINS 关键词 → 全页列表遍历按 `serialNumber` 精确匹配。结果必须唯一；多条时停止并要求用户澄清。

注意：搜索列表接口（projex-search-workitems）中的 `description` 常为空字符串，正文必须用 B4 的 `projex-get-workitem` 读取。

#### B4. 读取现有记录

- 详情：`projex-get-workitem --id {workitemId}`；未更新过描述时 `description` 是 **JSON 字符串**（含 `htmlValue` / `jsonMLValue`），先 `JSON.parse` 再取 `htmlValue`；描述被更新过则直接是原始 HTML（见 C5），解析前先判断字段是否以 `<` 开头；记录 `formatType`（注意：命令无 `--page`）
- 评论：`projex-list-workitem-comments --id {workitemId}`
- 动态：`projex-list-workitem-activities --id {workitemId}`；看 `description` 类更新的 `eventTime`，得到"最后记录时间"

完成条件：已拿到需求标题、状态、描述全文、最后记录时间。

#### B5. 核对与总结

- 用 `git log` 提交清单（按时间）对比需求描述/评论，找出最后记录时间之后未同步的内容。
- 输出「功能项总结」：按功能点分组（如 摄像头可视区 / 云台控制可靠性 / 全屏体验 / 首页统计 / 性能与工程），每组一句话描述 + 对应 commit 短哈希，**不逐提交罗列**。

完成条件：向用户展示"需求已同步项 vs 待同步项"的核对结果与功能项总结。

### C. 更新既有需求描述（同步功能完成记录）

#### C1. 读取当前描述

按 B4 读取完整 `htmlValue`，**全文保留**作为追加基础。

#### C2. 构造追加区块

- 新内容 = 原 `htmlValue` + 追加区块；追加区块用 `<article class="4ever-article">` 包裹的 `h2/h3/ul` 列表，标注同步时间与合并分支。
- 只追加，不覆盖、不修改原文；用户明确要求重写时除外。
- 替换/拼接时保留完整标签闭合（`<span>…</span>` 成对）；替换串必须显式包含被替换边界处的闭合标签，替换后断言 `</span>`、`</div>` 等闭合序列仍在，确保新 HTML 不含残缺标签后再进入确认门。

#### C3. 通过确认门

展示更新摘要（工作项、追加的分组内容、格式），等待用户明确确认。示例：

```md
## 云效描述更新确认

| 字段 | 值 |
| --- | --- |
| 工作项 | MSIS-2469【...】 |
| 更新内容 | 描述末尾追加「功能完成记录」，原清单不变 |
| 追加区块 | ① ... ② ... ③ ... |
| 格式 | RICHTEXT |

是否确认更新？
```

#### C4. 执行更新

```bash
aliyun devops projex-update-workitem --id {workitemId} --biz-body '<json>'
```

`--biz-body` 为 JSON 字符串：`{"description":"<HTML>","formatType":"RICHTEXT"}`。用 Node `spawnSync` 传参，避免 shell 转义破坏 HTML。

#### C5. 核验

重新 `projex-get-workitem`，确认新内容已出现、原内容保留。**实测形态变化**：描述更新后 `description` 字段由「JSON 字符串（含 htmlValue）」变为「原始 HTML 文本」，stdout 外层始终是 JSON；解析时字段以 `<` 开头则直接用，否则 `JSON.parse` 后取 `htmlValue`。核验发现新内容缺失、原内容丢失或标签残缺时，用修正后的 HTML 重新执行 C4 修复并再次核验，直至与预期一致；**不得把残缺 HTML 留在云效**。

## 环境与命令规范

- CLI 输出优先用 stdin 管道给 Node 解析（`aliyun ... | node -e ...`），不落盘。
- 必须落盘时使用系统临时目录（Node `os.tmpdir()`）或 `$TEMP`，**禁止在 git 工作目录创建临时文件**；文件用完立即删除，不得污染 `git status`。
- PAT 一律经环境变量传递，绝不写入命令参数、文件、日志或版本库。
- 记录 CLI 已知行为，避免重踩：
  - `projex-get-workitem` 更新描述后，`description` 字段直接返回原始 HTML（不再是含 `htmlValue` 的 JSON 字符串形态）
  - `projex-update-workitem` 成功时 stdout 常输出 `<anonymous_script>:1` + HTML + `SyntaxError: … not valid JSON`（CLI 尝试 eval HTML 的报错噪声）；**以 `status === 0` 判断成功，勿解析 stdout**
  - `projex-list-workitem-comments` / `projex-list-workitem-activities` 只支持 `--id`，无 `--page`
  - 工作项编号是 `serialNumber`，`--id` 传 32 位 hash，两者不可混用
  - `projex-search-projects` / `projex-search-workitems` 的响应是**顶层 JSON 数组**；解析先 `Array.isArray(j) ? j : j.result.list`，不要假设 `result.list` 包裹结构
  - `projex-search-workitems --conditions` 对 serialNumber EQ 等条件的过滤**实测可能不生效**（返回项目全量），任何搜索结果都须本地按 `serialNumber` 精确过滤并断言唯一
  - Windows 下 Node `require('/tmp/xxx.json')` 不识别 `/tmp` 路径；一律用 stdin 管道解析，确需落盘时用 `os.tmpdir()` 拼接绝对路径

## 安全边界

- 未通过确认门，不得调用创建或更新命令。
- 更新描述只追加不覆盖；不得用普通任务替代产品类需求，不得伪造"待开发"等状态。
- 不得在创建/更新后自动变更状态、负责人、优先级、迭代或截止时间。
- CLI 不可用、认证失败、网络失败或资源无法唯一匹配时，停止操作并报告可恢复的阻塞原因，不猜测、不重试写操作。

## 参考

- CLI 命令、字段解析、创建/查询/更新的安全示例：[`references/cli.md`](references/cli.md)。仅在 A4/A5、B2–B4、C4 步读取。
- 发布正文模板与字段规则：[`references/prd-template.md`](references/prd-template.md)。