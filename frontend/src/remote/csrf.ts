let csrfToken: string | null = null

export function setRemoteCsrf(token: string | null): void {
  csrfToken = token
}

export function remoteCsrf(): string | null {
  return csrfToken
}

export function withCsrf(method: string, headers: Record<string, string>): Record<string, string> {
  const token = method === 'GET' || method === 'HEAD' ? null : csrfToken
  if (!token) return headers
  return { ...headers, 'x-csrf-token': token }
}
