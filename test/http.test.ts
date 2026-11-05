import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerMatches, InsecureHttpBindError, startHttpServer, type RunningHttpServer } from '../src/http.js';
import { createContext } from '../src/server.js';
import { makeConfig, mockFetch } from './helpers.js';

const EXPECTED_TOOLS = [
  'add_note',
  'add_tags',
  'assign',
  'enable_write',
  'get_consult',
  'get_messages',
  'get_notes',
  'get_policy',
  'list_channels',
  'list_consults',
  'list_tags',
  'list_templates',
  'remove_tag',
  'reply',
  'search',
  'set_status',
  'update_note',
  'use_channel',
  'wait_for_updates',
];

describe('--http 모드 (무상태 Streamable HTTP)', () => {
  let running: RunningHttpServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('SDK Client 로 tools/list 왕복', async () => {
    const { fetch } = mockFetch(() => undefined);
    running = await startHttpServer(createContext(makeConfig(), { fetch }), { port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
  });

  it('비루프백 + 토큰 없음은 기동 거부, --insecure-no-token 이면 허용', async () => {
    const ctx = createContext(makeConfig());
    await expect(startHttpServer(ctx, { port: 0, host: '0.0.0.0' })).rejects.toBeInstanceOf(InsecureHttpBindError);
    running = await startHttpServer(ctx, { port: 0, host: '0.0.0.0', allowInsecureNoToken: true });
    expect(running.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+\/mcp$/);
  });

  it('bearerMatches 는 상수 시간 비교', () => {
    expect(bearerMatches('Bearer tok', 'tok')).toBe(true);
    expect(bearerMatches('Bearer to', 'tok')).toBe(false);
    expect(bearerMatches(undefined, 'tok')).toBe(false);
  });

  it('bearer 토큰이 설정되면 없는 요청은 401', async () => {
    running = await startHttpServer(createContext(makeConfig()), { port: 0, host: '127.0.0.1', bearerToken: 'tok' });
    const res = await fetch(running.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
