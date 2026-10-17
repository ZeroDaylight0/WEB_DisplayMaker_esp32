import { createHash as sha256, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const scrypt = promisify(scryptCallback)
const root = fileURLToPath(new URL('.', import.meta.url))
const maxBodyBytes = 5 * 1024 * 1024
const sessionAge = 7 * 24 * 60 * 60 * 1000

function reply(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(value))
}

async function requestBody(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > maxBodyBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
  }
  try {
    return JSON.parse(body)
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { status: 400 })
  }
}

function cookieValue(header, name) {
  const item = (header ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))
  return item ? item.slice(name.length + 1) : undefined
}

function safeUsername(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_.-]{3,32}$/u.test(value.trim())
}

function publicUser(user) {
  return { id: user.id, username: user.username }
}

function hashToken(token) {
  return sha256('sha256').update(token).digest('hex')
}

export async function createApiServer({ dataDir = join(root, 'data'), staticDir = join(root, 'dist'), serveStatic = true } = {}) {
  const loginAttempts = new Map()
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  const databasePath = join(dataDir, 'pixelforge.sqlite')
  const database = new Database(databasePath, { timeout: 5000 })
  await chmod(databasePath, 0o600)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      usernameKey TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      passwordHash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_userId ON sessions(userId);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_userId_updatedAt ON projects(userId, updatedAt);
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const legacyPath = join(dataDir, 'accounts.json')
  const legacyMigration = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get('accounts_json_imported')
  if (!legacyMigration) {
    let legacy
    try {
      legacy = JSON.parse(await readFile(legacyPath, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        database.close()
        throw new Error(`Could not read legacy account data at ${legacyPath}: ${error.message}`, { cause: error })
      }
    }
    if (legacy !== undefined) {
      if (!legacy || !Array.isArray(legacy.users)) {
        database.close()
        throw new Error(`Legacy account data at ${legacyPath} has an invalid format.`)
      }
      const insertUser = database.prepare('INSERT INTO users (id, username, usernameKey, salt, passwordHash) VALUES (?, ?, ?, ?, ?)')
      const insertSession = database.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)')
      const insertProject = database.prepare('INSERT INTO projects (id, userId, name, updatedAt, document) VALUES (?, ?, ?, ?, ?)')
      const now = Date.now()
      try {
        database.transaction(() => {
          for (const user of legacy.users) {
            if (typeof user.id !== 'string' || typeof user.username !== 'string' || typeof user.salt !== 'string' || typeof user.passwordHash !== 'string') {
              throw new Error('Legacy account data contains an invalid user record.')
            }
            insertUser.run(user.id, user.username, user.username.toLowerCase(), user.salt, user.passwordHash)
            for (const session of user.sessions ?? []) {
              if (typeof session.tokenHash === 'string' && Number.isFinite(session.expiresAt) && session.expiresAt > now) {
                insertSession.run(session.tokenHash, user.id, session.expiresAt)
              }
            }
            for (const project of user.projects ?? []) {
              if (typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.updatedAt !== 'string') {
                throw new Error(`Legacy account ${user.username} contains an invalid project record.`)
              }
              insertProject.run(project.id, user.id, project.name, project.updatedAt, JSON.stringify(project.document ?? project))
            }
          }
          database.prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)').run('accounts_json_imported', new Date().toISOString())
        })()
      } catch (error) {
        database.close()
        throw new Error(`Could not migrate legacy account data from ${legacyPath}: ${error.message}`, { cause: error })
      }
    }
  }

  database.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now())
  const userByUsername = database.prepare('SELECT id, username, salt, passwordHash FROM users WHERE usernameKey = ?')
  const userBySession = database.prepare(`
    SELECT users.id, users.username, users.salt, users.passwordHash
    FROM sessions JOIN users ON users.id = sessions.userId
    WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?
  `)

  const authenticate = (request) => {
    const token = cookieValue(request.headers.cookie, 'pixelforge_session')
    if (!token) return undefined
    return userBySession.get(hashToken(token), Date.now())
  }

  const rejectCrossSiteMutation = (request, response) => {
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return false
    const origin = request.headers.origin
    const host = request.headers.host
    let originHost
    try {
      if (origin) originHost = new URL(origin).host
    } catch {
      reply(response, 403, { error: 'Cross-site request rejected.' })
      return true
    }
    if (originHost && originHost !== host || request.headers['sec-fetch-site'] === 'cross-site') {
      reply(response, 403, { error: 'Cross-site request rejected.' })
      return true
    }
    return false
  }

  const handler = async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (!pathname.startsWith('/api/')) {
        if (!serveStatic) {
          reply(response, 404, { error: 'Not found.' })
          return
        }
        let requested
        try {
          requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
        } catch {
          reply(response, 400, { error: 'Invalid URL path.' })
          return
        }
        const staticRoot = resolve(staticDir)
        const filename = resolve(staticRoot, `.${requested}`)
        const relativePath = relative(staticRoot, filename)
        if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
          response.writeHead(403).end()
          return
        }
        try {
          const file = await readFile(filename)
          const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[extname(filename)] ?? 'application/octet-stream'
          response.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' }).end(file)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          response.writeHead(404).end()
        }
        return
      }

      if (rejectCrossSiteMutation(request, response)) return
      if (request.method === 'GET' && pathname === '/api/health') {
        reply(response, 200, { ok: true })
        return
      }

      if (request.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
        const ip = request.socket.remoteAddress ?? 'unknown'
        const attemptKey = `${ip}:${pathname}`
        const attempts = loginAttempts.get(attemptKey) ?? []
        const cutoff = Date.now() - 60_000
        const activeAttempts = attempts.filter((timestamp) => timestamp > cutoff)
        if (loginAttempts.size > 10_000) {
          for (const [key, timestamps] of loginAttempts) {
            if (!timestamps.some((timestamp) => timestamp > cutoff)) loginAttempts.delete(key)
          }
        }
        if (activeAttempts.length >= 10) {
          reply(response, 429, { error: 'Too many attempts. Try again in a minute.' })
          return
        }
        activeAttempts.push(Date.now())
        loginAttempts.set(attemptKey, activeAttempts)

        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !safeUsername(body.username) || typeof body.password !== 'string') {
          reply(response, 400, { error: 'Username must be 3–32 letters, numbers, dots, dashes, or underscores.' })
          return
        }
        if (body.password.length < 8 || body.password.length > 256) {
          reply(response, 400, { error: 'Password must be between 8 and 256 characters.' })
          return
        }
        const username = body.username.trim()
        const usernameKey = username.toLowerCase()
        let user = userByUsername.get(usernameKey)
        if (pathname.endsWith('/register')) {
          if (user) {
            reply(response, 409, { error: 'That username is already registered.' })
            return
          }
          const salt = randomBytes(16).toString('hex')
          const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex')
          user = { id: randomUUID(), username, salt, passwordHash }
        } else {
          const suppliedHash = user ? Buffer.from(await scrypt(body.password, user.salt, 64)) : Buffer.alloc(64)
          const storedHash = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64)
          if (!user || storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)) {
            reply(response, 401, { error: 'Invalid username or password.' })
            return
          }
        }
        const token = randomBytes(32).toString('base64url')
        const tokenHash = hashToken(token)
        try {
          database.transaction(() => {
            if (pathname.endsWith('/register')) {
              database.prepare('INSERT INTO users (id, username, usernameKey, salt, passwordHash) VALUES (?, ?, ?, ?, ?)').run(user.id, user.username, usernameKey, user.salt, user.passwordHash)
            }
            database.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)').run(tokenHash, user.id, Date.now() + sessionAge)
          })()
        } catch (error) {
          if (pathname.endsWith('/register') && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            reply(response, 409, { error: 'That username is already registered.' })
            return
          }
          throw error
        }
        const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : ''
        reply(response, 200, { user: publicUser(user) }, {
          'set-cookie': `pixelforge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionAge / 1000}${secureCookie}`,
        })
        return
      }

      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        const token = cookieValue(request.headers.cookie, 'pixelforge_session')
        const tokenHash = token ? hashToken(token) : undefined
        if (tokenHash) database.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash)
        reply(response, 200, { ok: true }, { 'set-cookie': 'pixelforge_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' })
        return
      }

      if (request.method === 'GET' && pathname === '/api/auth/me') {
        const user = authenticate(request)
        reply(response, 200, { user: user ? publicUser(user) : null })
        return
      }

      const user = authenticate(request)
      if (!user) {
        reply(response, 401, { error: 'Sign in to continue.' })
        return
      }
      if (request.method === 'GET' && pathname === '/api/projects') {
        const projects = database.prepare('SELECT id, name, updatedAt FROM projects WHERE userId = ? ORDER BY rowid').all(user.id)
        reply(response, 200, { projects })
        return
      }
      if (request.method === 'POST' && pathname === '/api/projects') {
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !body.project || typeof body.project.name !== 'string' || body.project.name.length > 120 || Buffer.byteLength(JSON.stringify(body.project)) > 2 * 1024 * 1024) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        const projectCount = database.prepare('SELECT COUNT(*) AS count FROM projects WHERE userId = ?').get(user.id).count
        if (projectCount >= 100) {
          reply(response, 409, { error: 'Project limit reached (100). Delete an old cloud project first.' })
          return
        }
        const project = { id: randomUUID(), name: body.project.name, updatedAt: new Date().toISOString(), document: body.project }
        database.prepare('INSERT INTO projects (id, userId, name, updatedAt, document) VALUES (?, ?, ?, ?, ?)').run(
          project.id,
          user.id,
          project.name,
          project.updatedAt,
          JSON.stringify(project.document),
        )
        reply(response, 201, { project: { id: project.id, name: project.name, updatedAt: project.updatedAt, document: project.document } })
        return
      }
      const projectRoute = /^\/api\/projects\/([0-9a-f-]+)$/.exec(pathname)
      if (projectRoute && request.method === 'GET') {
        const project = database.prepare('SELECT id, name, updatedAt, document FROM projects WHERE id = ? AND userId = ?').get(projectRoute[1], user.id)
        if (project) project.document = JSON.parse(project.document)
        reply(response, project ? 200 : 404, project ? { project } : { error: 'Project not found.' })
        return
      }
      if (projectRoute && request.method === 'PUT') {
        const project = database.prepare('SELECT id FROM projects WHERE id = ? AND userId = ?').get(projectRoute[1], user.id)
        if (!project) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !body.project || typeof body.project.name !== 'string' || body.project.name.length > 120 || Buffer.byteLength(JSON.stringify(body.project)) > 2 * 1024 * 1024) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        const updatedAt = new Date().toISOString()
        database.prepare('UPDATE projects SET name = ?, document = ?, updatedAt = ? WHERE id = ? AND userId = ?').run(
          body.project.name,
          JSON.stringify(body.project),
          updatedAt,
          project.id,
          user.id,
        )
        reply(response, 200, { project: { id: project.id, name: body.project.name, updatedAt, document: body.project } })
        return
      }
      if (projectRoute && request.method === 'DELETE') {
        const deleted = database.prepare('DELETE FROM projects WHERE id = ? AND userId = ?').run(projectRoute[1], user.id)
        if (deleted.changes === 0) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        reply(response, 200, { ok: true })
        return
      }
      reply(response, 404, { error: 'Not found.' })
    } catch (error) {
      if (error.status) reply(response, error.status, { error: error.message })
      else {
        console.error('PixelForge server error:', error)
        if (!response.headersSent) reply(response, 500, { error: 'An unexpected server error occurred.' })
        else response.destroy()
      }
    }
  }

  const server = createServer(handler)
  server.once('close', () => database.close())
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production'
  const port = Number(process.env.PORT ?? (production ? 4173 : 4174))
  const dataDir = process.env.PIXELFORGE_DATA_DIR ?? join(root, 'data')
  const server = await createApiServer({ dataDir, serveStatic: production })
  server.listen(port, '0.0.0.0', () => console.log(`PixelForge ${production ? 'server' : 'API'} listening on http://localhost:${port}`))
}
