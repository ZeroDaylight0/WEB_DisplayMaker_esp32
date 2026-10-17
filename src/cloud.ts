import type { Project } from './types'

export interface AccountUser {
  id: string
  username: string
}

export interface CloudProjectSummary {
  id: string
  name: string
  updatedAt: string
}

interface ApiResponse {
  user?: AccountUser | null
  projects?: CloudProjectSummary[]
  project?: { id: string; name: string; document: Project }
  error?: string
}

async function request(path: string, options: RequestInit = {}): Promise<ApiResponse> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const payload = await response.json() as ApiResponse
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`)
  return payload
}

export async function getCurrentUser(): Promise<AccountUser | null> {
  const payload = await request('/api/auth/me')
  return payload.user ?? null
}

export async function signIn(username: string, password: string, register: boolean): Promise<AccountUser> {
  const payload = await request(`/api/auth/${register ? 'register' : 'login'}`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!payload.user) throw new Error('The server did not return an account')
  return payload.user
}

export async function signOut(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', body: '{}' })
}

export async function getCloudProjects(): Promise<CloudProjectSummary[]> {
  const payload = await request('/api/projects')
  return payload.projects ?? []
}

export async function loadCloudProject(id: string): Promise<Project> {
  const payload = await request(`/api/projects/${encodeURIComponent(id)}`)
  if (!payload.project) throw new Error('The server did not return a project')
  return { ...payload.project.document, cloudProjectId: payload.project.id }
}

export async function saveCloudProject(project: Project, ownerId: string): Promise<Project> {
  const projectId = project.cloudOwnerId === ownerId ? project.cloudProjectId : undefined
  const document = { ...project }
  delete document.cloudProjectId
  delete document.cloudOwnerId
  const payload = await request(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects', {
    method: projectId ? 'PUT' : 'POST',
    body: JSON.stringify({ project: document }),
  })
  if (!payload.project) throw new Error('The server did not return the saved project')
  return { ...project, cloudProjectId: payload.project.id, cloudOwnerId: ownerId }
}

export async function deleteCloudProject(id: string): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
