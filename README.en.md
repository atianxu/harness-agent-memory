# Harness Agent Memory

> One memory store per agent. Run several roles on the same Harness and each keeps its own memory — no bleed, no cross-contamination.

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933)](#)

[简体中文](README.md) | **English**

---

## 1. The problem

Harness long-term memory is a single store by default. As soon as several roles run on one machine — an assistant, a reviewer, an on-duty bot, a dedicated side account — three failures show up:

- **Bleed**: role A's project context is taken as role B's own history.
- **Pollution**: a one-off task's throwaway conclusions land in the main account's long-term memory.
- **Overwriting**: two roles reach different conclusions about the same matter, and the later write pushes out the earlier one.

dsh-agent-memory keys memory by **agentId**: each agentId maps to its own named mnemon store and its own SQLite file, physically isolated, sharing no context.

## 2. How isolation works

```text
Harness (one process)
   │
   ├── agentId = default   →  <data root>\data\default\mnemon.db
   ├── agentId = xiaoer    →  <data root>\data\xiaoer\mnemon.db
   └── agentId = xiaosan   →  <data root>\data\xiaosan\mnemon.db
                                   ▲
                    each store is a separate file; reads and writes never see each other
```

Isolation comes from mnemon's **named stores**, not from a prompt instruction to "stay separate". Therefore:

- deleting or rebuilding one store does not touch the others;
- a corrupted store leaves the others readable and writable;
- under dsh-mnemon's Git sync, each store occupies its own subdirectory in the remote repository and can be rolled back on its own.

## 3. The two tools

The plugin exposes exactly two tools, with fixed arguments and predictable behaviour.

### `agent_memory_read`

Read the memory of a given agent.

| Parameter | Type | Description |
| --- | --- | --- |
| `agentId` | string, required | Target store name; must match `[a-zA-Z0-9][a-zA-Z0-9_-]*`. The main store is `default` |
| `query` | string, required | Natural-language question or keyword |
| `mode` | string, optional | `recall` (default, graph-enhanced hybrid recall) / `keyword` (keyword ranking) / `basic` (SQL LIKE fallback) |
| `limit` | integer, optional | Maximum results, default 10 |

Returns `{ agentId, query, mode, memory }`, where `memory` is mnemon's raw output (parsed into an object when it is valid JSON, otherwise the raw string).

### `agent_memory_bootstrap`

Create stores in bulk and list them all.

| Parameter | Type | Description |
| --- | --- | --- |
| `agents` | string[], required | Store names to create |

Returns `{ created, skipped, stores }`:

- `created` — stores created by this call;
- `skipped` — stores that already existed, **contents untouched**;
- `stores` — the full `mnemon store list` after creation.

Create-only, never delete, and therefore naturally idempotent: re-running it never clears existing memory.

## 4. Install

### Prerequisites

- DeepSeek Harness desktop edition;
- a working mnemon CLI (`mnemon` on PATH, or an absolute path via `MNEMON_CLI_PATH`).

### Mounting

Place this directory where Harness keeps plugins, then add one dependency and one bundle entry to `profiles\desktop\package.json`:

```json
{
  "dependencies": {
    "dsh-agent-memory": "link:<absolute path to this repository>"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-agent-memory"]
    }
  }
}
```

Restart Harness afterwards. The plugin declares `inject: ['tools']`, so Harness exposes the tools service before calling `apply(ctx)` to register the two tools.

### Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `MNEMON_DATA_DIR` | Root of the mnemon data directory | `<DSH_HOME>\mnemon` |
| `MNEMON_CLI_PATH` | Path to the mnemon executable | `mnemon` from PATH |

If neither is available, the plugin raises a clear error naming the variable to set — it never guesses a local path.

## 5. Usage

Just say it in the conversation:

```text
Create the xiaoer, xiaosan and xiaosi stores.
```

The model calls `agent_memory_bootstrap({ agents: ["xiaoer","xiaosan","xiaosi"] })`, and the result shows which were created and which already existed.

```text
Look at the xiaosan store — what was recorded about the power supply plan last week?
```

The model calls `agent_memory_read({ agentId: "xiaosan", query: "power supply plan", mode: "recall" })`.

## 6. Design boundaries

- **Read and create only, no write routing**: memory writes stay on Harness' and mnemon's existing path. The plugin does not take over write timing, so it cannot conflict with the memory plugin's own logic.
- **No cross-store merging**: merging is an explicit user action. There is no implicit aggregation, which would quietly undo the isolation.
- **No reliance on internal mounting**: both tools call mnemon directly with `--store <agentId>` instead of the memory plugin's internal state, so memory plugin upgrades cannot break this plugin.
- **Windows-safe by construction**: mnemon is a `.cmd` batch file on Windows, so `execFile` must run with `shell` enabled. That is handled explicitly in code rather than left to chance.

## 7. FAQ

**Both tools are there, but reads return nothing.**
First confirm the store exists — call `agent_memory_bootstrap` once and inspect the `stores` list — then confirm `MNEMON_DATA_DIR` points at the data root actually in use.

**Calls time out.**
Reads and writes are capped at 30 s each; a very large store or slow disk can exceed that. The error carries mnemon's stderr, so read it and act on it.

**What happens if I mistype a store name?**
Store names must match `[a-zA-Z0-9][a-zA-Z0-9_-]*`. Anything else fails immediately instead of silently creating an oddly named store.

**Does it work alongside dsh-mnemon's Git sync?**
Yes. Each store is its own subdirectory in the remote repository, so sync and rollback of one store never affect another.

## 8. Layout

```text
index.js       Plugin: two tools, store-name validation, mnemon invocation and output parsing
package.json   Package manifest (ESM, node >= 20)
README.md      Chinese README
README.en.md   This file
LICENSE        MIT
```

## License

MIT — see [LICENSE](LICENSE). Author: DR.WAN.
