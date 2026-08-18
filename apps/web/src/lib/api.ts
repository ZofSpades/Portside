const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://api.localhost';

export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  sourceType: 'GIT' | 'ZIP';
  repoUrl: string | null;
  branch: string;
  rootDir: string;
  currentDeploymentId: string | null;
  createdAt: string;
}

export type DeploymentStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'DETECTING'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'HEALTHCHECK'
  | 'LIVE'
  | 'SUPERSEDED'
  | 'STOPPED'
  | 'FAILED'
  | 'CANCELLED';

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  trigger: 'MANUAL' | 'REDEPLOY' | 'ROLLBACK';
  detectedType: string | null;
  imageTag: string | null;
  hostname: string | null;
  errorMessage: string | null;
  rolledBackFromId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnvVarSummary {
  key: string;
  updatedAt: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `Request failed with ${res.status}`);
  }
  return body as T;
}

export function loginUrl(): string {
  return `${API_URL}/auth/github`;
}

export async function getMe(): Promise<User | null> {
  try {
    return await apiFetch<User>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export function listProjects(): Promise<Project[]> {
  return apiFetch('/api/projects');
}

export function getProject(id: string): Promise<Project> {
  return apiFetch(`/api/projects/${id}`);
}

export function createProjectFromGit(input: {
  name: string;
  repoUrl: string;
  branch?: string;
}): Promise<Project> {
  return apiFetch('/api/projects', { method: 'POST', body: JSON.stringify(input) });
}

export async function createProjectFromZip(name: string, file: File): Promise<Project> {
  const form = new FormData();
  form.append('name', name);
  form.append('file', file);
  const res = await fetch(`${API_URL}/api/projects/zip`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed with ${res.status}`);
  return body as Project;
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
}

export function listDeployments(projectId: string): Promise<Deployment[]> {
  return apiFetch(`/api/projects/${projectId}/deployments`);
}

export function getDeployment(id: string): Promise<Deployment> {
  return apiFetch(`/api/deployments/${id}`);
}

export function triggerDeploy(projectId: string): Promise<Deployment> {
  return apiFetch(`/api/projects/${projectId}/deploy`, { method: 'POST' });
}

export function rollback(projectId: string, toDeploymentId: string): Promise<Deployment> {
  return apiFetch(`/api/projects/${projectId}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ toDeploymentId }),
  });
}

export function cancelDeployment(id: string): Promise<void> {
  return apiFetch(`/api/deployments/${id}/cancel`, { method: 'POST' });
}

export function listEnvVars(projectId: string): Promise<EnvVarSummary[]> {
  return apiFetch(`/api/projects/${projectId}/env`);
}

export function setEnvVar(projectId: string, key: string, value: string): Promise<void> {
  return apiFetch(`/api/projects/${projectId}/env`, {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
}

export function deleteEnvVar(projectId: string, key: string): Promise<void> {
  return apiFetch(`/api/projects/${projectId}/env/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

export { API_URL, ApiError };
