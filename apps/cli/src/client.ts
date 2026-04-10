export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export class CliApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "CliApiError";
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createApiClient(options: {
  baseUrl: string;
  token?: string;
  fetchImpl?: FetchLike;
}): ApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown) {
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliApiError(
        error instanceof Error
          ? `looperd is not reachable: ${error.message}`
          : "looperd is not reachable",
      );
    }

    const payload = (await response.json()) as ApiEnvelope<T>;

    if (!response.ok || !payload.ok || payload.data === undefined) {
      throw new CliApiError(
        payload.error?.message ??
          `Request failed with status ${response.status}`,
        payload.error?.code,
        response.status,
        payload.requestId,
      );
    }

    return payload.data;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };
}
