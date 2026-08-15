# 云效 CLI 参考

本参考在 `release-yunxiao` 的第 4、5 步使用。命令基于本机已验证的 `aliyun-cli-devops`；创建命令有副作用，必须在用户通过确认门后才可执行。

## 前置检查

1. 安装阿里云 CLI，并安装或升级云效插件：

   ```bash
   aliyun plugin install --names aliyun-cli-devops
   aliyun devops version
   ```

2. 使用云效个人访问令牌（PAT），通过环境变量传递，绝不将令牌写入命令、PRD、日志或版本库。令牌按最小权限授予本流程所需的项目协作读写和成员查询读取权限。

3. 根据组织类型配置以下**其中一种**环境变量组合：

   ```bash
   # 中心站
   export ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN='<PAT>'
   export ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID='<组织 ID>'
   ```

   ```bash
   # Region 站
   export ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN='<PAT>'
   export ALIBABA_CLOUD_YUNXIAO_API_BASE_URL='https://<组织专属域名>'
   ```

   在 Windows PowerShell 中使用等价的环境变量设置，避免将 PAT 作为命令参数传入：

   ```powershell
   # 中心站：设置 ACCESS_TOKEN 与 ORGANIZATION_ID
   $env:ALIBABA_CLOUD_YUNXIAO_ACCESS_TOKEN = '<PAT>'
   $env:ALIBABA_CLOUD_YUNXIAO_ORGANIZATION_ID = '<组织 ID>'

   # Region 站：设置 ACCESS_TOKEN 与 API_BASE_URL
   $env:ALIBABA_CLOUD_YUNXIAO_API_BASE_URL = 'https://<组织专属域名>'
   ```

4. 创建前确认 `aliyun devops version` 成功，且当前 CLI 的 `--help` 仍列出本流程需要的命令和参数。CLI 不存在、插件不可用、认证失败或站点配置缺失时停止发布并报告原因。

## 资源解析

所有查询先解析 JSON，再在本地做精确匹配。查询结果为空、多条结果匹配或响应结构不符合预期时停止；不得凭名称近似猜测。

### 项目

`projex-search-projects --conditions` 只支持 `name`、`status`、`gmtCreate`、`creator`、`project.admin` 和 `logicalStatus`，不支持 `customCode`。因此不要构造项目编码的 `--conditions`；应分页列出项目并按返回对象的 `customCode` 精确匹配。

```bash
# --per-page 的最大值为 200。继续读取后续页，直到全部页读取完毕。
aliyun devops projex-search-projects --page 1 --per-page 200
```

从全部返回项中筛选 `customCode === projectCode`，且必须恰好得到一个 `projectId`。如当前插件支持并能确认参数语义，也可使用其 `--pager` 聚合所有页；不可假设单页已包含全部项目。

### 负责人

```bash
# 查询仅用于缩小范围；最终仍按 name 精确匹配。
aliyun devops base-search-members --query '{assigneeName}' --page 1 --per-page 100
```

继续读取所有页和 `nextToken`（如果响应返回），再按 `name === assigneeName` 精确匹配。必须从唯一结果中取 `userId`（账号 ID），**不能**取 `id`（组织成员 ID）；`--assigned-to` 使用 `id` 会报 `Invalid.UserAccountId`。

### 工作项类型、字段和迭代

```bash
# 仅从目标项目的需求类型中选择 name 为“产品类需求”的唯一项。
aliyun devops projex-list-workitem-types --id '{projectId}' --category Req

# 每次创建前都读取目标项目、目标工作项类型的字段配置。
aliyun devops projex-get-workitem-type-field-config \
  --project-id '{projectId}' \
  --id '{workitemTypeId}'

# 用户填写迭代时按名称查询，并读取所有分页结果。
aliyun devops projex-list-sprints \
  --id '{projectId}' \
  --name '{sprintName}' \
  --page 1 \
  --per-page 100
```

从字段配置中按 `id: priority` 的 `options[].displayValue` 精确匹配用户确认的优先级，并取得该 option 的 ID。计划完成时间字段必须从同一份配置中按实际字段名称解析；字段 ID 因项目而异，禁止硬编码。迭代名称必须唯一匹配，未填写时不查询也不传 `--sprint`。

## 富文本正文

`projex-create-workitem` 的 `--format-type` 可取 `RICHTEXT` 或 `MARKDOWN`，默认是 `RICHTEXT`。本技能固定使用 `RICHTEXT`：传给 `--description` 的内容必须是 UTF-8 编码的 HTML 富文本片段，而不是 Markdown 源文。云效官方 MCP 对同一格式返回 `embedHtml`，可作为 HTML 富文本载荷的佐证。

本地 PRD 可以保留 Markdown 作为编辑源，但在创建前必须生成并检查对应的 HTML 文件。转换后至少保留标题、段落、列表、加粗、表格和链接；用户手动补充的“界面设计”章节保持为空，不得在转换阶段填充内容。HTML 文件只可来自已确认的 PRD，不得从不受信任输入直接拼接脚本、事件属性或外链资源。

## 安全创建与结果解析

使用 Node.js 的非 shell 参数调用，以保留 HTML 中的换行和特殊字符。示例中的占位符必须在前一步被唯一解析；`richTextPath` 指向已生成并验证的 HTML 文件。

```javascript
const { readFileSync } = require("fs");
const { spawnSync } = require("child_process");

const richText = readFileSync("{richTextPath}", "utf8");
const customFields = { priority: "{priorityId}" };
const args = [
  "devops",
  "projex-create-workitem",
  "--space-id", "{projectId}",
  "--workitem-type-id", "{workitemTypeId}",
  "--assigned-to", "{userId}",
  "--subject", "{subject}",
  "--description", richText,
  "--format-type", "RICHTEXT",
];

if ("{deadline}" !== "") {
  customFields["{deadlineFieldId}"] = "{deadline}";
}
if (Object.keys(customFields).length > 0) {
  args.push("--custom-field-values", JSON.stringify(customFields));
}
if ("{sprintId}" !== "") {
  args.push("--sprint", "{sprintId}");
}

const result = spawnSync("aliyun", args, {
  shell: false,
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 10 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.signal) throw new Error(`云效创建命令被信号 ${result.signal} 中断`);
if (result.status !== 0) throw new Error(result.stderr || "云效创建失败");

let created;
try {
  created = JSON.parse(result.stdout);
} catch {
  throw new Error("云效创建响应不是可解析的 JSON");
}

const workitemId = created.id ?? created.workitemId ?? created.result?.id;
if (!workitemId) throw new Error("云效创建响应未返回工作项 ID");
```

创建调用发生超时、网络中断或响应无法解析时，**不得自动重试创建**，因为无法证明工作项未被服务端创建。先按标题、创建人和创建时间范围查询可能已创建的工作项；仍无法唯一确认时向用户报告不确定结果。

## 创建后核验

取得 `workitemId` 后立即读取详情：

```bash
aliyun devops projex-get-workitem --id '{workitemId}'
```

核验 `subject`、`workitemType.name`、`assignedTo.name`、`customFieldValues` 中的优先级与计划完成时间、`sprint.name`、`description` 富文本内容和 `status.displayName`。核验内容必须与确认摘要及已生成的 HTML 正文一致；任何字段缺失或不一致都停止并报告差异，不擅自更新工作项。

## 失败处理

- 读取类命令可在明确未发起创建时按网络错误有限重试；每次重试仍须重新解析和唯一性校验。
- 创建命令只执行一次。失败信息应保留 `stderr`、退出状态和已完成的只读步骤，但不得输出 PAT。
- 创建后只允许读取和核验；不得自动修改状态、负责人、优先级、迭代或截止时间。
