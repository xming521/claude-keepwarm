import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let fixtureId = 0
const flush = () => new Promise(resolve => setImmediate(resolve))

async function fixture(options = {}) {
  const url = new URL('../plugins/keepwarm/hooks/keepwarm.ts', import.meta.url)
  url.searchParams.set('fixture', String(fixtureId++))
  const { register } = await import(url.href)
  const hooks = new Map()
  const timers = []
  const writes = []
  const calls = []
  let now = 1_000_000
  let killed = false
  let cache = options.cache
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
  if (options.margin !== undefined) env.set('KEEPWARM_CACHE_MARGIN_MIN', String(options.margin))
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
    fs: {
      exists: async () => killed,
      read: async () => {
        if (cache === undefined) throw new Error('ENOENT')
        return JSON.stringify(cache)
      },
      write: async (_, text) => writes.push(JSON.parse(text)),
    },
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
    get now() { return now },
    set cache(value) { cache = value },
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

test('cache mode follows expiry minus five minutes even just after startup', async () => {
  const expires = 1000 + 13 * 60 + 17
  const f = await fixture({ margin: 5, cache: {
    caching_observed: true, warm: true, ttl: '1h', expires_at: expires,
  } })
  assert.equal(f.state.schedule, 'cache-expiry')
  assert.equal(f.state.nextBumpAt, expires - 300)
  await f.emit('turn.start')
  await f.emit('turn.complete')
  assert.equal(f.state.nextBumpAt, expires - 300)
  await f.tick(8)
  assert.equal(f.calls.length, 0)
  await f.tick(17 / 60)
  assert.equal(f.calls.length, 1)
  assert.equal(f.state.bumps, 1)
})

test('a refreshed cache deadline postpones the next keepalive', async () => {
  const f = await fixture({ margin: 5, cache: {
    caching_observed: true, warm: true, ttl: '1h', expires_at: 1000 + 797,
  } })
  await f.tick(5)
  const expires = f.now / 1000 + 3600
  f.cache = { caching_observed: true, warm: true, ttl: '1h', expires_at: expires }
  await f.tick(3 + 17 / 60)
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.nextBumpAt, expires - 300)
})

test('cache mode waits for a snapshot instead of using the idle interval', async () => {
  const f = await fixture({ margin: 5 })
  assert.equal(f.state.nextBumpAt, null)
  await f.tick(50)
  assert.equal(f.calls.length, 0)
  assert.match((await f.emit('command.run', { args: 'status' })).text, /cache expiry/)
  const expires = f.now / 1000 + 797
  f.cache = { caching_observed: true, warm: true, ttl: '1h', expires_at: expires }
  await f.tick(0)
  assert.equal(f.state.nextBumpAt, expires - 300)
})

test('an expired cache is not rebuilt by a late tick', async () => {
  const f = await fixture({ margin: 5, cache: {
    caching_observed: true, warm: true, ttl: '1h', expires_at: 1000 + 60,
  } })
  await f.tick(2)
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.cold, true)
})

test('the observed five-minute TTL is used instead of the configured hour', async () => {
  const f = await fixture({ margin: 1, cache: {
    caching_observed: true, warm: true, ttl: '5m', expires_at: 1000 + 300,
  } })
  await f.tick(3)
  assert.equal(f.calls.length, 0)
  await f.tick(1)
  assert.equal(f.calls.length, 1)
})

test('the cache bridge writes only cache fields and preserves unchanged snapshots', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'keepwarm-cache-'))
  const script = new URL('../plugins/keepwarm/scripts/write-cache.sh', import.meta.url).pathname
  const cache = { caching_observed: true, warm: true, ttl: '1h', expires_at: 1791500000 }
  const input = JSON.stringify({ session_id: 'test-session', prompt_cache: cache, messages: ['sample message'] })
  try {
    const run = () => spawnSync('bash', [script], { input, encoding: 'utf8', env: { ...process.env, HOME: testHome } })
    assert.equal(run().status, 0)
    const file = join(testHome, '.claude/keepwarm/cache/test-session.json')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), cache)
    const before = statSync(file)
    assert.equal(before.mode & 0o777, 0o600)
    assert.equal(run().status, 0)
    assert.equal(statSync(file).mtimeMs, before.mtimeMs)
  } finally {
    rmSync(testHome, { recursive: true })
  }
})
