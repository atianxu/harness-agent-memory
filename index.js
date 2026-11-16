/**
 * dsh-agent-memory — multi-agent isolated memory routing (host side).
 *
 * Built on mnemon named stores: each agent gets an independent SQLite memory
 * database (data/<agentId>/mnemon.db) that is physically isolated. The
 * dsh-mnemon Git sync packs every store into the same remote repository,
 * where each store occupies its own subdirectory.
 *
 * Two tools are exposed as stable entry points, without relying on the memory
 * plugin's internal pinning:
 *   - agent_memory_read       read a specified agent's memory (mnemon --store)
 *   - agent_memory_bootstrap  create/list agent memory stores in bulk
 *
 * Configuration (environment variables, no hard-coded local paths):
 *   MNEMON_DATA_DIR   mnemon data root; defaults to <DSH_HOME>/mnemon
 *   MNEMON_CLI_PATH   path to the mnemon executable, when it is not on PATH
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-agent-memory'
// The tools service must be declared as an injection before ctx.tools is read.
export const inject = ['tools']

const STORE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

/**
 * 两个工具共用的输出声明。dsh-tools 的 register() 要求每个工具都声明
 * output { schema, render }，缺了会在注册时抛 TypeError；共用一份常量，
 * 避免同一形状写两遍（也照 dsh-tool-goal 的 GOAL_OUTPUT 做法）。
 * render 不做缩进：记忆召回可能条数较多，缩进会成倍放大 token。
 */
const MEMORY_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/** Resolve the mnemon executable: prefer the env var, then fall back to PATH. */
function resolveCli() {
  const fromEnv = process.env.MNEMON_CLI_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  return 'mnemon'
}

/**
 * Resolve the mnemon data root.
 * MNEMON_DATA_DIR wins; otherwise <DSH_HOME>/mnemon; otherwise a clear error
 * naming the variable to set (never a guessed local path).
 */
function resolveDataDir() {
  const fromEnv = process.env.MNEMON_DATA_DIR
  if (fromEnv) return fromEnv
  const dshHome = process.env.DSH_HOME
  if (dshHome) return join(dshHome, 'mnemon')
  throw new Error('Cannot locate the mnemon data directory: set MNEMON_DATA_DIR (or DSH_HOME).')
}

/** Run mnemon and return stdout; timeouts and non-zero exits reject. */
function runMnemon(args, timeoutMs) {
  const cli = resolveCli()
  const dataDir = resolveDataDir()
  const fullArgs = ['--data-dir', dataDir, ...args]
  return new Promise((resolve, reject) => {
    execFile(cli, fullArgs, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
      // On Windows mnemon is a .cmd batch file and PATH resolution needs a
      // shell, so shell must be enabled; otherwise spawn fails with ENOENT.
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

/** Parse output as JSON, returning the raw string when parsing fails. */
function parseLoose(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.tools.register({
    name: 'agent_memory_read',
    description:
      'Read the long-term memory of a specified agent (a named mnemon store). ' +
      'Agent memory stores are physically isolated; use this only when an explicit ' +
      'request asks to inspect a particular agent store. The agentId is the store ' +
      'name; the default store is named "default".',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Target mnemon store id, e.g. xiaoer, xiaosan, default.',
        },
        query: {
          type: 'string',
          description: 'Natural-language question or keyword to retrieve.',
        },
        mode: {
          type: 'string',
          enum: ['recall', 'keyword', 'basic'],
          description: 'recall=hybrid recall (default), keyword=keyword ranking, basic=SQL LIKE fallback.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results, default 10.',
        },
      },
      required: ['agentId', 'query'],
    },
    // dsh-tools 强制要求 output { schema, render }，缺了会在注册时抛 TypeError。
    output: MEMORY_OUTPUT,
    async execute(args) {
      const { agentId, query, mode = 'recall', limit = 10 } = args
      if (!STORE_ID_PATTERN.test(agentId)) {
        throw new Error('agentId must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
      }
      const cliArgs = ['--store', agentId]
      if (mode === 'keyword') {
        // Keyword match: mnemon search is already keyword-ranked and has no --mode.
        cliArgs.push('search', query, '--limit', String(limit))
      } else {
        // recall: graph-enhanced hybrid recall; basic flips recall to SQL LIKE.
        cliArgs.push('recall', query, '--limit', String(limit))
        if (mode === 'basic') cliArgs.push('--basic')
      }
      const stdout = await runMnemon(cliArgs, 30000)
      return {
        agentId,
        query,
        mode,
        memory: parseLoose(stdout),
      }
    },
  })

  ctx.tools.register({
    name: 'agent_memory_bootstrap',
    description:
      'Create agent memory stores (mnemon named stores) in bulk and list every ' +
      'store. Used to initialize multiple agent stores: existing stores are ' +
      'skipped and no existing memory is cleared. After creation, all stores are ' +
      'pushed by the dsh-mnemon Git sync without per-store configuration.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of store names to create, e.g. ["xiaoer","xiaosan","xiaosi","xiaowu"].',
        },
      },
      required: ['agents'],
    },
    // 同上：bootstrap 也必须声明 output，否则注册即抛 TypeError。
    output: MEMORY_OUTPUT,
    async execute(args) {
      const { agents } = args
      const created = []
      const skipped = []
      for (const agentId of agents) {
        if (!STORE_ID_PATTERN.test(agentId)) {
          throw new Error(`Invalid store name: ${agentId}, must match [a-zA-Z0-9][a-zA-Z0-9_-]*`)
        }
        const dbPath = join(resolveDataDir(), 'data', agentId, 'mnemon.db')
        if (existsSync(dbPath)) {
          skipped.push(agentId)
          continue
        }
        await runMnemon(['store', 'create', agentId], 30000)
        created.push(agentId)
      }
      const listOut = parseLoose(await runMnemon(['store', 'list'], 15000))
      return { created, skipped, stores: listOut }
    },
  })
}
