#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from './cli.js';
import { ConfigError, isTrustedMode, loadConfig, TRUSTED_IGNORED_ENV } from './config.js';
import { InsecureHttpBindError, startHttpServer } from './http.js';
import { createContext, createServer } from './server.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${PACKAGE_VERSION}
솔라피톡 MCP 서버

사용법:
  talk-mcp-server                 stdio 로 실행 (MCP 클라이언트가 실행)
  talk-mcp-server --http <port>   Streamable HTTP(무상태)로 실행, 경로 /mcp
      --host <host>               바인드 주소 (기본 127.0.0.1, --trusted 는 0.0.0.0)
      --path <path>               MCP 엔드포인트 경로 (기본 /mcp)
      --insecure-no-token         루프백이 아닌 주소에 토큰 없이 띄우는 것을 허용 (단일 키 모드, 권장하지 않음)
      --trusted                   게이트웨이 뒤 호스팅 모드 (TALK_MCP_MODE=trusted 와 같음).
                                  게이트웨이가 스탬프한 x-authenticated-member-id 로 요청마다 솔라피톡 API(TALK_API_BASE)를 부른다
  GET /healthcheck                200 { status, version, mode }

환경변수는 README 를 참고하세요. (SOLAPI_API_KEY, SOLAPI_API_SECRET 또는 SOLAPI_PROFILE, SOLAPI_TALK_CHANNEL_ID …)`;

function registerShutdown(close: () => Promise<void>): void {
  const shutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error(HELP);
    return;
  }
  if (args.version) {
    console.error(PACKAGE_VERSION);
    return;
  }

  const trusted = isTrustedMode(args.trusted);
  if (trusted && args.httpPort === undefined) {
    throw new ConfigError('trusted 모드(--trusted / TALK_MCP_MODE=trusted)는 --http <port> 와 함께만 쓸 수 있습니다.');
  }

  const config = loadConfig(process.env, undefined, { trusted });
  const ctx = createContext(config);

  if (trusted && args.httpPort !== undefined) {
    const ignored = TRUSTED_IGNORED_ENV.filter((k) => process.env[k]?.trim());
    if (ignored.length > 0) {
      console.error(`[talk-mcp-server] 경고: trusted 모드는 테넌트 공용 설정을 쓰지 않아 다음 환경변수를 무시합니다: ${ignored.join(', ')}`);
    }
    if (args.insecureNoToken) console.error('[talk-mcp-server] 참고: --insecure-no-token 은 trusted 모드에서 의미가 없어 무시합니다.');
    const running = await startHttpServer(ctx, {
      port: args.httpPort,
      host: args.host ?? '0.0.0.0',
      path: args.path,
      trusted: true,
    });
    console.error(
      `[talk-mcp-server] ${PACKAGE_VERSION} 시작 (trusted) — 업스트림 ${config.apiHost}, 쓰기 ${config.disableWrite ? '하드락' : 'confirmed 2단계'}, 채널 allowlist ${
        config.allowedChannels ? config.allowedChannels.length + '개' : '없음'
      }, PII ${config.showPii ? '평문' : '마스킹'}`,
    );
    console.error(`[talk-mcp-server] Streamable HTTP 대기 중: ${running.url}`);
    registerShutdown(running.close);
    return;
  }

  const mode = args.httpPort !== undefined ? 'http' : 'stdio';
  console.error(
    `[talk-mcp-server] ${PACKAGE_VERSION} 시작 (${mode}) — 자격증명 ${config.credentialSource}, 채널 ${config.channelId ?? '미선택'}, 쓰기 ${
      config.disableWrite ? '하드락' : config.enableWrite ? '활성' : '비활성'
    }, PII ${config.showPii ? '평문' : '마스킹'}`,
  );

  if (args.httpPort !== undefined) {
    const host = args.host ?? '127.0.0.1';
    const running = await startHttpServer(ctx, {
      port: args.httpPort,
      host,
      path: args.path,
      bearerToken: process.env.SOLAPI_TALK_MCP_HTTP_TOKEN?.trim() || undefined,
      allowInsecureNoToken: args.insecureNoToken,
    });
    if (args.insecureNoToken && !process.env.SOLAPI_TALK_MCP_HTTP_TOKEN?.trim()) {
      console.error('[talk-mcp-server] 경고: --insecure-no-token — 접근 가능한 누구나 이 API Key 로 상담을 조작할 수 있습니다.');
    }
    console.error(`[talk-mcp-server] Streamable HTTP 대기 중: ${running.url}`);
    registerShutdown(running.close);
    return;
  }

  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[talk-mcp-server] 설정 오류: ${err.message}`);
  } else if (err instanceof InsecureHttpBindError) {
    console.error(`[talk-mcp-server] 기동 거부: ${err.message}`);
  } else {
    console.error(`[talk-mcp-server] 실행 실패: ${(err as Error)?.message ?? String(err)}`);
  }
  process.exit(1);
});
