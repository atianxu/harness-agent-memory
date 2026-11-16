# Harness Agent Memory · 多智能体记忆

> 一个 agent 一套记忆，各记各的。同一台 Harness 上并行跑多个角色，彼此不串味、互不污染。

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](#)

**简体中文** | [English](README.en.md)

---

## 一、它解决什么问题

Harness 的长期记忆默认只有一个库。一旦在同一台机器上同时使用多个角色 —— 助手、审校、值班、某个专用小号 —— 就会出现三种典型故障：

- **串味**：A 角色的项目背景被 B 角色当成自己的历史；
- **污染**：一次性任务的临时结论进了主账号的长期记忆；
- **互相覆盖**：两个角色对同一件事给出不同判断，后写的把先写的挤掉。

dsh-agent-memory 把记忆按 **agentId 分库**：每个 agentId 对应一个独立的 mnemon 具名库、一份独立的 SQLite 文件，物理隔离，不共享上下文。

## 二、隔离是怎么做到的

```text
Harness（同一进程）
   │
   ├── agentId = default   →  <data root>\data\default\mnemon.db
   ├── agentId = xiaoer    →  <data root>\data\xiaoer\mnemon.db
   └── agentId = xiaosan   →  <data root>\data\xiaosan\mnemon.db
                                   ▲
                        每个库是独立文件，读写互不可见
```

隔离靠的是 mnemon 的 **具名库（named store）**，不是靠提示词里说"不要串味"。因此：

- 删除/重建某一个库，不影响其他库；
- 某个库损坏，其他库照常读写；
- 备份走 dsh-mnemon 的 Git 同步时，每个库占远端仓库的一个独立子目录，可单独回滚。

## 三、两个工具

插件对外只暴露两个工具，参数固定、行为可预期。

### `agent_memory_read`

读取指定 agent 的记忆。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agentId` | string，必填 | 目标库名，须匹配 `[a-zA-Z0-9][a-zA-Z0-9_-]*`；主库名为 `default` |
| `query` | string，必填 | 自然语言问题或关键词 |
| `mode` | string，可选 | `recall`（默认，图增强混合召回）/ `keyword`（关键词排序）/ `basic`（SQL LIKE 兜底） |
| `limit` | integer，可选 | 返回条数上限，默认 10 |

返回 `{ agentId, query, mode, memory }`，`memory` 为 mnemon 原始输出（JSON 可解析时给出对象，否则给出原字符串）。

### `agent_memory_bootstrap`

批量建库并列出全部库。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `agents` | string[]，必填 | 要创建的库名列表 |

返回 `{ created, skipped, stores }`：

- `created` —— 本次新建的库；
- `skipped` —— 已存在、**内容原样保留**的库；
- `stores` —— 建库后 `mnemon store list` 的完整清单。

只建不删，天然幂等：重复执行不会清掉任何已有记忆。

## 四、安装

### 前置

- DeepSeek Harness 桌面版；
- mnemon CLI 可用（`mnemon` 在 PATH 中，或用 `MNEMON_CLI_PATH` 指定绝对路径）。

### 挂载

把本目录放进 Harness 的插件目录，然后在 `profiles\desktop\package.json` 里加一条依赖与一个 bundle：

```json
{
  "dependencies": {
    "dsh-agent-memory": "link:<本仓库绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-agent-memory"]
    }
  }
}
```

改完重启 Harness。插件通过 `inject: ['tools']` 声明依赖，Harness 会先装配工具服务，再调用 `apply(ctx)` 注册两个工具。

### 配置

| 环境变量 | 作用 | 缺省行为 |
| --- | --- | --- |
| `MNEMON_DATA_DIR` | mnemon 数据根 | 取 `<DSH_HOME>\mnemon` |
| `MNEMON_CLI_PATH` | mnemon 可执行文件路径 | 用 PATH 中的 `mnemon` |

两者都没给时，插件会抛出一条明确的错误，指出该设置哪个变量 —— 不会去猜一个本机路径。

## 五、使用示例

对话里直接说：

```text
把 xiaoer、xiaosan、xiaosi 三个库建起来
```

模型会调用 `agent_memory_bootstrap({ agents: ["xiaoer","xiaosan","xiaosi"] })`，返回里能看见谁新建、谁已存在。

```text
看一下 xiaosan 这个库，上周关于供电方案记了什么
```

模型会调用 `agent_memory_read({ agentId: "xiaosan", query: "供电方案", mode: "recall" })`。

## 六、设计边界

- **只读与建库，不做写入路由**：记忆的写入仍由 Harness 与 mnemon 原有链路负责，本插件不接管写入时机，避免与记忆插件自身逻辑冲突。
- **不做跨库合并**：需要合并时由使用者显式发起，插件不提供隐式汇总，避免把隔离又悄悄破坏掉。
- **不依赖内部挂载点**：两个工具直接以 `--store <agentId>` 调 mnemon，不走记忆插件的内部状态，因此记忆插件升级不影响本插件的可用性。
- **Windows 兼容**：mnemon 在 Windows 上是 `.cmd`，`execFile` 必须开 `shell`，这一点在代码里显式处理，不是靠环境碰运气。

## 七、常见问题

**两个工具都在，但读不到内容。**
先确认 `agentId` 对应的库存在（可以调一次 `agent_memory_bootstrap` 看 `stores` 清单），再确认 `MNEMON_DATA_DIR` 指向的就是实际在用的数据根。

**调用超时。**
读写各有 30s 上限；库很大或磁盘慢时会超时。此时报错会带上 mnemon 的 stderr，按提示排查即可。

**把库名写错了会怎样。**
库名必须匹配 `[a-zA-Z0-9][a-zA-Z0-9_-]*`，不匹配直接报错，不会静默创建一个奇怪名字的库。

**能和 dsh-mnemon 的 Git 同步一起用吗？**
可以。每个库在远端仓库里是独立子目录，同步与回滚互不影响。

## 八、目录结构

```text
index.js       插件本体：两个工具、库名校验、mnemon 调用与输出解析
package.json   包声明（ESM，node >= 20）
README.md      中文说明
README.en.md   English README
LICENSE        MIT
```

## 许可证

MIT，见 [LICENSE](LICENSE)。作者：D2W。
