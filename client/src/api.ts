/** REST calls to the gateway's /auth endpoints. */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? `HTTP ${status}`));
    this.code = String(body.error ?? 'HTTP_ERROR');
    this.status = status;
    this.body = body;
  }
}

export class GatewayApi {
  readonly server: string;

  constructor(server: string) {
    this.server = server.replace(/\/$/, '');
  }

  async request<T = Record<string, any>>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
    const response = await fetch(`${this.server}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-REWiki-Client': 'rewiki',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error page.
    }
    if (!response.ok) throw new ApiError(response.status, data);
    return data as T;
  }
}
