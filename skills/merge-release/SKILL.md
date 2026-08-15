---
name: merge-release
description: 合并功能分支到 release 发布分支。Use when the user asks to 合并到 release、合并发布分支、merge to release、把 xxx 分支合到 release, or needs an MR 合并标题与描述 for a release merge.
---

# 功能分支合并到 release

将已验证的功能分支合并到 release 发布分支，并输出合并标题与描述。合并且推送完成后，用户可自行在远程平台（如 GitLab/云效代码托管）基于产物创建 MR；本技能默认在本地以 `git merge --no-ff` 完成等价合并。

## 适用范围

- 仅处理 git 分支合并类工作（来源分支 → 目标 release 分支）。
- 云效产品类需求发布（PRD 工作项）不使用本技能，走 `release-yunxiao`。
- 环境/本地未提交改动（如 `vite.config.ts` 的 baseURL 切换）默认**不纳入合并**，保持在工作区。

## 流程

### 1. 锁定合并范围

确认以下信息，缺任一则先询问：

- 来源分支：如 `feat/MSIS-2469`
- 目标分支：如 `release/v6.2.1`（默认取用户指定的 release 分支；未指定时询问，不要猜测最新 release）
- 是否已推送：以 `origin/<分支>` 为基准确认待合并提交范围

完成条件：来源/目标分支明确，且 `git log --oneline origin/<target>..origin/<source>` 能列出待合并提交。

### 2. 生成合并标题与描述

按待合并提交归类生成（不逐个罗列），标题格式建议：

```
feat(摄像头): PTZ 控制可靠性优化与 VIDEOP(铁塔) 360 制兼容
```

描述结构（Markdown）：

- **背景**：1–2 句说明为什么合并这些改动
- **主要变更**：按主题分组列出（如 PTZ 可靠性 / 多平台兼容 / 请求去重 / 资源性能 / 工程修复），每组标注对应 commit 短哈希
- **影响范围**：涉及的组件/页面
- **需回归验证**：分条列出关键验证点（如 VIDEOP 可视区朝向、接口失败后仍可控制、无重复请求等）

### 3. 合并前检查

```bash
git status -sb                 # 确认工作区状态
git checkout <target>          # 切到目标分支
git pull --ff-only             # 同步远端，避免基于过期基线
git log --oneline origin/<target>..origin/<source>   # 复查待合并提交
```

注意事项：

- 合并前若发现来源分支存在未提交改动，先提示用户；不擅自 stash 或提交。
- 目标分支 `pull` 失败/落后远端时停下报告，不强行合并。

### 4. 执行合并

```bash
git merge --no-ff <source> -m "Merge branch '<source>' into '<target>'"
```

- 必须 `--no-ff`：保留合并记录，与远程 MR 的合并提交风格一致（单引号包裹分支名）。

### 5. 冲突处理

出现冲突时：

- 立即停下，输出冲突文件列表（`git status` 的 `UU` 条目）。
- 不要擅自选择取舍；向用户说明每个冲突文件的分歧点并给出建议，等待用户决定。
- 用户决定后由我执行相应 `git add` + `git commit`（保留合并提交信息）。

### 6. push 前确认门

push 属于不可逆的远端写操作，执行前展示摘要并等待用户确认：

```md
## 合并推送确认

| 字段 | 值 |
| --- | --- |
| 来源分支 | feat/MSIS-2469 |
| 目标分支 | release/v6.2.1 |
| 合并提交 | Merge branch 'feat/MSIS-2469' into 'release/v6.2.1' |
| 涉及提交数 | 12 |
| 冲突 | 无 |

是否推送到 origin/<target>？
```

用户确认后执行 `git push origin <target>`。

### 7. 归位

推送成功后：

- 切回来源/开发分支：`git checkout <source>`。
- 确认工作区未提交改动（如 `vite.config.ts`）仍然保留。
- 向用户输出合并结果摘要（新合并提交哈希、涉及提交数、分支状态）。

## 安全边界

- 未通过确认门，不得执行 `git push` 到 release 分支。
- 冲突未解决前不得继续合并或推送。
- 不得改动来源分支上未提交的本地改动（即使它们看起来“顺手”）。
- 目标分支存在新提交（本地落后远端）时停止并报告，不 force push、不 rebase 远端已发布提交。
- 无法定位目标分支、来源分支不存在或远端不可达时，停止并报告可恢复的阻塞原因。