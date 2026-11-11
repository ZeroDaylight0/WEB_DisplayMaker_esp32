import { createHash as sha256, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// node:sqlite is built into Node.js 22.13+, so no native module has to be compiled on install.
// Silence only its "experimental" notice; every other warning is still printed.
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return
  return emitWarning.call(process, warning, ...args)
}
const { DatabaseSync } = await import('node:sqlite')

const scrypt = promisify(scryptCallback)
const root = fileURLToPath(new URL('.', import.meta.url))
const maxBodyBytes = 5 * 1024 * 1024
const maxProjectBytes = 2 * 1024 * 1024
const maxProjectsPerUser = 100
const sessionAge = 7 * 24 * 60 * 60 * 1000
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
}
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function reply(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders, ...headers })
  response.end(JSON.stringify(value))
}

async function requestBody(request) {
  const declaredLength = Number(request.headers['content-length'])
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBodyBytes
  const chunks = []
  let size = 0
  // Keep reading (and discarding) an oversized body so the client receives the 413 response
  // instead of a connection reset; server.requestTimeout bounds how long this can take.
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBodyBytes) tooLarge = true
    if (!tooLarge) chunks.push(chunk)
  }
  if (tooLarge) throw httpError(413, 'Request body is too large.')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'Invalid JSON body.')
  }
}

function cookieValue(header, name) {
  const item = (header ?? '').split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))
  return item ? item.slice(name.length + 1) : undefined
}

function safeUsername(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_.-]{3,32}$/u.test(value.trim())
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256
}

function validProject(body) {
  if (!body || typeof body !== 'object' || !body.project || typeof body.project !== 'object' || Array.isArray(body.project)) return false
  const { name } = body.project
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 120 && Buffer.byteLength(JSON.stringify(body.project)) <= maxProjectBytes
}

function publicUser(user) {
  return { id: user.id, username: user.username }
}

function hashToken(token) {
  return sha256('sha256').update(token).digest('hex')
}

async function hashPassword(password, salt) {
  return Buffer.from(await scrypt(password, salt, 64))
}

function isUniqueViolation(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.errcode === 2067 || /UNIQUE constraint failed/.test(error?.message ?? '')
}

function envFlag(name) {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return undefined
  return ['1', 'true', 'yes', 'on'].includes(value)
}

export async function createApiServer({
  dataDir = join(root, 'data'),
  staticDir = join(root, 'dist'),
  serveStatic = true,
  // true: anyone can register; false: nobody can; 'first-account' (default): only until the
  // first account exists, so a server reachable on the network is not open to strangers.
  allowRegistration = envFlag('PIXELFORGE_ALLOW_REGISTRATION') ?? 'first-account',
  trustProxy = envFlag('PIXELFORGE_TRUST_PROXY') ?? false,
  secureCookies = envFlag('PIXELFORGE_SECURE_COOKIE'),
} = {}) {
  const loginAttempts = new Map()
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  // chmod is a no-op on Windows and may be refused on some mounted Linux file systems (e.g. NTFS, SMB).
  await chmod(dataDir, 0o700).catch(() => {})
  const databasePath = join(dataDir, 'pixelforge.sqlite')
  const database = new DatabaseSync(databasePath)
  await chmod(databasePath, 0o600).catch(() => {})
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = FULL')
  database.exec('PRAGMA foreign_keys = ON')
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

  const transaction = (work) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

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
        transaction(() => {
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
        })
      } catch (error) {
        database.close()
        throw new Error(`Could not migrate legacy account data from ${legacyPath}: ${error.message}`, { cause: error })
      }
    }
  }

  const deleteExpiredSessions = database.prepare('DELETE FROM sessions WHERE expiresAt <= ?')
  deleteExpiredSessions.run(Date.now())
  const cleanupTimer = setInterval(() => {
    try {
      deleteExpiredSessions.run(Date.now())
    } catch (error) {
      console.error('PixelForge session cleanup failed:', error)
    }
  }, 60 * 60 * 1000)
  cleanupTimer.unref()

  const countUsers = database.prepare('SELECT COUNT(*) AS count FROM users')
  const registrationOpen = () => allowRegistration === true
    || allowRegistration === 'first-account' && countUsers.get().count === 0
  const registrationClosedMessage = allowRegistration === 'first-account'
    ? 'Registration is closed: this server already has an account. Set PIXELFORGE_ALLOW_REGISTRATION=1 to allow more.'
    : 'Registration is disabled on this server.'

  const userByUsername = database.prepare('SELECT id, username, salt, passwordHash FROM users WHERE usernameKey = ?')
  const userBySession = database.prepare(`
    SELECT users.id, users.username, users.salt, users.passwordHash
    FROM sessions JOIN users ON users.id = sessions.userId
    WHERE sessions.tokenHash = ? AND sessions.expiresAt > ?
  `)

  const sessionToken = (request) => cookieValue(request.headers.cookie, 'pixelforge_session')

  const authenticate = (request) => {
    const token = sessionToken(request)
    if (!token) return undefined
    return userBySession.get(hashToken(token), Date.now())
  }

  const clientAddress = (request) => {
    if (trustProxy) {
      const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
      if (forwarded) return forwarded
    }
    return request.socket.remoteAddress ?? 'unknown'
  }

  // A Secure cookie is dropped by browsers on plain HTTP (e.g. http://192.168.1.20:4173 on a LAN),
  // so only mark it Secure when the connection really is HTTPS, unless explicitly configured.
  const isHttps = (request) => request.socket.encrypted === true
    || trustProxy && String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
  const sessionCookie = (request, token, maxAge) => {
    const secure = secureCookies ?? isHttps(request)
    return `pixelforge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  }

  const rateLimited = (request, pathname) => {
    const attemptKey = `${clientAddress(request)}:${pathname}`
    const cutoff = Date.now() - 60_000
    const activeAttempts = (loginAttempts.get(attemptKey) ?? []).filter((timestamp) => timestamp > cutoff)
    if (loginAttempts.size > 10_000) {
      for (const [key, timestamps] of loginAttempts) {
        if (!timestamps.some((timestamp) => timestamp > cutoff)) loginAttempts.delete(key)
      }
    }
    if (activeAttempts.length >= 10) return true
    activeAttempts.push(Date.now())
    loginAttempts.set(attemptKey, activeAttempts)
    return false
  }

  const rejectCrossSiteMutation = (request, response) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false
    const origin = request.headers.origin
    const host = trustProxy ? request.headers['x-forwarded-host'] ?? request.headers.host : request.headers.host
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

  const serveFile = async (request, response, pathname) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders }).end()
      return
    }
    let requested
    try {
      requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
    } catch {
      reply(response, 400, { error: 'Invalid URL path.' })
      return
    }
    if (requested.includes('\0')) {
      reply(response, 400, { error: 'Invalid URL path.' })
      return
    }
    const staticRoot = resolve(staticDir)
    const filename = resolve(staticRoot, `.${requested}`)
    const relativePath = relative(staticRoot, filename)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      response.writeHead(403, securityHeaders).end()
      return
    }
    try {
      if (!(await stat(filename)).isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' })
      const file = await readFile(filename)
      const extension = extname(filename).toLowerCase()
      const headers = {
        'content-type': mimeTypes[extension] ?? 'application/octet-stream',
        'content-length': file.length,
        // Vite fingerprints everything in /assets, so those files can be cached forever.
        'cache-control': relativePath.startsWith(`assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...securityHeaders,
        ...(extension === '.html' ? { 'content-security-policy': contentSecurityPolicy } : {}),
      }
      response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : file)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EISDIR') throw error
      response.writeHead(404, securityHeaders).end()
    }
  }

  const issueSession = (request, response, user, { register = false, usernameKey } = {}) => {
    const token = randomBytes(32).toString('base64url')
    transaction(() => {
      if (register) {
        // Checked again inside the write transaction so two simultaneous sign-ups on a fresh
        // server cannot both become the "first" account.
        if (!registrationOpen()) throw httpError(403, registrationClosedMessage)
        database.prepare('INSERT INTO users (id, username, usernameKey, salt, passwordHash) VALUES (?, ?, ?, ?, ?)').run(user.id, user.username, usernameKey, user.salt, user.passwordHash)
      }
      database.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)').run(hashToken(token), user.id, Date.now() + sessionAge)
    })
    reply(response, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(request, token, sessionAge / 1000) })
  }

  const passwordMatches = async (user, password) => {
    const suppliedHash = await hashPassword(password, user ? user.salt : 'pixelforge-dummy-salt')
    const storedHash = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64)
    return !!user && storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash)
  }

  const handler = async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (!pathname.startsWith('/api/')) {
        if (!serveStatic) {
          reply(response, 404, { error: 'Not found.' })
          return
        }
        await serveFile(request, response, pathname)
        return
      }

      if (rejectCrossSiteMutation(request, response)) return
      if (request.method === 'GET' && pathname === '/api/health') {
        reply(response, 200, { ok: true })
        return
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        reply(response, 200, { allowRegistration: registrationOpen() })
        return
      }

      if (request.method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
        const register = pathname.endsWith('/register')
        if (register && !registrationOpen()) {
          reply(response, 403, { error: registrationClosedMessage })
          return
        }
        if (rateLimited(request, pathname)) {
          reply(response, 429, { error: 'Too many attempts. Try again in a minute.' }, { 'retry-after': '60' })
          return
        }
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !safeUsername(body.username) || typeof body.password !== 'string') {
          reply(response, 400, { error: 'Username must be 3–32 letters, numbers, dots, dashes, or underscores.' })
          return
        }
        if (!validPassword(body.password)) {
          reply(response, 400, { error: 'Password must be between 8 and 256 characters.' })
          return
        }
        const username = body.username.trim()
        const usernameKey = username.toLowerCase()
        const existing = userByUsername.get(usernameKey)
        if (register) {
          if (existing) {
            reply(response, 409, { error: 'That username is already registered.' })
            return
          }
          const salt = randomBytes(16).toString('hex')
          const passwordHash = (await hashPassword(body.password, salt)).toString('hex')
          try {
            issueSession(request, response, { id: randomUUID(), username, salt, passwordHash }, { register: true, usernameKey })
          } catch (error) {
            if (!isUniqueViolation(error)) throw error
            reply(response, 409, { error: 'That username is already registered.' })
          }
          return
        }
        if (!await passwordMatches(existing, body.password)) {
          reply(response, 401, { error: 'Invalid username or password.' })
          return
        }
        issueSession(request, response, existing)
        return
      }

      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        const token = sessionToken(request)
        if (token) database.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(hashToken(token))
        reply(response, 200, { ok: true }, { 'set-cookie': sessionCookie(request, '', 0) })
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

      if (request.method === 'POST' && pathname === '/api/auth/password') {
        if (rateLimited(request, pathname)) {
          reply(response, 429, { error: 'Too many attempts. Try again in a minute.' }, { 'retry-after': '60' })
          return
        }
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || typeof body.currentPassword !== 'string' || !validPassword(body.newPassword)) {
          reply(response, 400, { error: 'Password must be between 8 and 256 characters.' })
          return
        }
        if (!await passwordMatches(user, body.currentPassword)) {
          reply(response, 401, { error: 'Current password is incorrect.' })
          return
        }
        const salt = randomBytes(16).toString('hex')
        const passwordHash = (await hashPassword(body.newPassword, salt)).toString('hex')
        const currentTokenHash = hashToken(sessionToken(request))
        transaction(() => {
          database.prepare('UPDATE users SET salt = ?, passwordHash = ? WHERE id = ?').run(salt, passwordHash, user.id)
          // Sign out every other device; the session that changed the password stays valid.
          database.prepare('DELETE FROM sessions WHERE userId = ? AND tokenHash <> ?').run(user.id, currentTokenHash)
        })
        reply(response, 200, { ok: true })
        return
      }

      if (request.method === 'GET' && pathname === '/api/projects') {
        const projects = database.prepare('SELECT id, name, updatedAt FROM projects WHERE userId = ? ORDER BY updatedAt DESC').all(user.id)
        reply(response, 200, { projects })
        return
      }
      if (request.method === 'POST' && pathname === '/api/projects') {
        const body = await requestBody(request)
        if (!validProject(body)) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        const projectCount = database.prepare('SELECT COUNT(*) AS count FROM projects WHERE userId = ?').get(user.id).count
        if (projectCount >= maxProjectsPerUser) {
          reply(response, 409, { error: `Project limit reached (${maxProjectsPerUser}). Delete an old cloud project first.` })
          return
        }
        const project = { id: randomUUID(), name: body.project.name.trim(), updatedAt: new Date().toISOString(), document: body.project }
        database.prepare('INSERT INTO projects (id, userId, name, updatedAt, document) VALUES (?, ?, ?, ?, ?)').run(
          project.id,
          user.id,
          project.name,
          project.updatedAt,
          JSON.stringify(project.document),
        )
        reply(response, 201, { project })
        return
      }
      const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(pathname)
      if (projectRoute && !uuidPattern.test(projectRoute[1])) {
        reply(response, 404, { error: 'Project not found.' })
        return
      }
      if (projectRoute && request.method === 'GET') {
        const project = database.prepare('SELECT id, name, updatedAt, document FROM projects WHERE id = ? AND userId = ?').get(projectRoute[1], user.id)
        if (!project) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        reply(response, 200, { project: { id: project.id, name: project.name, updatedAt: project.updatedAt, document: JSON.parse(project.document) } })
        return
      }
      if (projectRoute && request.method === 'PUT') {
        const body = await requestBody(request)
        if (!validProject(body)) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        const updatedAt = new Date().toISOString()
        const name = body.project.name.trim()
        const updated = database.prepare('UPDATE projects SET name = ?, document = ?, updatedAt = ? WHERE id = ? AND userId = ?').run(
          name,
          JSON.stringify(body.project),
          updatedAt,
          projectRoute[1],
          user.id,
        )
        if (updated.changes === 0) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        reply(response, 200, { project: { id: projectRoute[1], name, updatedAt, document: body.project } })
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
      if (error.status) {
        reply(response, error.status, { error: error.message })
      } else {
        console.error('PixelForge server error:', error)
        if (!response.headersSent) reply(response, 500, { error: 'An unexpected server error occurred.' })
        else response.destroy()
      }
    }
  }

  const server = createServer(handler)
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.once('close', () => {
    clearInterval(cleanupTimer)
    database.close()
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production'
  const port = Number(process.env.PORT ?? (production ? 4173 : 4174))
  const host = process.env.HOST ?? '127.0.0.1'
  const dataDir = process.env.PIXELFORGE_DATA_DIR ?? join(root, 'data')
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT must be a number between 0 and 65535, got "${process.env.PORT}".`)
    process.exit(1)
  }
  if (production) {
    try {
      await stat(join(root, 'dist', 'index.html'))
    } catch {
      console.error('The editor is not built yet. Run "npm run build" first.')
      process.exit(1)
    }
  }
  const server = await createApiServer({ dataDir, serveStatic: production })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Stop the other process or start with PORT=<free port>.`)
    else if (error.code === 'EACCES') console.error(`No permission to listen on ${host}:${port}. Use a port above 1024.`)
    else console.error('PixelForge could not start:', error)
    process.exit(1)
  })
  server.listen(port, host, () => {
    const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host
    console.log(`PixelForge ${production ? 'server' : 'API'} listening on http://${shownHost}:${server.address().port}`)
    if (host === '0.0.0.0' || host === '::') console.log('Listening on all network interfaces; other devices on your network can reach this server.')
    console.log(`Data directory: ${resolve(dataDir)}`)
  })
  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down…`)
    server.close(() => process.exit(0))
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}
