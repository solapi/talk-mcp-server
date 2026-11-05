import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithScope, scopeFromHeaders, TRUSTED_HEADERS } from './scope.js';
import { createServer } from './server.js';
import type { ToolContext } from './tools/common.js';
import { PACKAGE_VERSION } from './version.js';

export const MCP_PATH = '/mcp';
export const HEALTHCHECK_PATH = '/healthcheck';
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  port: number;
  host?: string;
  /** MCP 엔드포인트 경로 (기본 /mcp). 게이트웨이 뒤에서는 /talk-mcp-server/v1/mcp */
  path?: string;
  /**
   * 게이트웨이 뒤 trusted 모드: 요청마다 x-authenticated-member-id 를 요구하고 그 신원으로 도구를 실행한다.
   * 비루프백 바인드를 허용하고 bearerToken 은 쓰지 않는다. ctx 도 trusted 설정으로 만들어야 한다.
   */
  trusted?: boolean;
  /** 설정 시 Authorization: Bearer <token> 을 요구한다 (단일 키 모드 전용, trusted 에서는 무시) */
  bearerToken?: string;
  /** 비루프백 주소에 토큰 없이 띄우는 것을 명시적으로 허용 (--insecure-no-token, 단일 키 모드 전용) */
  allowInsecureNoToken?: boolean;
}

export class InsecureHttpBindError extends Error {
  override name = 'InsecureHttpBindError';
}

/** 길이 차이로 새는 정보를 막기 위해 해시 후 상수 시간 비교 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

export interface RunningHttpServer {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * 무상태 Streamable HTTP. 요청마다 McpServer+transport 를 새로 만들고(세션 ID 미사용),
 * 단일 키 모드는 쓰기 활성화·채널 선택 같은 상태가 프로세스 공용 context 에 남는다.
 * trusted 모드는 요청자 신원·채널을 AsyncLocalStorage 요청 범위에만 두고 프로세스 전역 상태를 쓰지 않는다.
 */
export async function startHttpServer(ctx: ToolContext, options: HttpOptions): Promise<RunningHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const trusted = options.trusted === true;
  const mcpPath = options.path ?? MCP_PATH;
  if (trusted !== (ctx.config.mode === 'trusted')) {
    throw new Error('trusted HTTP 서버는 trusted 설정(context)과 함께만 띄울 수 있습니다.');
  }
  // trusted 는 게이트웨이만 닿는 클러스터 내부 서비스라 0.0.0.0 바인드를 허용한다(인증은 게이트웨이 스탬프 헤더).
  if (!trusted && !isLoopback(host) && !options.bearerToken && !options.allowInsecureNoToken) {
    throw new InsecureHttpBindError(
      `루프백이 아닌 주소(${host})에 띄우려면 SOLAPI_TALK_MCP_HTTP_TOKEN 을 설정하세요. 정말 토큰 없이 열려면 --insecure-no-token 을 명시해야 합니다.`,
    );
  }
  const bearerToken = trusted ? undefined : options.bearerToken;

  const httpServer = createHttpServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === HEALTHCHECK_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' }).end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: 'ok', version: PACKAGE_VERSION, mode: trusted ? 'trusted' : 'http' }));
      return;
    }
    if (path !== mcpPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    if (bearerToken && !bearerMatches(req.headers.authorization, bearerToken)) {
      sendJsonRpcError(res, 401, 'Unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      // 무상태 모드: 서버→클라이언트 SSE 스트림(GET)·세션 종료(DELETE)는 지원하지 않는다.
      res.setHeader('Allow', 'POST');
      sendJsonRpcError(res, 405, 'Method Not Allowed (stateless server: POST only)');
      return;
    }
    // trusted: 게이트웨이가 인증 후 스탬프한 신원 헤더가 없으면 거부한다(값은 로그에 남기지 않는다).
    const scope = trusted ? scopeFromHeaders(req.headers) : undefined;
    if (trusted && !scope) {
      console.error(`[talk-mcp-server] 신원 헤더(${TRUSTED_HEADERS.memberId}) 없는 요청 거부 (401)`);
      sendJsonRpcError(res, 401, `Unauthorized: ${TRUSTED_HEADERS.memberId} 헤더가 없습니다. 게이트웨이를 거쳐 API Key 또는 콘솔 로그인으로 호출하세요.`);
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const tooLarge = (err as Error).message === 'BODY_TOO_LARGE';
      sendJsonRpcError(res, tooLarge ? 413 : 400, tooLarge ? 'Request body too large' : 'Invalid JSON');
      return;
    }

    const mcp = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(isLoopback(host)
        ? {
            enableDnsRebindingProtection: true,
            allowedHosts: [`127.0.0.1:${actualPort()}`, `localhost:${actualPort()}`, `[::1]:${actualPort()}`],
          }
        : {}),
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    const handle = async () => {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    };
    try {
      // trusted: 이 요청에서 파생되는 모든 도구 호출이 같은 신원을 보도록 요청 범위로 감싼다.
      await (scope ? runWithScope(scope, handle) : handle());
    } catch (err) {
      const who = scope ? ` (member ${scope.memberId})` : '';
      console.error(`[talk-mcp-server] HTTP 요청 처리 실패${who}:`, (err as Error).message);
      sendJsonRpcError(res, 500, 'Internal server error');
    }
  });

  function actualPort(): number {
    return (httpServer.address() as AddressInfo | null)?.port ?? options.port;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${actualPort()}${mcpPath}`,
    server: httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections?.();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
