import type { Register } from 'claude-code'

// Claude delegates work to pi subagents that run on the Codex account pool
// (the codex-accounts pi extension), which switches ChatGPT accounts itself.
const TOOL = 'codex_subagent'
const DEFAULT_MODEL = 'gpt-6-luna'
const READ_ONLY_TOOLS = 'read,grep,find,ls'
const MAX_OUTPUT = 60_000

let running = 0

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

type PoolState = { accounts?: Record<string, { lastUsedAt?: number | null; email?: string | null }> }

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
type Prefs = { model?: string; thinking?: string }
// Saved with pi's files (not Claude's), so the defaults outlive Claude account switches.
const prefsPath = async ($: any) => `${(await $.env.get('HOME')) ?? ''}/.pi/agent/claude-subagents/defaults.json`
const readPrefs = async ($: any): Promise<Prefs> => {
  try {
    const p = JSON.parse(await $.fs.read(await prefsPath($)))
    return {
      ...(typeof p.model === 'string' && p.model ? { model: p.model } : {}),
      ...(EFFORTS.includes(p.thinking) ? { thinking: p.thinking } : {}),
    }
  } catch {
    return {}
  }
}

// The Codex models the pool serves, from pi itself.
const poolModels = async ($: any, pi: string): Promise<string[]> => {
  let out = ''
  for await (const piece of $.process.spawn({ argv: [pi, '--list-models', 'codex-pool'] })) out += piece.text
  return out
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols[0] === 'codex-pool' && cols[1])
    .map(cols => cols[1])
}

const findPi = async ($: any): Promise<string | undefined> => {
  const home = (await $.env.get('HOME')) ?? ''
  const override = await $.env.get('PI_SUBAGENT_BIN')
  for (const candidate of [override, `${home}/.bun/bin/pi`, '/opt/homebrew/bin/pi', '/usr/local/bin/pi']) {
    if (!candidate) continue
    try {
      await $.fs.stat(candidate)
      return candidate
    } catch {}
  }
  return undefined
}

// Runs one of the codex-accounts extension's commands with `pi -p`, where the
// extension prints its answer. `reset` is always given --dry-run or --yes.
const runPoolCommand = async ($: any, pi: string, command: string): Promise<string> => {
  const argv = [pi, '-p', '--no-session', '--provider', 'codex-pool', '--model', DEFAULT_MODEL, command]
  let stdout = ''
  let stderr = ''
  for await (const piece of $.process.spawn({ argv })) {
    if (piece.stream === 'stdout') stdout += piece.text
    else stderr += piece.text
  }
  return stdout.trim() || stderr.trim().slice(-2000) || 'pi printed nothing.'
}

// (Re)declares the subagent tool; its schema names the current saved defaults.
const registerTool = async ($: any, prefs: Prefs) => {
  await $.tool.register({
    name: TOOL,
    description: [
      'Spawn a Codex subagent: pi running on your ChatGPT accounts through the codex-pool provider, which switches accounts automatically when one hits its limit.',
      'Use it to delegate self-contained work (research, review, focused edits). Call it several times in one message to run subagents in parallel.',
      'The subagent cannot see this conversation: put every needed detail, path and constraint in `task`, and say what to report back.',
      'access "read-only" (default) allows read/grep/find/ls; "edit" also allows bash, edit and write in `cwd`, without sandbox, so use it only for work you intend to apply.',
      'Returns the subagent\'s final answer and a session_id; pass session_id with a new task to continue that subagent.',
      'This tool blocks until the subagent finishes. For long work, or to keep working meanwhile, run the same subagent as a background job instead:',
      'Bash with run_in_background: true and the command `codex-subagent [--model M] [--effort E] [--access edit] [--cwd DIR] [--session ID] [--timeout MIN] --task-file FILE` (or the task on stdin).',
      'It uses the same pool, accounts and saved defaults; you are notified with its answer when it exits, it shows in the task list and can be stopped like any background task, and --session continues it later.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instructions, including what to report back.' },
        cwd: { type: 'string', description: 'Folder the subagent works in (default: this session\'s folder).' },
        access: { type: 'string', enum: ['read-only', 'edit'], description: 'Default read-only.' },
        model: {
          type: 'string',
          description: `Codex model (default ${prefs.model ?? DEFAULT_MODEL}); e.g. gpt-6.1-sol, gpt-6-astra, gpt-5.6-terra. Accounts whose plan lacks it are skipped. Leave it out to use the person's saved default.`,
        },
        thinking: { type: 'string', enum: EFFORTS, description: `Reasoning effort (default ${prefs.thinking ?? 'medium'}). Leave it out to use the person's saved default.` },
        session_id: { type: 'string', description: 'Continue an earlier subagent instead of starting fresh.' },
        timeout_minutes: { type: 'number', description: 'Stop the subagent after this long (default 30, max 120).' },
      },
      required: ['task'],
    },
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'codex-accounts',
      description: 'Codex pool (pi): accounts, usage, banked resets',
      argumentHint: '[refresh | resets | reset codex-N [confirm] | cutoff <percent> | slots <n>]',
    })
    await registerTool($, await readPrefs($))
    await $.command.register({
      name: 'codex-subagent',
      description: 'Default model and effort for Codex (pi) subagents',
      argumentHint: '[<model>] [<effort>] | reset',
    })
    return started
  })

  on('command.run', { command: 'codex-accounts' }, async ($, e) => {
    const pi = await findPi($)
    if (!pi) return { text: 'pi was not found. Install it (bun i -g @earendil-works/pi-coding-agent) or set PI_SUBAGENT_BIN.' }
    const words = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const [cmd, slot, confirm] = words
    if (cmd !== 'reset') return { text: await runPoolCommand($, pi, `/codex-accounts ${words.join(' ')}`.trim()) }
    if (!slot)
      return {
        text: `${await runPoolCommand($, pi, '/codex-accounts resets')}\n\nPick an account: /codex-accounts reset codex-N`,
      }
    const id = /^\d+$/.test(slot) ? `codex-${slot}` : slot
    if (confirm !== 'confirm') {
      const preview = await runPoolCommand($, pi, `/codex-accounts reset ${id} --dry-run`)
      return { text: preview.startsWith('Spend a banked reset') ? `${preview}\n\nTo spend it: /codex-accounts reset ${id} confirm` : preview }
    }
    return { text: await runPoolCommand($, pi, `/codex-accounts reset ${id} --yes`) }
  })

  on('command.run', { command: 'codex-subagent' }, async ($, e) => {
    const words = (e.args ?? '').trim().split(/\s+/).filter(w => w && w !== 'model' && w !== 'effort' && w !== 'thinking')
    const prefs = await readPrefs($)
    const show = (p: Prefs, lead: string) =>
      `${lead}Codex subagents use ${p.model ?? DEFAULT_MODEL} at ${p.thinking ?? 'medium'} effort` +
      `${p.model || p.thinking ? '' : ' (built-in defaults)'}. Claude can still pick another per task.`
    if (!words.length)
      return { text: `${show(prefs, '')}\nChange: /codex-subagent <model> <effort> (efforts: ${EFFORTS.join(', ')}); /codex-subagent reset` }
    let next: Prefs = { ...prefs }
    if (words.length === 1 && words[0] === 'reset') next = {}
    else {
      const pi = await findPi($)
      for (const word of words) {
        if (EFFORTS.includes(word)) {
          next.thinking = word
          continue
        }
        if (!pi) return { text: 'pi was not found, so the model cannot be checked.' }
        const models = await poolModels($, pi)
        if (!models.includes(word))
          return { text: `${word} is not a codex-pool model. Available: ${models.join(', ') || 'none (is the codex-accounts extension installed?)'}` }
        next.model = word
      }
    }
    await $.fs.write(await prefsPath($), JSON.stringify(next, null, 2) + '\n')
    await registerTool($, next)
    return { text: show(next, 'Saved. ') }
  })

  on('tool.call', { tool: 'mcp__pi-subagents__codex_subagent' }, async ($, e) => {
    const input = e as unknown as {
      task?: string
      cwd?: string
      access?: string
      model?: string
      thinking?: string
      session_id?: string
      timeout_minutes?: number
    }
    if (!input.task?.trim()) return { deny: 'Give the subagent a task.' }
    const home = (await $.env.get('HOME')) ?? ''
    const pi = await findPi($)
    if (!pi) return { deny: 'pi was not found. Install it (bun i -g @earendil-works/pi-coding-agent) or set PI_SUBAGENT_BIN.' }

    const session = input.session_id?.trim() || uuid()
    const prefs = await readPrefs($)
    const model = input.model?.trim() || prefs.model || DEFAULT_MODEL
    const thinking = input.thinking || prefs.thinking || 'medium'
    const edit = input.access === 'edit'
    const argv = [
      pi,
      '-p',
      '--provider', 'codex-pool',
      '--model', model,
      '--thinking', thinking,
      '--session-dir', `${home}/.pi/agent/claude-subagents`,
      '--session-id', session,
      ...(edit ? [] : ['--tools', READ_ONLY_TOOLS]),
    ]
    const statePath = `${home}/.pi/agent/codex-accounts.json`
    const readState = async (): Promise<PoolState> => {
      try {
        return JSON.parse(await $.fs.read(statePath))
      } catch {
        return {}
      }
    }
    const before = await readState()
    const limitMs = Math.min(120, Math.max(1, input.timeout_minutes ?? 30)) * 60_000
    const started = Date.now()

    running++
    $.ui.status(`pi subagents: ${running} running`)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let code: number | null = null
    try {
      // The task goes over stdin, so text starting with "@" or "-" is never read as a flag or file.
      const child = $.process.spawn({ argv, cwd: input.cwd, input: input.task })
      for await (const piece of child) {
        if (piece.stream === 'stdout') stdout += piece.text
        else stderr += piece.text
        if (Date.now() - started > limitMs) {
          timedOut = true
          break // leaving the loop stops the child
        }
      }
      if (!timedOut) code = (await child.result).code
    } catch (error) {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`
    } finally {
      running--
      $.ui.status(running ? `pi subagents: ${running} running` : undefined)
    }

    // Which pool account served it, from the pool's own record.
    const after = await readState()
    const served = Object.entries(after.accounts ?? {})
      .filter(([id, a]) => (a.lastUsedAt ?? 0) > (before.accounts?.[id]?.lastUsedAt ?? 0))
      .map(([id, a]) => (a.email ? `${id} (${a.email})` : id))
    const minutes = ((Date.now() - started) / 60_000).toFixed(1)
    const footer = `\n\n[pi subagent · ${model} · ${edit ? 'edit' : 'read-only'} · ${served.length ? `account ${served.join(', ')}` : 'account unknown'} · ${minutes} min · session_id ${session}]`
    const answer = stdout.trim()
    if (timedOut)
      return { result: `${answer || '(no answer yet)'}\n\nStopped after ${minutes} minutes (timeout).${footer}` }
    if (code !== 0 || !answer)
      return {
        result: `The subagent failed${code === null ? '' : ` (exit ${code})`}:\n${(stderr.trim() || answer || 'no output').slice(-4000)}${footer}`,
      }
    return {
      result:
        (answer.length > MAX_OUTPUT ? `${answer.slice(0, MAX_OUTPUT)}\n…(${answer.length - MAX_OUTPUT} more characters cut)` : answer) +
        footer,
    }
  })
}
