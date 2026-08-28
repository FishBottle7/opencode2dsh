import test from 'node:test'
import assert from 'node:assert/strict'
import { toPiAiModels, registerProvider, providerBaseURL, type DshSeams } from '../src/provider.ts'

test('toPiAiModels parses OpenAI-shaped payloads and dedupes', () => {
  const parsed = toPiAiModels({
    data: [
      { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
      { id: 'gpt-oss-120b' }, // duplicate id dropped
      { id: '' }, // empty id dropped
      { nope: 1 }, // no id dropped
      null, // non-object dropped
      { id: 'free-x' }, // missing name falls back to id
    ],
  })
  assert.deepEqual(parsed, [
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'free-x', name: 'free-x' },
  ])
  assert.deepEqual(toPiAiModels(undefined), [])
  assert.deepEqual(toPiAiModels({}), [])
  assert.deepEqual(toPiAiModels({ data: 'nope' }), [])
})

test('registerProvider stores token and writes the llm-pi-ai route', async () => {
  const calls = { credentials: [] as Array<[string, string]>, ops: [] as unknown[] }
  const seams: DshSeams = {
    credentials: {
      set: async (ref, value) => {
        calls.credentials.push([ref, value])
      },
    },
    settings: {
      get: () => undefined,
      mutate: async (_ns, ops) => {
        calls.ops.push({ ns: _ns, ops })
      },
    },
    logger: { info: () => {}, warn: () => {} },
  }
  await registerProvider(
    seams,
    { providerId: 'opencode2dsh', apiKeyEnv: 'OPENCODE2DSH_TOKEN', port: 4567 },
    'tok',
    [{ id: 'm1', name: 'M1' }],
  )
  assert.deepEqual(calls.credentials, [['OPENCODE2DSH_TOKEN', 'tok']])
  assert.equal(calls.ops.length, 1)
  const first = calls.ops.at(0)
  assert.ok(first, 'expected one mutate call')
  const op = first as { ns: string; ops: Array<{ op: string; path: string[]; value: Record<string, unknown> }> }
  const setOp = op.ops.at(0)
  assert.ok(setOp, 'expected one set op')
  assert.equal(op.ns, 'llm-pi-ai')
  assert.equal(setOp.op, 'set')
  assert.deepEqual(setOp.path, ['providers', 'opencode2dsh'])
  assert.equal(setOp.value.baseURL, providerBaseURL(4567))
  assert.equal(setOp.value.baseURL, 'http://127.0.0.1:4567/v1')
  assert.equal(setOp.value.apiKeyEnv, 'OPENCODE2DSH_TOKEN')
  assert.equal(setOp.value.api, 'openai-completions')
  assert.deepEqual(setOp.value.models, [{ id: 'm1', name: 'M1' }])
})
