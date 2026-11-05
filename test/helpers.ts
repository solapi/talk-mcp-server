import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FetchLike } from '../src/api/client.js';
import type { Config } from '../src/config.js';
import { createContext, createServer } from '../src/server.js';

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: 'apikey',
    apiKey: 'NCSTESTKEY',
    apiSecret: 'test-secret-value',
    apiHost: 'https://api.example.test',
    channelId: 'CH_A',
    enableWrite: false,
    disableWrite: false,
    allowedChannels: null,
    showPii: false,
    credentialSource: 'env',
    ...overrides,
  };
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export function mockFetch(route: Route): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = route(call) ?? { status: 404, body: { errorCode: 'NotFound', errorMessage: 'no route' } };
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status,
      headers: { 'Content-Type': 'application/json', ...r.headers },
    });
  };
  return { fetch, calls };
}

export async function connect(config: Config, route: Route, now?: () => number) {
  const { fetch, calls } = mockFetch(route);
  const ctx = createContext(config, { fetch, now });
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    return { text: content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { client, server, ctx, calls, call };
}
