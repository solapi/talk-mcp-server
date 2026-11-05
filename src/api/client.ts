import { buildHmacAuthorization } from './hmac.js';

export interface ApiError {
  code: string;
  message: string;
  status?: number;
}

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T; headers?: Headers }
  | { ok: false; error: ApiError };

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** x-channel-id 헤더. list_channels 처럼 채널이 필요 없는 호출은 생략 */
  channelId?: string;
  headers?: Record<string, string>;
  /** 이 요청만 쓸 타임아웃(ms). 롱폴(wait_for_updates)처럼 서버가 오래 붙잡는 호출용. 생략하면 클라이언트 기본값 */
  timeoutMs?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TalkApiClientOptions {
  /** HMAC 서명용 (apikey 모드). authHeaders 를 주면 쓰지 않는다. */
  apiKey?: string;
  apiSecret?: string;
  /**
   * 요청마다 붙일 인증 헤더 (trusted 모드: 게이트웨이 스탬프 신원 헤더). 주면 HMAC 서명을 하지 않는다.
   * 요청 시점에 호출되므로 AsyncLocalStorage 의 요청 범위 신원을 읽을 수 있다.
   */
  authHeaders?: () => Record<string, string>;
  apiHost: string;
  /** x-talk-client 헤더 값 (mcp/<version>) */
  clientHeader: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** `{ data }` 래퍼에 함께 올 수 있는 키. 이 키들로만 이뤄진 객체만 벗긴다. */
const WRAPPER_KEYS = new Set(['data', 'success', 'statusCode']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 솔라피톡 API 는 컨트롤러 반환값을 감싸지 않고 그대로 준다(기본 경로 = 날것).
 * 혹시 앞단에서 `{ data }` 로 감싸 오는 경우만 한 번 벗긴다. 도메인 키가 섞이면 그대로 둔다.
 */
export function unwrap<T = unknown>(body: unknown): T {
  if (isPlainObject(body) && 'data' in body && body.data !== undefined && Object.keys(body).every((k) => WRAPPER_KEYS.has(k))) {
    return body.data as T;
  }
  return body as T;
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v.join(', ');
  }
  return undefined;
}

/** 4xx/5xx 본문을 { code, message } 로 정규화한다. 솔라피톡 API 규격은 { errorCode, errorMessage }, 나머지는 방어용 폴백. */
export function normalizeError(status: number, statusText: string, body: unknown): ApiError {
  const obj = isPlainObject(body) ? body : {};
  const nested = isPlainObject(obj.error) ? obj.error : {};
  const code =
    pickString(obj.errorCode, nested.code, nested.errorCode, typeof obj.code === 'string' ? obj.code : undefined, typeof obj.error === 'string' ? obj.error : undefined) ??
    `HTTP_${status}`;
  const message =
    pickString(obj.errorMessage, obj.message, nested.message, typeof body === 'string' ? body.slice(0, 500) : undefined) ??
    (statusText || `HTTP ${status}`);
  return { code, message, status };
}

export function buildUrl(apiHost: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(apiHost.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** 경로 세그먼트에 넣는 ID 를 안전하게 인코딩한다. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

export class TalkApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: TalkApiClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private authHeaders(): Record<string, string> {
    if (this.options.authHeaders) return this.options.authHeaders();
    const { apiKey, apiSecret } = this.options;
    if (!apiKey || !apiSecret) throw new Error('TalkApiClient: apiKey/apiSecret 또는 authHeaders 가 필요합니다.');
    return { Authorization: buildHmacAuthorization(apiKey, apiSecret) };
  }

  get apiHost(): string {
    return this.options.apiHost;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    const url = buildUrl(this.options.apiHost, path, opts.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.authHeaders(),
      'x-talk-client': this.options.clientHeader,
      ...opts.headers,
    };
    if (opts.channelId) headers['x-channel-id'] = opts.channelId;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, error: { code: 'Timeout', message: `요청이 ${timeoutMs / 1000}초 안에 끝나지 않았습니다.` } };
      }
      // 에러 메시지에 헤더(서명)가 섞일 일은 없지만, 원문 대신 요약만 남긴다.
      return { ok: false, error: { code: 'NetworkError', message: `API 서버에 연결하지 못했습니다 (${name ?? 'Error'}).` } };
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else {
      parsed = undefined;
    }

    if (!response.ok) {
      return { ok: false, error: normalizeError(response.status, response.statusText, parsed) };
    }
    return { ok: true, status: response.status, data: unwrap<T>(parsed), headers: response.headers };
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }

  post<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('POST', path, opts);
  }

  patch<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('PATCH', path, opts);
  }

  delete<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('DELETE', path, opts);
  }
}
