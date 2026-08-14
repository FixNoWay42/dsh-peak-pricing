import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as peakPricing from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

/** Records the model each request was served under, then streams one text block. */
class RecordingAdapter extends LlmAdapter {
  servedModels: string[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.servedModels.push(options.model)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'served' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'served' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.useRealTimers()
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-peak-pricing-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-peak-pricing', peakPricing],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves the peak preset model during a peak window and the default model off-peak', { timeout: 60_000 }, async () => {
    // 2026-08-17 01:30 UTC = 09:30 Beijing — inside the default 09:00-12:00 peak window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T01:30:00Z'))

    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-peak-pricing'",
      '  config:',
      '    peak:',
      '      provider: mock',
      "      model: 'peak-chat'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)

    const adapter = new RecordingAdapter()
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = loaded.agentLoop.create(SessionId('loader-peak'), { provider: 'mock', model: 'default' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.servedModels).toEqual(['peak-chat'])
    // The switched model is the logged request header — model-visible ⟺ logged.
    expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'mock', model: 'peak-chat' })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'served' }],
    })

    // 2026-08-17 05:30 UTC = 13:30 Beijing — off-peak; a fresh agent keeps the default model.
    vi.setSystemTime(new Date('2026-08-17T05:30:00Z'))
    const offPeakAgent = loaded.agentLoop.create(SessionId('loader-off-peak'), { provider: 'mock', model: 'default' })
    offPeakAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await offPeakAgent.whenIdle()

    expect(adapter.servedModels).toEqual(['peak-chat', 'default'])
    expect(offPeakAgent.session.requestHeader()?.config).toMatchObject({ provider: 'mock', model: 'default' })
  })
})
