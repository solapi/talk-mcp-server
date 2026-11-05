import { describe, expect, it } from 'vitest';
import { normalizeError, TalkApiClient, unwrap } from '../src/api/client.js';
import { mockFetch } from './helpers.js';

describe('unwrap', () => {
  it('날것이 기본, { data } 래퍼만 한 번 벗긴다', () => {
    expect(unwrap({ items: [1], nextKey: 'a', hasMore: false })).toEqual({ items: [1], nextKey: 'a', hasMore: false });
    expect(unwrap({ channels: [] })).toEqual({ channels: [] });
    expect(unwrap({ data: { items: [1] } })).toEqual({ items: [1] });
    expect(unwrap({ statusCode: 200, data: { data: 'x' } })).toEqual({ data: 'x' });
    // 도메인 키가 섞이면 벗기지 않는다
    expect(unwrap({ consultId: 'C', data: 1 })).toEqual({ consultId: 'C', data: 1 });
    expect(unwrap([1])).toEqual([1]);
  });
});

describe('normalizeError', () => {
  it('솔라피톡 API 규격 { status, errorCode, errorMessage } 와 폴백', () => {
    expect(normalizeError(400, 'Bad Request', { status: 400, errorCode: 'ConsultFilterConflict', errorMessage: '충돌' })).toEqual({
      code: 'ConsultFilterConflict',
      message: '충돌',
      status: 400,
    });
    expect(normalizeError(403, 'Forbidden', { errorCode: 'ManagerRoleReadOnly', errorMessage: '읽기 전용' })).toEqual({
      code: 'ManagerRoleReadOnly',
      message: '읽기 전용',
      status: 403,
    });
    expect(normalizeError(429, '', { error: { code: 'ReplyRateLimited', message: '느리게' } })).toMatchObject({
      code: 'ReplyRateLimited',
    });
    expect(normalizeError(400, 'Bad Request', { statusCode: 400, message: ['a 는 필수', 'b 는 문자열'], error: 'Bad Request' })).toEqual({
      code: 'Bad Request',
      message: 'a 는 필수, b 는 문자열',
      status: 400,
    });
    expect(normalizeError(502, 'Bad Gateway', undefined)).toEqual({ code: 'HTTP_502', message: 'Bad Gateway', status: 502 });
  });
});

describe('TalkApiClient', () => {
  it('헤더(Authorization·x-channel-id·x-talk-client)와 쿼리', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { data: { ok: 1 } } }));
    const client = new TalkApiClient({ apiKey: 'K', apiSecret: 'S', apiHost: 'https://h.test', clientHeader: 'mcp/0.1.0', fetch });
    const res = await client.get('/talk/v1/consults', { channelId: 'CH', query: { a: 'x', b: undefined, c: false } });
    expect(res).toMatchObject({ ok: true, status: 200, data: { ok: 1 } });
    const call = calls[0]!;
    expect(call.url.toString()).toBe('https://h.test/talk/v1/consults?a=x&c=false');
    expect(call.headers.Authorization).toMatch(/^HMAC-SHA256 apiKey=K, date=.+, salt=[0-9a-f]{32}, signature=[0-9a-f]{64}$/);
    expect(call.headers.Authorization).not.toContain('S,');
    expect(call.headers['x-channel-id']).toBe('CH');
    expect(call.headers['x-talk-client']).toBe('mcp/0.1.0');
  });

  it('네트워크 실패·타임아웃 정규화', async () => {
    const client = new TalkApiClient({
      apiKey: 'K',
      apiSecret: 'S',
      apiHost: 'https://h.test',
      clientHeader: 'mcp/x',
      fetch: async () => {
        throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
      },
    });
    expect(await client.get('/x')).toMatchObject({ ok: false, error: { code: 'Timeout' } });
  });
});
