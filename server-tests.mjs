import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await rm(dataDir, { recursive: true, force: true })
})

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

test('accounts authenticate and passwords are not returned', async () => {
  const { response, body } = await json('/api/auth/register', {
    method: 'POST',
    body: { username: 'artem', password: 'secure-password-123' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(body.user.username, 'artem')
  assert.equal('passwordHash' in body.user, false)
  assert.equal(response.headers.get('set-cookie').includes('HttpOnly'), true)

  const cookie = response.headers.get('set-cookie').split(';')[0]
  const token = cookie.split('=')[1]
  const storedAccounts = await readFile(join(dataDir, 'accounts.json'), 'utf8')
  assert.equal(storedAccounts.includes(token), false)
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

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server = await createApiServer({ dataDir, serveStatic: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
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
