# dsh-cot-export

[English](README.md) | 简体中文

把一个 DSH 会话里模型的**完整思维链**——模型逐轮输出的每一个 reasoning 块——一键导出为
Markdown、JSON、JSONL 或纯文本。导出物就是工作区里的普通文件，任何其他会话、subagent
或 teammate 都能直接读取和审查。

三个入口，同一条流水线：

| 入口 | 谁来用 |
|---|---|
| 会话头部 **CoT** 按钮（在会话操作栏旁） | 用户，一键 |
| `/cot …` 斜杠命令 | 用户在输入框里用 |
| `cot_export` / `cot_review` 工具 | 任意会话里的任意 agent |

## 安装

要求：DSH **0.2.1-rc.3**（`package.json` 中已声明兼容）、Node.js **22.19+ / 24+**。

```sh
# GitHub 通道，无需 npm 账号
dsh plugin --profile <profile> add github:Aliarrrrr/dsh-cot-export
```

`<profile>` 是你的 DSH profile 名（`web`、`desktop`、`headless` 等）。装好后
profile 会经 HMR 自动重组，打开会话即可看到 **CoT** 按钮、`/cot` 命令和
`cot_export` / `cot_review` 工具。

升级 / 卸载：

```sh
dsh plugin --profile <profile> update dsh-cot-export
dsh plugin --profile <profile> remove dsh-cot-export
```

每个 GitHub Release 也附带 `dsh-cot-export-<version>.tgz`，可离线安装：

```sh
dsh plugin --profile <profile> add ./dsh-cot-export-1.0.0.tgz
```

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| `0.2.1-rc.3` | ✅ 兼容（已实测） |

声明位置：`package.json` → `dsh.compatibility.dshReleases`。插件本身是标准 Cordis
bundle（`dsh.bundle.patch` → `cordis.patch.yml`），含 Host 与 Client 两半。

## 导出物长什么样

默认目录是 `<workspace>/cot-exports/`，每个入口都会返回绝对路径。

```
cot-exports/fix-the-failing-test-aaaa1111-20261027-211759.md
```

Markdown 文件以 YAML frontmatter 开头（会话、工作区、preset、模型、导出范围、计数），
随后是 `## Index` 表格，把每一轮映射到行号；审查者可以用内置 `read` 工具按行窗口读，
不必一次加载整份大文件。

思维链是**逐字**导出的：被上下文压缩隐藏的步骤在 `all` 范围下仍会导出，并标注
`> ⚠ superseded — hidden from the current model context by compaction`；
从 fork 父会话继承的步骤标注 `inherited`。

## 格式

| `format` | 文件 | 结构 |
|---|---|---|
| `markdown`（默认） | `.md` | frontmatter + 轮次索引 + 每轮/每步一节，reasoning 用代码围栏（内容含反引号时自动加长） |
| `json` | `.json` | 一个对象：`{schema, session, exported_at, scope, stats, turns[]}` |
| `jsonl` | `.jsonl` | 每个 step 一行，方便 grep / `jq` / 管道处理 |
| `text` | `.txt` | 最小纯文本 |

## 一键导出

打开会话，点头部的 **CoT** 按钮：写出 Markdown 导出物，并显示轮数/字符数的 chip；
chip 的 tooltip 是绝对路径，点击复制路径，`↓` 下载同一文件，`×` 关闭。如果导出路由不可用
（旧 Host 或路径冲突），chip 会给出提示，`/cot` 仍然可用。

## 斜杠命令

```
/cot                         用配置的格式导出当前会话
/cot json                    指定格式（md|markdown|json|jsonl|txt|text）
/cot surface                 只导出当前模型上下文里可见的部分
/cot latest                  同工作区里除自己外最新的会话
/cot <id-or-prefix>          任意可读会话
/cot review [focus]          导出并在旁边写一份 REVIEW.md
```

命令输出只在人的界面里显示，不会变成模型消息。

## 给其他 agent 的工具

**`cot_export`** — 导出任意会话（自己的、`latest`、精确 id 或唯一 id 前缀），返回
`path`、字节数和计数；可以带出全部下游 subagent 会话，组成带 `INDEX.md` 的目录树。

**`cot_review`** — 生成监督审查包：它自己再导出一份 CoT，并在旁边写 `REVIEW.md`
（审查 rubric、带精确行号的窗口计划、可直接交给 reviewer 的委托提示词）。它**不会**
启动 reviewer，也绝不覆盖其他调用产生的同名导出（重名自动加 `-2`）。

```
cot_review { "session_id": "latest", "focus": "wasted effort" }
→ 把返回的 delegation_prompt 交给 subagent 工具、teammate 或另一个会话
```

两个工具都是全局工具，所以常规的“监督闭环”不需要新机制：在这里导出，把提示词交给
`subagent` / `spawn_teammate` / 另一个会话，reviewer 按窗口读文件即可。

插件还注册了内置 skill **`cot-review`**（model-invocable），任何会话里的 reviewer
都能用 `skill` 工具加载同一套 rubric。

## 配置

在 profile 的 `cordis.patch.yml` 里该插件的行下设置，所有字段可选。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `outputDir` | `'cot-exports'` | 绝对路径，或相对目标会话工作区 |
| `defaultFormat` | `'markdown'` | `markdown` \| `json` \| `jsonl` \| `text` |
| `defaultScope` | `'all'` | `all` = 完整日志（含被压缩隐藏的 reasoning）；`surface` = 仅当前上下文 |
| `includeContext` | `true` | 同时记录用户输入、回答和工具调用名 |
| `includeFailedAttempts` | `false` | 从流式记录重建失败/中断尝试的 reasoning |
| `crossSession` | `'workspace'` | `workspace` = agent 只能导出 cwd 完全相同的其他会话；`any` = 不检查 |
| `maxToolPreviewChars` | `600` | `cot_export` 结果里预览的长度（0 关闭） |
| `reviewWindowTurns` | `8` | 审查窗口每窗轮数（0 = 单窗） |
| `enableRoute` | `true` | 注册 `GET /api/cot.export`，供头部按钮使用 |
| `routePath` | `'/api/cot.export'` | 与其他插件路由冲突时可改 |
| `enableSkill` | `true` | 注册 `cot-review` skill |

配置示例：

```yaml
- id: cot-export
  name: 'dsh-cot-export'
  config:
    outputDir: 'D:/cot-exports'
    defaultScope: 'surface'
```

## 行为要点

- **对会话只读**：通过 `ctx.sessionQuery` 读取，从不追加事件、不引入新事件类型、不动已存日志；只写导出文件。
- **实时优先**：live 会话从内存读；仅持久化的会话读取时不会激活或恢复它；导出瞬间仍在流式输出的 step 尚未提交，不在导出物里。
- **原子写**：先写同目录临时文件再 rename；重名自动加 `-2`，不覆盖。
- **鉴权**：头部按钮走已鉴权的 exact Fetch 路由（`/api/cot.export`），只有宿主浏览器会话能调；不开放未鉴权端口。
- **降级**：缺 `connection`、`commands` 或 `skills` 服务、或路由/命令重名时，只记 warning，其余功能照常。
- **聚合 bundle**：若另一个启用的条目已经挂载 `dsh-cot-export`，本插件的补丁行会自动让位，避免双挂载。

## 隐私

思维链是逐字导出的，可能包含模型看到的源码、文件内容、路径和密钥。导出物是工作区里的明文文件。
本插件不发网络请求、不上传任何内容。

## 卸载

从 profile 移除 `dsh-cot-export` bundle（Plugin Manager 或 `plugin_manager remove_bundle`），
再删除不再需要的 `cot-exports` 目录。插件不保留其他状态。

## 安装通道细节

- **GitHub（推荐）**：`dsh plugin --profile <profile> add github:Aliarrrrr/dsh-cot-export`
- **Tarball**：从最新 GitHub Release 下载 `.tgz`，再 `dsh plugin --profile <profile> add ./dsh-cot-export-1.0.0.tgz`
- **本地目录**：克隆后 `dsh plugin --profile <profile> add .`

如果 profile 的 pnpm 安装被阻塞（例如当前账号读不了某个包目录），也可以手工挂载 bundle ——
这是兜底路径，不是常规路径：

```powershell
cmd /c mklink /J "C:\Users\<you>\.dsh\profiles\<profile>\node_modules\dsh-cot-export" "<本仓库的绝对路径>"
```

```yaml
# 追加到 profile 的 cordis.patch.yml
- insert:
    - id: cot-export
      name: 'dsh-cot-export'
```

HMR 会在文件变化后自动重组 profile，插件无需重启即可挂载；改链接目录里的文件在下一次重组时生效。
删除该行和 junction 即可撤销，之后建议走常规安装通道。

## 开发

```sh
node --test test/cot.test.mjs   # 16 个单元测试，无需安装依赖
npm pack --dry-run              # 查看会发布哪些文件
```

## 社区

GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)。欢迎 issue 和 PR；
README 顶部的安装命令就是社区标准入口。

## 许可

[MIT](LICENSE) © 2026 Aliarrrrr
