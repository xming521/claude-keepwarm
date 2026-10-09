import assert from 'node:assert/strict'
import test from 'node:test'

let fixtureId = 0
const flush = () => new Promise(resolve => setImmediate(resolve))

async function fixture() {
  const url = new URL('../plugins/keepwarm/hooks/keepwarm.ts', import.meta.url)
  url.searchParams.set('fixture', String(fixtureId++))
  const { register } = await import(url.href)
  const hooks = new Map()
  const timers = []
  const writes = []
  const calls = []
  let now = 1_000_000
  let killed = false
  let response = () => ({
    isAnswered: true,
    usage: { cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
  })
  const env = new Map([
    ['HOME', '/test'],
    ['KEEPWARM_INTERVAL_MIN', '50'],
    ['KEEPWARM_PING_TEXT', 'custom keepalive prompt'],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
  ])
  const $ = {
    env: {
      get: async key => env.get(key),
      set: async (key, value) => value === undefined ? env.delete(key) : env.set(key, value),
    },
    clock: {
      now: async () => now,
      every(period, callback) {
        const timer = { period, callback, cancelled: false, cancel() { this.cancelled = true } }
        timers.push(timer)
        return timer
      },
    },
    session: { id: async () => 'test-session', usage: async () => ({ context: { tokens: 40_000 } }) },
    fs: { exists: async () => killed, write: async (_, text) => writes.push(JSON.parse(text)) },
    ui: { log: async () => {} },
    command: { register: async () => {} },
    model: { fork: async prompt => { calls.push(prompt); return response() } },
  }
  register((event, filter, handler) => hooks.set(event, handler ?? filter))
  const emit = async (event, payload = {}) => {
    const result = await hooks.get(event)($, payload, async value => value)
    await flush()
    return result
  }
  await emit('session.start')
  return {
    emit, timers, calls, env,
    get state() { return writes.at(-1) },
    set killed(value) { killed = value },
    set response(value) { response = value },
    async tick(minutes = 50) {
      now += minutes * 60_000
      const timer = timers.at(-1)
      if (!timer.cancelled) timer.callback()
      await flush()
    },
  }
}

test('main-thread messages reset the budget and restart the idle period', async () => {
  const f = await fixture()
  assert.equal(f.timers[0].period, 60_000)
  for (let i = 0; i < 3; i++) await f.tick()
  assert.equal(f.state.bumps, 3)
  await f.emit('turn.start', { agentId: 'child' })
  await f.emit('turn.complete', { agentId: 'child' })
  assert.equal(f.state.bumps, 3)
  await f.emit('turn.start')
  assert.equal(f.state.bumps, 0)
  await f.tick()
  assert.equal(f.calls.length, 3)
  await f.emit('turn.complete')
  await f.tick(49)
  assert.equal(f.calls.length, 3)
  await f.tick(1)
  assert.equal(f.state.bumps, 1)
  assert.equal(f.calls.at(-1).prompt, 'custom keepalive prompt')
  assert.equal(f.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'), '1')
  assert.equal(f.env.has('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'), false)
})

test('a new main-thread turn re-arms the timer after the bump limit', async () => {
  const f = await fixture()
  for (let i = 0; i < 8; i++) await f.tick()
  await f.tick()
  assert.equal(f.state.state, 'stopped')
  assert.equal(f.state.bumps, 8)
  assert(f.timers[0].cancelled)
  assert.match((await f.emit('command.run', { args: 'resume' })).text, /send a new message/)
  await f.emit('turn.start')
  assert.equal(f.state.state, 'active')
  assert.equal(f.state.bumps, 0)
  assert.equal(f.timers.length, 2)
  await f.emit('turn.complete')
  await f.tick()
  assert.equal(f.state.bumps, 1)
})

test('messages preserve a manual pause', async () => {
  const f = await fixture()
  await f.tick()
  await f.emit('command.run', { args: 'pause' })
  await f.emit('turn.start')
  await f.emit('turn.complete')
  assert.equal(f.state.state, 'paused')
  assert.equal(f.state.bumps, 0)
  await f.tick()
  assert.equal(f.calls.length, 1)
  await f.emit('command.run', { args: 'resume' })
  await f.tick(0)
  assert.equal(f.state.bumps, 1)
})

for (const reason of ['kill', 'api-error', 'rebuild']) {
  test(`messages preserve a stop caused by ${reason}`, async () => {
    const f = await fixture()
    if (reason === 'kill') f.killed = true
    if (reason === 'api-error') f.response = () => ({
      isAnswered: false, reason: 'api-error', status: 500, error: 'test',
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    if (reason === 'rebuild') f.response = () => ({
      isAnswered: true,
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000 },
    })
    await f.tick()
    if (reason === 'api-error') { await f.tick(0); await f.tick(0) }
    assert.equal(f.state.state, 'stopped')
    const count = f.calls.length
    await f.emit('turn.start')
    await f.emit('turn.complete')
    await f.tick()
    assert.equal(f.state.state, 'stopped')
    assert.equal(f.calls.length, count)
    assert.equal(f.timers.length, 1)
  })
}

test('an in-flight bump does not consume the budget reset by a new message', async () => {
  const f = await fixture()
  let resolve
  f.response = () => new Promise(done => { resolve = done })
  await f.tick()
  await f.emit('turn.start')
  resolve({ isAnswered: true, usage: { cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 } })
  await flush()
  assert.equal(f.state.bumps, 0)
})
