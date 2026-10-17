import { createHash as sha256, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function createApiServer({ dataDir = join(root, 'data'), staticDir = join(root, 'dist'), serveStatic = true } = {}) {
  const dataPath = join(dataDir, 'accounts.json')
  const sessions = new Map()
  const loginAttempts = new Map()
  let data = { users: [] }
  let writeQueue = Promise.resolve()

  const persist = () => {
    writeQueue = writeQueue.then(async () => {
      await mkdir(dataDir, { recursive: true })
      const temporaryPath = `${dataPath}.${randomUUID()}.tmp`
      await writeFile(temporaryPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, dataPath)
    })
    return writeQueue
  }

  const initialize = async () => {
    try {
      data = JSON.parse(await readFile(dataPath, 'utf8'))
      if (!Array.isArray(data.users)) throw new Error('Invalid account storage format.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(dataDir, { recursive: true })
    }
    const now = Date.now()
    for (const user of data.users) {
      user.sessions = (user.sessions ?? []).filter((session) => session.expiresAt > now)
      for (const session of user.sessions) sessions.set(session.tokenHash, user.id)
    }
    await persist()
  }

  const authenticate = (request) => {
    const token = cookieValue(request.headers.cookie, 'pixelforge_session')
    if (!token) return undefined
    const tokenHash = hashToken(token)
    const userId = sessions.get(tokenHash)
    const user = data.users.find((item) => item.id === userId)
    const session = user?.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now())
    return session ? user : undefined
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
        const requested = pathname === '/' ? 'index.html' : normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
        const filename = resolve(staticDir, requested)
        if (!filename.startsWith(resolve(staticDir) + '\\') && !filename.startsWith(resolve(staticDir) + '/')) {
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
        let user = data.users.find((item) => item.username.toLowerCase() === username.toLowerCase())
        if (pathname.endsWith('/register')) {
          if (user) {
            reply(response, 409, { error: 'That username is already registered.' })
            return
          }
          const salt = randomBytes(16).toString('hex')
          const passwordHash = (await scrypt(body.password, salt, 64)).toString('hex')
          if (data.users.some((item) => item.username.toLowerCase() === username.toLowerCase())) {
            reply(response, 409, { error: 'That username is already registered.' })
            return
          }
          user = { id: randomUUID(), username, salt, passwordHash, projects: [], sessions: [] }
          data.users.push(user)
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
        user.sessions.push({ tokenHash, expiresAt: Date.now() + sessionAge })
        sessions.set(tokenHash, user.id)
        await persist()
        const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : ''
        reply(response, 200, { user: publicUser(user) }, {
          'set-cookie': `pixelforge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionAge / 1000}${secureCookie}`,
        })
        return
      }

      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        const token = cookieValue(request.headers.cookie, 'pixelforge_session')
        const tokenHash = token ? hashToken(token) : undefined
        const userId = tokenHash ? sessions.get(tokenHash) : undefined
        const user = data.users.find((item) => item.id === userId)
        if (user && tokenHash) user.sessions = user.sessions.filter((session) => session.tokenHash !== tokenHash)
        if (tokenHash) sessions.delete(tokenHash)
        if (user) await persist()
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
        reply(response, 200, { projects: user.projects.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/projects') {
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !body.project || typeof body.project.name !== 'string' || body.project.name.length > 120 || Buffer.byteLength(JSON.stringify(body.project)) > 2 * 1024 * 1024) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        if (user.projects.length >= 100) {
          reply(response, 409, { error: 'Project limit reached (100). Delete an old cloud project first.' })
          return
        }
        const project = { id: randomUUID(), name: body.project.name, updatedAt: new Date().toISOString(), document: body.project }
        user.projects.push(project)
        await persist()
        reply(response, 201, { project: { id: project.id, name: project.name, updatedAt: project.updatedAt, document: project.document } })
        return
      }
      const projectRoute = /^\/api\/projects\/([0-9a-f-]+)$/.exec(pathname)
      if (projectRoute && request.method === 'GET') {
        const project = user.projects.find((item) => item.id === projectRoute[1])
        reply(response, project ? 200 : 404, project ? { project } : { error: 'Project not found.' })
        return
      }
      if (projectRoute && request.method === 'PUT') {
        const project = user.projects.find((item) => item.id === projectRoute[1])
        if (!project) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        const body = await requestBody(request)
        if (!body || typeof body !== 'object' || !body.project || typeof body.project.name !== 'string' || body.project.name.length > 120 || Buffer.byteLength(JSON.stringify(body.project)) > 2 * 1024 * 1024) {
          reply(response, 400, { error: 'Invalid project or project exceeds the 2 MB limit.' })
          return
        }
        project.name = body.project.name
        project.document = body.project
        project.updatedAt = new Date().toISOString()
        await persist()
        reply(response, 200, { project: { id: project.id, name: project.name, updatedAt: project.updatedAt, document: project.document } })
        return
      }
      if (projectRoute && request.method === 'DELETE') {
        const index = user.projects.findIndex((item) => item.id === projectRoute[1])
        if (index < 0) {
          reply(response, 404, { error: 'Project not found.' })
          return
        }
        user.projects.splice(index, 1)
        await persist()
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

  return initialize().then(() => createServer(handler))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production'
  const port = Number(process.env.PORT ?? (production ? 4173 : 4174))
  const dataDir = process.env.PIXELFORGE_DATA_DIR ?? join(root, 'data')
  const server = await createApiServer({ dataDir, serveStatic: production })
  server.listen(port, '0.0.0.0', () => console.log(`PixelForge ${production ? 'server' : 'API'} listening on http://localhost:${port}`))
}
