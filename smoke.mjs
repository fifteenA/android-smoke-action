// android-smoke: install an APK on a fresh Mobilebox phone, open it, wait for a text, screenshot, delete the phone.
// Node 20+, no dependencies. Runs as the action's step; also runs locally:
//
//   MOBILESANDBOX_API_KEY=... APK=app-debug.apk WAIT_FOR=Welcome node smoke.mjs
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const base = process.env.MOBILESANDBOX_URL ?? 'https://mobilebox.dev'
const { MOBILESANDBOX_API_KEY: key, APK: apk, WAIT_FOR: waitFor } = process.env
const timeout = Number(process.env.TIMEOUT || 60)
if (!key) throw new Error('Set api-key (a repository secret with your Mobilebox key)')
if (!apk) throw new Error('Set apk (path to the APK to test)')
if (!(timeout > 0)) throw new Error(`timeout must be a positive number of seconds, got "${process.env.TIMEOUT}"`)
const userAgent = `android-smoke-action/1 ${process.env.MOBILESANDBOX_USER_AGENT ?? ''}`.trim()
const shots = join(process.env.RUNNER_TEMP ?? tmpdir(), 'android-smoke')

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  else console.log(`${name}=${value}`)
}

async function call(path, method = 'GET', body, headers = {}) {
  const json = body !== undefined && !(body instanceof Uint8Array)
  let response
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': userAgent,
        ...(body === undefined ? {} : { 'Content-Type': json ? 'application/json' : 'application/octet-stream' }),
        ...headers,
      },
      body: json ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    throw Object.assign(new Error(`${method} ${path} -> ${error.message}`), { retryable: true }) // network or timeout
  }
  if (response.ok && response.headers.get('content-type')?.startsWith('image/')) return new Uint8Array(await response.arrayBuffer())
  const text = await response.text()
  if (!response.ok) {
    throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${text}`), { retryable: response.status >= 500 })
  }
  return text ? JSON.parse(text) : null
}

let id
let ready = false
let deleting
function cleanup() { // runs once, whether from finally or a signal
  deleting ??= id ? call(`/v1/phones/${id}`, 'DELETE').then(() => console.log(`Deleted ${id}`)) : Promise.resolve()
  return deleting
}
// A cancelled job sends SIGINT, then SIGTERM: delete the phone before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => cleanup().finally(() => process.exit(130)))
}

const started = Date.now()
let passed = false
try {
  // Retrying with the same Idempotency-Key returns the same phone, so a lost response cannot leak a second one.
  const idempotencyKey = crypto.randomUUID()
  let phone
  for (let attempt = 1; !phone; attempt++) {
    try {
      phone = await call('/v1/phones?wait=ready&timeout=50', 'POST', {
        name: `android-smoke-${process.env.GITHUB_RUN_ID ?? Date.now()}`, idle_timeout: 120, max_duration: 600,
      }, { 'Idempotency-Key': idempotencyKey })
    } catch (error) {
      if (attempt === 3 || !error.retryable) throw error
      await sleep(3000)
    }
  }
  id = phone.id // keep this id; never create again while it boots
  output('phone-id', id)
  const deadline = Date.now() + 180_000
  while (phone.status === 'creating' || phone.status === 'starting') {
    if (Date.now() > deadline) throw new Error('Phone not ready after 180 s')
    phone = await call(`/v1/phones/${id}?wait=ready&timeout=50`)
  }
  if (phone.status !== 'ready') throw new Error(`Phone not ready: ${JSON.stringify(phone)}`)
  ready = true

  const app = await call(`/v1/phones/${id}/apps?grant_permissions=true`, 'POST', await readFile(apk))
  console.log(`Installed ${app.package} ${app.version_name ?? ''} on ${id}`)
  let result = await call(`/v1/phones/${id}/actions`, 'POST', { actions: [
    { type: 'open_app', package: app.package },
    { type: 'wait', ms: 2000 },
  ] })
  if (waitFor) {
    // wait_for waits up to 30 s per action: repeat until the text shows or the timeout is spent.
    const until = Date.now() + timeout * 1000
    do {
      const ms = Math.max(100, Math.min(30_000, until - Date.now()))
      result = await call(`/v1/phones/${id}/actions`, 'POST', { actions: [{ type: 'wait_for', text: waitFor, timeout_ms: ms }] })
    } while (!result.results[0].ok && result.results[0].error?.code === 'wait_timeout' && Date.now() < until)
  }
  const bad = result.results.find(item => !item.ok)
  if (bad?.error?.code === 'wait_timeout') throw new Error(`"${waitFor}" did not appear within ${timeout} s. Screen:\n${result.screen.text}`)
  if (bad) throw new Error(`${JSON.stringify(bad.error)}\nScreen:\n${result.screen.text}`)
  if (!waitFor && result.screen.app !== app.package) {
    throw new Error(`${app.package} is not in the foreground (shows ${result.screen.app}): did it crash on launch?\nScreen:\n${result.screen.text}`)
  }
  passed = true
  console.log(`Smoke passed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${app.package} ${waitFor ? `shows "${waitFor}"` : 'is open'}`)
} catch (error) {
  console.error(`Smoke failed: ${error.message}`) // the message carries the screen; a stack trace adds nothing
  process.exitCode = 1
} finally {
  output('result', passed ? 'pass' : 'fail')
  if (ready) {
    try {
      const screenshot = join(shots, `${id}.png`) // one file per phone: a second call in the job keeps the first
      mkdirSync(shots, { recursive: true })
      writeFileSync(screenshot, await call(`/v1/phones/${id}/screenshot`))
      output('screenshot', screenshot)
      console.log(`Screenshot: ${screenshot}`)
    } catch (error) {
      console.error('Screenshot failed:', error.message) // never hides the smoke result
    }
  }
  try {
    await cleanup()
  } catch (cleanupError) {
    console.error(`Cleanup failed; delete ${id} from the dashboard:`, cleanupError)
    process.exitCode = 1
  }
}
