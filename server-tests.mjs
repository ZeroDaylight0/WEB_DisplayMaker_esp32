import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, scryptSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiServer } from './server.mjs'

let dataDir
let server
let baseUrl

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pixelforge-test-'))
  server = await createApiServer({ dataDir, serveStatic: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await closeServer(server)
  await rm(dataDir, { recursive: true, force: true })
})

function closeServer(instance) {
  return new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()))
}

async function json(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

async function listen(instance) {
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${instance.address().port}`
}

test('accounts authenticate and passwords are not returned', async () => {
  const { response, body } = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'artem', password: 'secure-password-123' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(body.user.username, 'artem')
  assert.equal('passwordHash' in body.user, false)
  assert.equal(response.headers.get('set-cookie').includes('HttpOnly'), true)
  assert.equal(response.headers.get('set-cookie').includes('Secure'), false, 'plain HTTP must not get a Secure cookie')

  const cookie = response.headers.get('set-cookie').split(';')[0]
  const token = cookie.split('=')[1]
  const database = new DatabaseSync(join(dataDir, 'pixelforge.sqlite'), { readOnly: true })
  const storedSession = database.prepare('SELECT tokenHash FROM sessions').get().tokenHash
  assert.notEqual(storedSession, token)
  assert.equal(storedSession, createHash('sha256').update(token).digest('hex'))
  database.close()
  assert.equal(existsSync(join(dataDir, 'accounts.json')), false)
  const me = await json('/api/auth/me', { cookie })
  assert.equal(me.body.user.id, body.user.id)

  const wrongPassword = await json('/api/auth/login', {
    method: 'POST',
    body: { username: 'artem', password: 'incorrect-password' },
  })
  assert.equal(wrongPassword.response.status, 401)

  const loggedOut = await json('/api/auth/logout', { method: 'POST', cookie })
  assert.equal(loggedOut.response.status, 200)
  const afterLogout = await json('/api/auth/me', { cookie })
  assert.equal(afterLogout.response.status, 200)
  assert.equal(afterLogout.body.user, null)
})

test('cloud projects are private to each account and persist after restart', async () => {
  const first = await json('/api/auth/login', {
    method: 'POST',
    body: { username: 'artem', password: 'secure-password-123' },
  })
  const cookie = first.response.headers.get('set-cookie').split(';')[0]
  const saved = await json('/api/projects', {
    method: 'POST',
    cookie,
    body: { project: { name: 'OLED UI', width: 128, elements: [] } },
  })
  assert.equal(saved.response.status, 201)
  const id = saved.body.project.id
  const oversizedProject = await json('/api/projects', {
    method: 'POST',
    cookie,
    body: { project: { name: 'Too large', content: 'x'.repeat(2 * 1024 * 1024) } },
  })
  assert.equal(oversizedProject.response.status, 400)

  await closeServer(server)
  server = await createApiServer({ dataDir, serveStatic: false })
  baseUrl = await listen(server)
  const persisted = await json(`/api/projects/${id}`, { cookie })
  assert.equal(persisted.body.project.document.name, 'OLED UI')

  const second = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'other-user', password: 'another-secure-password' },
  })
  const otherCookie = second.response.headers.get('set-cookie').split(';')[0]
  assert.deepEqual((await json('/api/projects', { cookie: otherCookie })).body.projects, [])
  assert.equal((await json(`/api/projects/${id}`, { cookie: otherCookie })).response.status, 404)
})

test('rejects invalid registration data and cross-site changes', async () => {
  const invalid = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'a', password: 'short' },
  })
  assert.equal(invalid.response.status, 400)

  const crossSite = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'new-user', password: 'secure-password-123' },
    headers: { origin: 'https://attacker.invalid' },
  })
  assert.equal(crossSite.response.status, 403)
})

test('keeps usernames case-insensitively unique for Unicode names', async () => {
  const first = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'Ёжик', password: 'secure-password-123' },
  })
  assert.equal(first.response.status, 200)
  const duplicate = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'ёжик', password: 'secure-password-123' },
  })
  assert.equal(duplicate.response.status, 409)
})

test('imports legacy accounts and projects once without deleting the JSON backup', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'pixelforge-migration-test-'))
  const token = 'legacy-session-token'
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const salt = 'legacy-test-salt'
  const legacy = {
    users: [{
      id: '00000000-0000-4000-8000-000000000001',
      username: 'legacy-user',
      salt,
      passwordHash: scryptSync('legacy-password-123', salt, 64).toString('hex'),
      sessions: [{ tokenHash, expiresAt: Date.now() + 60_000 }],
      projects: [{
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Legacy display',
        updatedAt: '2026-01-01T00:00:00.000Z',
        document: { name: 'Legacy display', width: 128, elements: [] },
      }],
    }],
  }
  await writeFile(join(legacyDir, 'accounts.json'), JSON.stringify(legacy))
  let migrationServer
  try {
    migrationServer = await createApiServer({ dataDir: legacyDir, serveStatic: false })
    let migrationUrl = await listen(migrationServer)
    const me = await fetch(`${migrationUrl}/api/auth/me`, { headers: { cookie: `pixelforge_session=${token}` } })
    assert.equal((await me.json()).user.username, 'legacy-user')
    const project = await fetch(`${migrationUrl}/api/projects/00000000-0000-4000-8000-000000000002`, { headers: { cookie: `pixelforge_session=${token}` } })
    assert.equal((await project.json()).project.document.name, 'Legacy display')
    await closeServer(migrationServer)

    migrationServer = await createApiServer({ dataDir: legacyDir, serveStatic: false })
    migrationUrl = await listen(migrationServer)
    const projects = await fetch(`${migrationUrl}/api/projects`, { headers: { cookie: `pixelforge_session=${token}` } })
    assert.equal((await projects.json()).projects.length, 1)
    assert.equal(JSON.parse(await readFile(join(legacyDir, 'accounts.json'), 'utf8')).users.length, 1)
  } finally {
    if (migrationServer?.listening) await closeServer(migrationServer)
    await rm(legacyDir, { recursive: true, force: true })
  }
})

test('fails clearly and preserves malformed legacy account data', async () => {
  const invalidDir = await mkdtemp(join(tmpdir(), 'pixelforge-invalid-migration-test-'))
  const legacyPath = join(invalidDir, 'accounts.json')
  await writeFile(legacyPath, '{not-json')
  try {
    await assert.rejects(
      createApiServer({ dataDir: invalidDir, serveStatic: false }),
      /Could not read legacy account data/,
    )
    assert.equal(await readFile(legacyPath, 'utf8'), '{not-json')
  } finally {
    await rm(invalidDir, { recursive: true, force: true })
  }
})

test('rejects malformed and oversized JSON request bodies', async () => {
  const malformed = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', body: '{' })
  assert.equal(malformed.status, 400)
  assert.match((await malformed.json()).error, /Invalid JSON/)

  const oversized = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(5 * 1024 * 1024 + 1),
  })
  assert.equal(oversized.status, 413)
  assert.match((await oversized.json()).error, /too large/)
})

test('serves static files without allowing path traversal', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pixelforge-static-test-'))
  const staticDir = join(fixtureDir, 'public')
  await mkdir(staticDir)
  await writeFile(join(staticDir, 'index.html'), 'PixelForge test')
  await writeFile(join(fixtureDir, 'secret.txt'), 'private')
  let staticServer
  try {
    staticServer = await createApiServer({ dataDir: join(fixtureDir, 'data'), staticDir })
    const staticUrl = await listen(staticServer)
    const home = await fetch(staticUrl)
    assert.equal(home.status, 200)
    assert.equal(await home.text(), 'PixelForge test')
    const traversal = await fetch(`${staticUrl}/%2e%2e%2fsecret.txt`)
    assert.equal(traversal.status, 403)
    const malformedPath = await fetch(`${staticUrl}/%E0%A4%A`)
    assert.equal(malformedPath.status, 400)
  } finally {
    if (staticServer?.listening) await closeServer(staticServer)
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('changes the password and signs out other sessions', async () => {
  const register = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'changer', password: 'first-password-123' },
  })
  const cookie = register.response.headers.get('set-cookie').split(';')[0]
  const other = await json('/api/auth/login', { method: 'POST', body: { username: 'changer', password: 'first-password-123' } })
  const otherCookie = other.response.headers.get('set-cookie').split(';')[0]

  const wrong = await json('/api/auth/password', { method: 'POST', cookie, body: { currentPassword: 'not-the-password', newPassword: 'second-password-123' } })
  assert.equal(wrong.response.status, 401)
  const changed = await json('/api/auth/password', { method: 'POST', cookie, body: { currentPassword: 'first-password-123', newPassword: 'second-password-123' } })
  assert.equal(changed.response.status, 200)

  assert.equal((await json('/api/auth/me', { cookie })).body.user.username, 'changer')
  assert.equal((await json('/api/auth/me', { cookie: otherCookie })).body.user, null)
  assert.equal((await json('/api/auth/login', { method: 'POST', body: { username: 'changer', password: 'first-password-123' } })).response.status, 401)
  assert.equal((await json('/api/auth/login', { method: 'POST', body: { username: 'changer', password: 'second-password-123' } })).response.status, 200)
})

test('rejects malformed project ids and lists projects newest first', async () => {
  const login = await json('/api/auth/login', { method: 'POST', body: { username: 'artem', password: 'secure-password-123' } })
  const cookie = login.response.headers.get('set-cookie').split(';')[0]
  assert.equal((await json('/api/projects/not-a-uuid', { cookie })).response.status, 404)
  assert.equal((await json('/api/projects/00000000-0000-4000-8000-00000000ffff', { method: 'PUT', cookie, body: { project: { name: 'x' } } })).response.status, 404)
  assert.equal((await json('/api/projects', { method: 'POST', cookie, body: { project: { name: '   ' } } })).response.status, 400)
  await json('/api/projects', { method: 'POST', cookie, body: { project: { name: 'Newest' } } })
  const list = await json('/api/projects', { cookie })
  assert.equal(list.body.projects[0].name, 'Newest')
})

test('registration can be disabled and secure cookies can be forced', async () => {
  const closedDir = await mkdtemp(join(tmpdir(), 'pixelforge-closed-test-'))
  let closedServer
  try {
    closedServer = await createApiServer({ dataDir: closedDir, serveStatic: false, allowRegistration: false, secureCookies: true })
    const closedUrl = await listen(closedServer)
    const config = await (await fetch(`${closedUrl}/api/config`)).json()
    assert.equal(config.allowRegistration, false)
    const register = await fetch(`${closedUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'secure-password-123' }),
    })
    assert.equal(register.status, 403)
    const logout = await fetch(`${closedUrl}/api/auth/logout`, { method: 'POST' })
    assert.match(logout.headers.get('set-cookie'), /; Secure/)
  } finally {
    if (closedServer?.listening) await closeServer(closedServer)
    await rm(closedDir, { recursive: true, force: true })
  }
})

test('static responses carry security headers and support HEAD', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pixelforge-headers-test-'))
  const staticDir = join(fixtureDir, 'public')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<!doctype html>')
  await writeFile(join(staticDir, 'assets', 'app-123.js'), 'console.log(1)')
  let staticServer
  try {
    staticServer = await createApiServer({ dataDir: join(fixtureDir, 'data'), staticDir })
    const staticUrl = await listen(staticServer)
    const home = await fetch(staticUrl)
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(home.headers.get('x-frame-options'), 'DENY')
    assert.equal(home.headers.get('cache-control'), 'no-cache')
    const asset = await fetch(`${staticUrl}/assets/app-123.js`, { method: 'HEAD' })
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control'), /immutable/)
    assert.equal(await asset.text(), '')
    assert.equal((await fetch(`${staticUrl}/assets`)).status, 404)
    assert.equal((await fetch(`${staticUrl}/index.html`, { method: 'POST' })).status, 405)
  } finally {
    if (staticServer?.listening) await closeServer(staticServer)
    await rm(fixtureDir, { recursive: true, force: true })
  }
})
