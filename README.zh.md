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

Markdown 文件以 YAML frontmatter 开头（会话、工作区、preset、模型、导出范围、计数、
`exporter: dsh-cot-export@<版本>` 溯源标记），随后是 `## Index` 表格，把每一轮映射到行号；
审查者可以用内置 `read` 工具按行窗口读，不必一次加载整份大文件。

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
| `html` | `.html` | 自包含的时间轴视图：每轮一张卡、每步一块，推理/回答/工具结果可折叠，带展开全部、锚点跳转、跟随 `prefers-color-scheme` 的深浅色样式。无外部资源，会话文本全部 HTML 转义。 |

`html` 就是"回放"视图：它是唯一同时带上**工具结果**的格式（成功/失败、参数、每条结果最多
4000 字符并标注截断），所以一次跑完的会话事后可以直接在浏览器里从头看到尾，不需要额外工具。

## 一键导出

打开会话，点头部的 **CoT** 按钮：一次点击按所选格式导出，并在按钮下方展开结果面板：

- **格式**：显式分段控件（`Markdown · HTML · JSON · JSONL · Text`），点另一个格式就立刻重导并刷新同一面板，
  当前格式始终可见，不再藏在菜单里；
- **数字**：轮次、步数、推理字符、推理 token；
- **产物**：文件名 + 绝对路径，点整块即复制路径；
- **保存到**：显示实际写入目录，**更改** 打开宿主的目录选择器，选择会被记住，**默认** 回到配置的目录；
- **下载**：普通文件下载，不弹任何对话框。字节走 `inline=1` 响应再经 blob URL 交给浏览器，
  因此外壳**不会**导航到导出路由（那会把导出物当页面打开），也不会在宿主侧多写一份重复文件；
- **另存为…**：仅当外壳实现保存对话框时出现，用来选择同一份字节存到哪个文件；
- **复盘包**：写出 CoT + `REVIEW.md`（评分规则、窗口计划、委派提示词），并把提示词放到剪贴板；
- **× / Escape / 点空白处**：关闭。有结果时按钮带一个小圆点，上次失败则变红。

已知失败会换成可操作的文案而不是原始报错：路由不可用提示改用 `/cot`，无推理记录、跨工作区会话
各自给出原因。版式跟宿主一致：28px 方形触发按钮、`--dsw-radius-*` 圆角、
`--dsw-elevation-prominent` 投影、`--dsw-focus-ring-color` 焦点环、
`--dsw-alias-button-info-fill` 主按钮、`--dsw-font-*` 字体尺度 —— 没有字面色值，深浅色都跟主题走。

### 路由契约

头部按钮只跟一条已鉴权的精确路由打交道：

```
GET /api/cot.export
  ?sessionId=<id>            必填
  &mode=export|review        review 同时写 REVIEW.md
  &format=markdown|json|jsonl|text
  &scope=all|surface
  &dir=<绝对目录>            导出物写到哪里
  &includeContext=1|0 &includeFailedAttempts=1|0
  &download=1                导出并写盘后再把字节流回去
  &inline=1                  只把已写好那份的字节流回去
```

`HEAD` 用来探测路由是否存在；未知会话 `404`、参数错误 `400`、没有推理记录 `409`。

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
node --test test/cot.test.mjs        # 16 个单元测试（纯核心），无需安装依赖
node selftest/run.mjs <log> ...      # 集成自测：真实会话日志走真实 apply()
node selftest/client-test.mjs        # 客户端连线/状态机（桩渲染器，不是视觉证明）
npm pack --dry-run                   # 查看会发布哪些文件
```

集成自测只桩接 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，用真实 `apply()` 起插件，
把两个工具、`/cot` 命令和全部路由模式（JSON、HEAD、download、`mode=review`、400/404）跑一遍，
并按每个工具自己声明的 output schema 校验返回值，所以 schema 与实现的漂移会在自测里先炸。

## 社区

GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)。欢迎 issue 和 PR；
README 顶部的安装命令就是社区标准入口。

## 许可

[MIT](LICENSE) © 2026 Aliarrrrr
