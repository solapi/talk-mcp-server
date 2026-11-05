import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/api/client.js';
import { parseArgs } from '../src/cli.js';
import { ConfigError, DEFAULT_TRUSTED_API_BASE, isTrustedMode, loadConfig } from '../src/config.js';
import { startHttpServer, type RunningHttpServer } from '../src/http.js';
import { readTrustedHeader } from '../src/scope.js';
import { createContext } from '../src/server.js';
import { TALK_CLIENT_HEADER_VALUE } from '../src/version.js';
import { makeConfig, type RecordedCall } from './helpers.js';

const TRUSTED_PATH = '/talk-mcp-server/v1/mcp';

function trustedConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({
    mode: 'trusted',
    apiKey: '',
    apiSecret: '',
    apiHost: 'http://talk-upstream.test:7001',
    channelId: undefined,
    credentialSource: 'trusted-headers',
    ...overrides,
  });
}

/** 업스트림(솔라피톡 API) 목. 멤버 A 응답만 늦게 돌려 두 요청이 겹치게 만든다. */
function upstream(delayFor: Record<string, number> = {}) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const member = headers['x-authenticated-member-id'] ?? '?';
    const delay = delayFor[member] ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const p = call.url.pathname;
    let body: unknown = { errorCode: 'NotFound', errorMessage: 'no route' };
    let status = 404;
    if (call.method === 'GET' && p === '/talk/v1/channels/my') {
      status = 200;
      body = { channels: [{ channelId: `CH_${member}`, name: `채널-${member}` }] };
    } else if (call.method === 'GET' && p === '/talk/v1/tags') {
      status = 200;
      body = [{ tagId: 'T1', tagName: `태그-${headers['x-channel-id']}` }];
    } else if (call.method === 'GET' && p === '/talk/v1/consults/C1') {
      status = 200;
      body = { consultId: 'C1', memberName: '고객' };
    } else if (call.method === 'POST' && p === '/talk/v1/consults/C1/messages') {
      status = 201;
      body = { chat: { chatId: `K_${member}`, dateCreated: new Date().toISOString() } };
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}

async function connectClient(url: string, headers: Record<string, string>) {
  const client = new Client({ name: 'trusted-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return { text: content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { client, call };
}

describe('trusted(게이트웨이 뒤) 모드', () => {
  let running: RunningHttpServer | undefined;
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await running?.close();
    running = undefined;
  });

  async function start(delayFor?: Record<string, number>, configOverrides: Parameters<typeof makeConfig>[0] = {}) {
    const up = upstream(delayFor);
    running = await startHttpServer(createContext(trustedConfig(configOverrides), { fetch: up.fetch }), {
      port: 0,
      host: '127.0.0.1',
      path: TRUSTED_PATH,
      trusted: true,
    });
    return up;
  }

  async function as(member: string, extra: Record<string, string> = {}) {
    const c = await connectClient(running!.url, { 'x-authenticated-member-id': member, ...extra });
    clients.push(c.client);
    return c.call;
  }

  it('(a) 신원 헤더 없는 MCP 요청은 401 JSON-RPC 에러', async () => {
    await start();
    const res = await fetch(running!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'HMAC-SHA256 apiKey=x' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('x-authenticated-member-id');
    // 공백 값도 없는 것으로 본다
    const blank = await fetch(running!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-authenticated-member-id': '   ' },
      body: '{}',
    });
    expect(blank.status).toBe(401);
  });

  it('(b) 업스트림에 신원·채널·클라이언트 헤더를 그대로 싣고 Authorization 은 붙이지 않는다', async () => {
    const up = await start();
    const call = await as('MEM_A', { 'x-authenticated-account-id': 'ACC_A', 'x-channel-id': 'CH_X', Authorization: 'HMAC-SHA256 apiKey=client' });
    const res = await call('list_tags');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('태그-CH_X');
    const req = up.calls[0]!;
    expect(req.url.origin).toBe('http://talk-upstream.test:7001');
    expect(req.url.pathname).toBe('/talk/v1/tags');
    expect(req.headers['x-authenticated-member-id']).toBe('MEM_A');
    expect(req.headers['x-authenticated-account-id']).toBe('ACC_A');
    expect(req.headers['x-channel-id']).toBe('CH_X');
    expect(req.headers['x-talk-client']).toBe(TALK_CLIENT_HEADER_VALUE);
    expect(Object.keys(req.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('(c) 동시 요청 두 개가 서로의 memberId 컨텍스트를 섞지 않는다', async () => {
    const up = await start({ MEM_A: 60 });
    const callA = await as('MEM_A');
    const callB = await as('MEM_B');
    const [a, b] = await Promise.all([callA('list_channels'), callB('list_channels')]);
    expect(a.text).toContain('CH_MEM_A');
    expect(a.text).not.toContain('MEM_B');
    expect(b.text).toContain('CH_MEM_B');
    expect(b.text).not.toContain('MEM_A');
    const members = up.calls.map((c) => c.headers['x-authenticated-member-id']).sort();
    expect(members).toEqual(['MEM_A', 'MEM_B']);
  });

  it('(c) 쓰기 기록(중복 차단·멱등키)도 memberId 별로 나뉜다', async () => {
    const up = await start({ MEM_A: 40 });
    const callA = await as('MEM_A', { 'x-channel-id': 'CH_1' });
    const callB = await as('MEM_B', { 'x-channel-id': 'CH_1' });
    const [a, b] = await Promise.all([
      callA('reply', { consultId: 'C1', text: '안녕하세요', confirmed: true }),
      callB('reply', { consultId: 'C1', text: '안녕하세요', confirmed: true }),
    ]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    const posts = up.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    const keyOf = (m: string) => posts.find((c) => c.headers['x-authenticated-member-id'] === m)!.headers['Idempotency-Key'];
    expect(keyOf('MEM_A')).not.toBe(keyOf('MEM_B'));
    // 같은 멤버가 같은 본문을 바로 다시 보내면 그 멤버만 중복 차단
    const again = await callA('reply', { consultId: 'C1', text: '안녕하세요', confirmed: true });
    expect(again.text).toContain('REPLY_DUPLICATE');
    const other = await callB('reply', { consultId: 'C1', text: '다른 본문', confirmed: true });
    expect(other.isError).toBe(false);
  });

  it('(d) GET /healthcheck 200, MCP 경로 GET 은 405, 다른 경로 404', async () => {
    await start();
    const base = running!.url.replace(TRUSTED_PATH, '');
    const health = await fetch(`${base}/healthcheck`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', mode: 'trusted', version: expect.any(String) });
    expect((await fetch(`${base}/healthcheck`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(running!.url, { headers: { 'x-authenticated-member-id': 'M' } })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(404);
  });

  it('(e) trusted 는 토큰 없이 0.0.0.0 바인드 허용', async () => {
    running = await startHttpServer(createContext(trustedConfig()), { port: 0, host: '0.0.0.0', path: TRUSTED_PATH, trusted: true });
    expect(running.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+\/talk-mcp-server\/v1\/mcp$/);
  });

  it('trusted 플래그와 context 설정이 어긋나면 기동 거부', async () => {
    await expect(startHttpServer(createContext(makeConfig()), { port: 0, trusted: true })).rejects.toThrow(/trusted/);
    await expect(startHttpServer(createContext(trustedConfig()), { port: 0 })).rejects.toThrow(/trusted/);
  });

  it('채널: 헤더 → 인자, 둘 다 없으면 list_channels 안내, 둘이 다르면 거부', async () => {
    const up = await start();
    const noHeader = await as('MEM_A');
    const missing = await noHeader('list_tags');
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('CHANNEL_REQUIRED');
    expect(missing.text).toContain('list_channels');
    const byArg = await noHeader('list_tags', { channelId: 'CH_ARG' });
    expect(byArg.text).toContain('태그-CH_ARG');
    expect(up.calls.at(-1)!.headers['x-channel-id']).toBe('CH_ARG');

    const withHeader = await as('MEM_A', { 'x-channel-id': 'CH_H' });
    expect((await withHeader('list_tags', { channelId: 'CH_H' })).isError).toBe(false);
    const conflict = await withHeader('list_tags', { channelId: 'CH_OTHER' });
    expect(conflict.text).toContain('CHANNEL_CONFLICT');
  });

  it('use_channel 은 미지원, enable_write 는 설명만, 쓰기는 confirmed 2단계로 바로 동작', async () => {
    const up = await start();
    const call = await as('MEM_A', { 'x-channel-id': 'CH_1' });
    const use = await call('use_channel', { channelId: 'CH_1' });
    expect(use.isError).toBe(true);
    expect(use.text).toContain('channelId 인자');
    const enable = await call('enable_write');
    expect(enable.isError).toBe(false);
    expect(enable.text).toContain('confirmed');

    const preview = await call('reply', { consultId: 'C1', text: '확인했습니다' });
    expect(preview.isError).toBe(false);
    expect(preview.text).toContain('미리보기');
    expect(up.calls.some((c) => c.method === 'POST')).toBe(false);
    const sent = await call('reply', { consultId: 'C1', text: '확인했습니다', confirmed: true });
    expect(sent.isError).toBe(false);
    expect(up.calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    const policy = JSON.parse((await call('get_policy')).text) as Record<string, unknown>;
    expect(policy.mode).toMatch(/^trusted/);
    expect(policy.writeEnabled).toBe(true);
    expect(policy.currentChannelId).toBe('CH_1');
  });

  it('하드락·allowlist 는 trusted 에서도 적용된다', async () => {
    await start(undefined, { disableWrite: true, allowedChannels: ['CH_OK'] });
    const call = await as('MEM_A');
    expect((await call('enable_write')).text).toContain('WRITE_HARD_LOCKED');
    expect((await call('add_note', { consultId: 'C1', noteContent: 'x', channelId: 'CH_OK' })).text).toContain('WRITE_HARD_LOCKED');
    expect((await call('list_tags', { channelId: 'CH_NO' })).text).toContain('CHANNEL_NOT_ALLOWED');
  });
});

describe('trusted 설정·CLI', () => {
  it('loadConfig trusted: API Key 불필요, 기본 업스트림, 채널·부팅 쓰기 env 무시', () => {
    const c = loadConfig(
      { SOLAPI_TALK_CHANNEL_ID: 'CH', SOLAPI_TALK_MCP_ENABLE_WRITE: 'true', SOLAPI_TALK_MCP_DISABLE_WRITE: '1' },
      undefined,
      { trusted: true },
    );
    expect(c).toMatchObject({
      mode: 'trusted',
      apiHost: DEFAULT_TRUSTED_API_BASE,
      channelId: undefined,
      enableWrite: false,
      disableWrite: true,
      credentialSource: 'trusted-headers',
    });
    expect(loadConfig({ TALK_API_BASE: 'http://talk.local:7001/' }, undefined, { trusted: true }).apiHost).toBe('http://talk.local:7001');
    expect(() => loadConfig({ TALK_API_BASE: 'talk-upstream:7001' }, undefined, { trusted: true })).toThrow(ConfigError);
  });

  it('isTrustedMode: --trusted 또는 TALK_MCP_MODE=trusted', () => {
    expect(isTrustedMode(true, {})).toBe(true);
    expect(isTrustedMode(false, { TALK_MCP_MODE: 'Trusted' })).toBe(true);
    expect(isTrustedMode(false, { TALK_MCP_MODE: 'apikey' })).toBe(false);
  });

  it('parseArgs: --trusted·--path', () => {
    expect(parseArgs(['--http', '7001', '--trusted', '--path', TRUSTED_PATH])).toMatchObject({ httpPort: 7001, trusted: true, path: TRUSTED_PATH });
    expect(() => parseArgs(['--path', 'mcp'])).toThrow();
    expect(() => parseArgs(['--path'])).toThrow();
  });

  it('readTrustedHeader: 중복은 첫 값, 공백·제어문자·과길이는 거부', () => {
    expect(readTrustedHeader(['M1', 'M2'])).toBe('M1');
    expect(readTrustedHeader(' M1 ')).toBe('M1');
    expect(readTrustedHeader('a b')).toBeUndefined();
    expect(readTrustedHeader('x'.repeat(129))).toBeUndefined();
    expect(readTrustedHeader(undefined)).toBeUndefined();
  });
});
