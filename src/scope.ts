import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * trusted(게이트웨이 뒤) 모드의 요청 신원. 게이트웨이가 검증 후 스탬프한 헤더에서 온다.
 * 요청마다 다른 테넌트이므로 프로세스 전역이 아니라 AsyncLocalStorage 로 요청 범위에만 둔다.
 */
export interface RequestScope {
  /** x-authenticated-member-id (필수) */
  memberId: string;
  /** x-authenticated-account-id (선택) */
  accountId?: string;
  /** x-channel-id (선택) — 없으면 도구 인자 channelId 를 쓴다 */
  channelId?: string;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runWithScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

/** trusted 모드 도구 코드에서 호출. 범위 밖에서 불리면 버그이므로 던진다(전역 신원으로 폴백하지 않는다). */
export function requireScope(): RequestScope {
  const scope = storage.getStore();
  if (!scope) throw new Error('요청 신원 컨텍스트가 없습니다 (trusted 모드는 HTTP 요청 범위에서만 도구를 실행합니다).');
  return scope;
}

export const TRUSTED_HEADERS = {
  memberId: 'x-authenticated-member-id',
  accountId: 'x-authenticated-account-id',
  channelId: 'x-channel-id',
} as const;

const MAX_HEADER_VALUE = 128;

/** 헤더 값 하나를 꺼낸다. 중복이면 첫 값, 공백·제어문자·과도한 길이는 없는 것으로 본다. */
export function readTrustedHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length > MAX_HEADER_VALUE) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) return undefined;
  return trimmed;
}

export function scopeFromHeaders(headers: Record<string, string | string[] | undefined>): RequestScope | undefined {
  const memberId = readTrustedHeader(headers[TRUSTED_HEADERS.memberId]);
  if (!memberId) return undefined;
  const accountId = readTrustedHeader(headers[TRUSTED_HEADERS.accountId]);
  const channelId = readTrustedHeader(headers[TRUSTED_HEADERS.channelId]);
  return { memberId, ...(accountId ? { accountId } : {}), ...(channelId ? { channelId } : {}) };
}
