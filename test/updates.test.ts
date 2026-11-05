import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TalkApiClient } from '../src/api/client.js';
import { startHttpServer, type RunningHttpServer } from '../src/http.js';
import { createContext } from '../src/server.js';
import { UNTRUSTED_NOTICE } from '../src/text.js';
import { buildUpdatesQuery, dedupeUpdates } from '../src/tools/updates.js';
import { connect, makeConfig, mockFetch, type RecordedCall } from './helpers.js';

const UPDATES = '/talk/v1/consults/updates';

const item = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  consultId: id,
  consultStatus: 'progress',
  memberName: '홍길동 010-1234-5678',
  managerIds: [],
  lastMessage: `<p>환불 문의 hong@example.com ${'가'.repeat(200)}</p>`,
  lastSenderType: 'user',
  userUnReadCount: 0,
  adminUnReadCount: 2,
  dateUpdated: at,
  ...extra,
});

/** since 에 따라 응답을 바꾸는 목 서버 */
function updatesRoute(responses: Record<string, unknown>) {
  return (call: RecordedCall) => {
    if (call.method !== 'GET' || call.url.pathname !== UPDATES) return undefined;
    const since = call.url.searchParams.get('since') ?? '';
    const body = responses[since];
    return body === undefined ? undefined : { body };
  };
}

describe('wait_for_updates 쿼리', () => {
  it('기본값과 범위 clamp', () => {
    expect(buildUpdatesQuery({})).toEqual({ since: undefined, timeoutSec: 20, unansweredOnly: true, unassigned: false, limit: 20 });
    expect(buildUpdatesQuery({ timeoutSec: 99, limit: 500 })).toMatchObject({ timeoutSec: 25, limit: 50 });
    expect(buildUpdatesQuery({ timeoutSec: -3, limit: 0 })).toMatchObject({ timeoutSec: 0, limit: 1 });
    expect(buildUpdatesQuery({ since: '  ' }).since).toBeUndefined();
  });

  it('쿼리 직렬화·x-channel-id·요청 타임아웃 timeoutSec+10초', async () => {
    const { call, calls } = await connect(
      makeConfig(),
      updatesRoute({ '2026-11-04T01:00:00.000Z': { items: [], cursor: '2026-11-04T01:00:30.000Z', timedOut: true } }),
    );
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z', timeoutSec: 60, limit: 999, unassigned: true });
    expect(res.isError).toBe(false);
    const req = calls[0]!;
    expect(req.headers['x-channel-id']).toBe('CH_A');
    expect(Object.fromEntries(req.url.searchParams)).toEqual({
      since: '2026-11-04T01:00:00.000Z',
      timeoutSec: '25',
      unansweredOnly: 'true',
      unassigned: 'true',
      limit: '50',
    });
    expect(res.text).toContain('변경 없음(대기 25초)');
  });

  it('클라이언트 요청 타임아웃 오버라이드', async () => {
    let signal: AbortSignal | undefined;
    const client = new TalkApiClient({
      apiKey: 'K',
      apiSecret: 'S',
      apiHost: 'https://h.test',
      clientHeader: 'mcp/x',
      timeoutMs: 10,
      fetch: async (_url, init) => {
        signal = init.signal ?? undefined;
        await new Promise((r) => setTimeout(r, 50));
        return new Response('{}', { status: 200 });
      },
    });
    // 목은 신호를 무시하고 50ms 를 끈다. 기본 10ms 였다면 신호가 abort 됐어야 하므로, 오버라이드(5초)가 반영됐는지 본다.
    const res = await client.get('/x', { timeoutMs: 5_000 });
    expect(res.ok).toBe(true);
    expect(signal?.aborted).toBe(false);

    const slow = new TalkApiClient({
      apiKey: 'K',
      apiSecret: 'S',
      apiHost: 'https://h.test',
      clientHeader: 'mcp/x',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const timedOut = await slow.get('/x', { timeoutMs: 20 });
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'Timeout', message: '요청이 0.02초 안에 끝나지 않았습니다.' } });
  });

  it('도구가 timeoutSec+10초를 요청 타임아웃으로 넘긴다', async () => {
    const { fetch } = mockFetch(() => ({ body: { items: [], cursor: 'X', timedOut: true } }));
    const ctx = createContext(makeConfig(), { fetch });
    const seen: Array<number | undefined> = [];
    const original = ctx.client.get.bind(ctx.client);
    ctx.client.get = ((path: string, opts?: { timeoutMs?: number }) => {
      seen.push(opts?.timeoutMs);
      return original(path, opts);
    }) as typeof ctx.client.get;
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerUpdateTools } = await import('../src/tools/updates.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 't', version: '0' });
    registerUpdateTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: 'wait_for_updates', arguments: { since: '2026-11-04T00:00:00Z' } });
    await client.callTool({ name: 'wait_for_updates', arguments: { since: '2026-11-04T00:00:00Z', timeoutSec: 0 } });
    expect(seen).toEqual([30_000, 10_000]);
  });
});

describe('wait_for_updates 응답 포맷', () => {
  it('since 없음 → 기준 cursor 안내만', async () => {
    const { call, calls } = await connect(makeConfig(), updatesRoute({ '': { items: [], cursor: '2026-11-04T01:00:00.000Z', timedOut: false } }));
    const res = await call('wait_for_updates');
    expect(calls[0]!.url.searchParams.has('since')).toBe(false);
    expect(res.text).toBe('기준 시각 cursor=2026-11-04T01:00:00.000Z 를 받았습니다. 이 값을 since 로 넘겨 다시 호출하세요.');
  });

  it('변경 있음 → 안내·상담별 한 줄·마스킹·HTML 제거·120자·consultId dedupe·cursor', async () => {
    const { call } = await connect(
      makeConfig(),
      updatesRoute({
        '2026-11-04T01:00:00.000Z': {
          items: [
            item('C1', '2026-11-04T01:20:00.000Z'),
            item('C2', '2026-11-04T01:21:00.000Z', { managerIds: ['MG1'], lastSenderType: 'manager', lastSenderName: 'ALEX', lastMessage: '네 확인했습니다' }),
            item('C1', '2026-11-04T01:21:00.000Z', { lastMessage: '추가 문의' }),
          ],
          cursor: '2026-11-04T01:21:00.000Z',
          timedOut: false,
        },
      }),
    );
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z' });
    expect(res.text.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(res.text).toContain('바뀐 상담 2건');
    expect(res.text).toContain('- [progress] C2 · 홍길동 010-****-5678 · 담당 MG1 · 미읽음 2 · 마지막(상담원 ALEX 2026-11-04 10:21): 네 확인했습니다');
    expect(res.text).toContain('- [progress] C1 · 홍길동 010-****-5678 · 미배정 · 미읽음 2 · 마지막(고객 2026-11-04 10:21): 추가 문의');
    expect(res.text.match(/\] C1 /g)).toHaveLength(1);
    expect(res.text).toMatch(/cursor=2026-11-04T01:21:00\.000Z\n이 값을 다음 wait_for_updates 호출의 since 로 쓰세요\.$/);
  });

  it('긴 메시지는 120자로 자르고 이메일 마스킹·HTML 제거', async () => {
    const { call } = await connect(
      makeConfig(),
      updatesRoute({ '2026-11-04T01:00:00.000Z': { items: [item('C1', '2026-11-04T01:20:00.000Z')], cursor: 'Z', timedOut: false } }),
    );
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z' });
    const line = res.text.split('\n').find((l) => l.includes('] C1 '))!;
    expect(line).not.toContain('<p>');
    expect(line).toContain('h***@example.com');
    const message = line.split('): ')[1]!;
    expect(message.length).toBe(121); // 120자 + …
    expect(message.endsWith('…')).toBe(true);
  });

  it('timedOut → 변경 없음(대기 N초)', async () => {
    const { call } = await connect(
      makeConfig(),
      updatesRoute({ '2026-11-04T01:00:00.000Z': { items: [], cursor: '2026-11-04T01:00:20.000Z', timedOut: true } }),
    );
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z', timeoutSec: 15 });
    expect(res.text).toContain('변경 없음(대기 15초)');
    expect(res.text).toContain('cursor=2026-11-04T01:00:20.000Z');
    expect(res.text.startsWith(UNTRUSTED_NOTICE)).toBe(false);
  });

  it('throttled → 잠시 후 재호출 안내', async () => {
    const { call } = await connect(
      makeConfig(),
      updatesRoute({ '2026-11-04T01:00:00.000Z': { items: [], cursor: '2026-11-04T01:00:00.000Z', timedOut: false, throttled: true } }),
    );
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z' });
    expect(res.text).toContain('서버 대기 상한');
    expect(res.text).toContain('잠시 후 다시 호출');
  });

  it('since 형식 오류는 호출 없이 거부', async () => {
    const { call, calls } = await connect(makeConfig(), () => undefined);
    const res = await call('wait_for_updates', { since: 'not-a-date' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('InvalidSince');
    expect(calls).toHaveLength(0);
  });

  it('API 오류는 기존 힌트 형식', async () => {
    const { call } = await connect(makeConfig(), () => ({ status: 403, body: { errorCode: 'ChannelAccessDenied', errorMessage: 'no' } }));
    const res = await call('wait_for_updates', { since: '2026-11-04T01:00:00.000Z' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('list_channels');
  });
});

describe('wait_for_updates cursor 기억', () => {
  it('stdio(apikey): 마지막 cursor 를 기억해 since 생략 시 자동 사용, 같은 밀리초 중복 제거', async () => {
    const T0 = '2026-11-04T01:00:00.000Z';
    const T1 = '2026-11-04T01:05:00.000Z';
    const { call, calls } = await connect(
      makeConfig(),
      updatesRoute({
        '': { items: [], cursor: T0, timedOut: false },
        [T0]: { items: [item('C1', T1)], cursor: T1, timedOut: false },
        // 서버가 같은 밀리초 상담을 다시 주는 경우 + 새 상담
        [T1]: { items: [item('C1', T1), item('C2', '2026-11-04T01:06:00.000Z')], cursor: '2026-11-04T01:06:00.000Z', timedOut: false },
      }),
    );
    await call('wait_for_updates');
    const second = await call('wait_for_updates');
    expect(calls[1]!.url.searchParams.get('since')).toBe(T0);
    expect(second.text).toContain(`마지막 cursor ${T0} 자동 사용`);
    expect(second.text).toContain('] C1 ');
    const third = await call('wait_for_updates');
    expect(calls[2]!.url.searchParams.get('since')).toBe(T1);
    expect(third.text).toContain('바뀐 상담 1건');
    expect(third.text).not.toContain('] C1 ');
    expect(third.text).toContain('] C2 ');
  });

  it('채널별로 따로 기억한다', async () => {
    const { call, calls } = await connect(makeConfig(), () => ({ body: { items: [], cursor: '2026-11-04T01:00:00.000Z', timedOut: true } }));
    await call('wait_for_updates', { channelId: 'CH_A' });
    await call('wait_for_updates', { channelId: 'CH_B' });
    expect(calls[1]!.url.searchParams.has('since')).toBe(false);
    await call('wait_for_updates', { channelId: 'CH_A' });
    expect(calls[2]!.url.searchParams.get('since')).toBe('2026-11-04T01:00:00.000Z');
  });

  it('dedupeUpdates: 최근 dateUpdated 를 남기고 seen 키를 뺀다', () => {
    const out = dedupeUpdates(
      [item('A', '2026-11-04T01:00:00Z'), item('B', '2026-11-04T01:00:00Z'), item('A', '2026-11-04T01:01:00Z')],
      new Set(['B@2026-11-04T01:00:00Z']),
    );
    expect(out.map((x) => (x as { consultId: string; dateUpdated: string }).dateUpdated)).toEqual(['2026-11-04T01:01:00Z']);
  });

  describe('trusted(호스팅) 모드', () => {
    let running: RunningHttpServer | undefined;
    let client: Client | undefined;
    afterEach(async () => {
      await client?.close();
      await running?.close();
      running = undefined;
      client = undefined;
    });

    it('cursor 를 기억하지 않고 매번 since 를 넘기라고 안내', async () => {
      const { fetch, calls } = mockFetch(() => ({ body: { items: [], cursor: '2026-11-04T01:00:00.000Z', timedOut: false } }));
      const config = makeConfig({ mode: 'trusted', apiKey: '', apiSecret: '', channelId: undefined, credentialSource: 'trusted-headers' });
      running = await startHttpServer(createContext(config, { fetch }), {
        port: 0,
        host: '127.0.0.1',
        path: '/talk-mcp-server/v1/mcp',
        trusted: true,
      });
      client = new Client({ name: 't', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(running.url), {
          requestInit: { headers: { 'x-authenticated-member-id': 'MEM1', 'x-channel-id': 'CH_T' } },
        }),
      );
      const call = async () => {
        const res = await client!.callTool({ name: 'wait_for_updates', arguments: {} });
        return (res.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      };
      const first = await call();
      expect(first).toContain('호스팅 모드는 cursor 를 기억하지 않습니다');
      await call();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url.searchParams.has('since')).toBe(false);
      expect(calls[1]!.headers['x-authenticated-member-id']).toBe('MEM1');
      expect(calls[1]!.headers['x-channel-id']).toBe('CH_T');
    });
  });
});

describe('대기 모드 프롬프트', () => {
  it('handle_pending_inquiries 에 대기 모드 절', async () => {
    const { client } = await connect(makeConfig(), () => undefined);
    const got = await client.getPrompt({ name: 'handle_pending_inquiries' });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toContain('## 대기 모드');
    expect(text).toContain('wait_for_updates(since=cursor)');
    expect(text).toContain('get_messages');
    expect(text).toContain('confirmed:false');
    expect(text).toContain('assign');
  });

  it('watch_inquiries: cycles 기본 10·지정·상한', async () => {
    const { client } = await connect(makeConfig(), () => undefined);
    const names = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(names).toContain('watch_inquiries');
    const text = async (args?: Record<string, string>) =>
      ((await client.getPrompt({ name: 'watch_inquiries', arguments: args })).messages[0]!.content as { text: string }).text;
    expect(await text()).toContain('최대 10회');
    expect(await text({ cycles: '3' })).toContain('최대 3회');
    expect(await text({ cycles: '9999' })).toContain('최대 100회');
    expect(await text({ cycles: 'abc' })).toContain('최대 10회');
    const t = await text();
    expect(t).toContain('wait_for_updates');
    expect(t).toContain('confirmed:true');
    expect(t).toContain('환불');
  });
});
