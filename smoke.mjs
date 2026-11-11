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
const publish = process.env.PROOF !== 'false'

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

let id, app
let ready = false
let failure = ''
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

  app = await call(`/v1/phones/${id}/apps?grant_permissions=true`, 'POST', await readFile(apk))
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
  if (bad?.error?.code === 'wait_timeout') failure = `"${waitFor}" did not appear within ${timeout} s`
  else if (bad) failure = `${bad.error?.code ?? 'action_failed'}: ${bad.error?.message ?? ''}`
  else if (!waitFor && result.screen.app !== app.package) failure = `${app.package} is not in the foreground (shows ${result.screen.app}): did it crash on launch?`
  if (failure) throw new Error(`${failure}\nScreen:\n${result.screen.text}`)
  passed = true
  console.log(`Smoke passed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${app.package} ${waitFor ? `shows "${waitFor}"` : 'is open'}`)
} catch (error) {
  failure ||= error.message.split('\n')[0]
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
    if (publish && app) await proof().catch(error => console.log(`Proof not published: ${error.message}`)) // never changes the verdict
  }
  try {
    await cleanup()
  } catch (cleanupError) {
    console.error(`Cleanup failed; delete ${id} from the dashboard:`, cleanupError)
    process.exitCode = 1
  }
}

// The run's public proof (mobilebox.dev/proof/…, unlisted): what it checked, the steps, the last screen, time and cost.
// The job summary always shows it; on a pull request it is one PR comment, updated on every push.
async function proof() {
  const title = `${app.package} ${waitFor ? `shows "${waitFor}"` : 'opens'}`.slice(0, 120)
  const steps = [`Installed ${app.package} ${app.version_name ?? ''}`.trim(), 'Opened the app',
    ...(failure ? [failure] : [waitFor ? `Saw "${waitFor}"` : 'The app stayed in the foreground'])]
  const { url, markdown } = await call(`/v1/phones/${id}/proofs`, 'POST', { title, status: passed ? 'passed' : 'failed', steps })
  output('proof-url', url)
  console.log(`Proof: ${url}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  await comment(markdown)
}

// One comment per PR and artifact name, edited in place. Without a token that may write (fork PRs, read-only
// permissions) it is skipped quietly: the proof is still in the job summary.
async function comment(markdown) {
  const { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env
  if (!token || !repo || !eventPath || !['pull_request', 'pull_request_target'].includes(event)) return
  const number = JSON.parse(await readFile(eventPath, 'utf8')).pull_request?.number
  if (!number) return
  const marker = `<!-- android-smoke-action:${process.env.ARTIFACT_NAME || 'android-smoke-screenshot'} -->`
  const github = (path, method = 'GET', body) => fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': userAgent, 'X-GitHub-Api-Version': '2022-11-28' },
  })
  const list = await github(`/repos/${repo}/issues/${number}/comments?per_page=100`)
  const existing = list.ok ? (await list.json()).find(c => c.body?.startsWith(marker)) : undefined
  const body = { body: `${marker}\n${markdown}` }
  const sent = await (existing ? github(`/repos/${repo}/issues/comments/${existing.id}`, 'PATCH', body) : github(`/repos/${repo}/issues/${number}/comments`, 'POST', body))
  if (sent.ok) console.log(`Proof ${existing ? 'updated on' : 'posted to'} PR #${number}`)
  else if (sent.status === 403 || sent.status === 404) console.log('Proof not posted to the PR: this token cannot comment (add permissions: pull-requests: write)')
  else console.log(`Proof not posted to the PR: GitHub answered ${sent.status}`)
}
