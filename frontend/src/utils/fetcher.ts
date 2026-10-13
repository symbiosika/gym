/**
 * Thin fetch wrapper. The session is the HttpOnly `jwt` cookie set by the
 * framework's login pages; a 401 sends the user back to the login page, a 403
 * (not a member, no permission) is thrown so the caller can show it.
 */
export class FetcherError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(messageOf(status, body))
    this.name = 'FetcherError'
  }
}

function messageOf(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? body
  } catch {
    return body || `Request failed with status ${status}`
  }
}

const redirectToLogin = () => {
  document.cookie = 'jwt_present=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; samesite=lax'
  const redirect = encodeURIComponent(window.location.href)
  window.location.href = `/login.html?redirectUrl=${redirect}`
}

async function handle<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    redirectToLogin()
    throw new FetcherError(401, 'Unauthorized')
  }
  if (!response.ok) throw new FetcherError(response.status, await response.text())
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const fetcher = {
  get: <T>(url: string) => fetch(url).then((r) => handle<T>(r)),
  post: <T>(url: string, body: unknown) => fetch(url, { method: 'POST', ...json(body) }).then((r) => handle<T>(r)),
  put: <T>(url: string, body: unknown) => fetch(url, { method: 'PUT', ...json(body) }).then((r) => handle<T>(r)),
  delete: <T>(url: string) => fetch(url, { method: 'DELETE' }).then((r) => handle<T>(r)),
  postFormData: <T>(url: string, form: FormData) => fetch(url, { method: 'POST', body: form }).then((r) => handle<T>(r)),
}

export const hasSession = (): boolean =>
  document.cookie.split(';').some((c) => c.trim().startsWith('jwt_present=') || c.trim().startsWith('jwt='))
