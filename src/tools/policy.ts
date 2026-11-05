import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guardErrorResult, textResult, type ToolContext } from './common.js';

export function registerPolicyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'enable_write',
    {
      title: '쓰기 도구 활성화(세션 한정)',
      description:
        '사용자가 명시적으로 요청했을 때만 호출하세요. 이 세션 동안 쓰기 도구(reply·노트·배정·상태·태그)를 켭니다. 프로세스를 재시작하면 다시 꺼지고, SOLAPI_TALK_MCP_DISABLE_WRITE=true 이면 켤 수 없습니다. 켠 뒤에도 각 쓰기는 confirmed 2단계를 거칩니다.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      if (ctx.guard.trusted) {
        if (ctx.config.disableWrite) {
          return guardErrorResult({
            ok: false,
            code: 'WRITE_HARD_LOCKED',
            message: 'SOLAPI_TALK_MCP_DISABLE_WRITE=true 로 이 서버의 쓰기가 잠겨 있습니다. 도구로 풀 수 없습니다.',
          });
        }
        return textResult(
          '호스팅(trusted) 모드에는 세션 단위 쓰기 활성화가 없습니다. 여러 사용자가 한 서버를 함께 쓰므로 켜고 끄는 상태를 두지 않고, 모든 쓰기 도구는 confirmed:false 미리보기 → 사용자 확인 → confirmed:true 실행의 2단계로만 동작합니다. 이 호출로 바뀐 것은 없습니다.',
        );
      }
      const decision = ctx.guard.enableWrite();
      if (!decision.ok) return guardErrorResult(decision);
      return textResult('이 세션 동안 쓰기 도구를 활성화했습니다. 각 쓰기는 여전히 confirmed:false 미리보기 → confirmed:true 실행 순서로 진행됩니다.');
    },
  );

  server.registerTool(
    'get_policy',
    {
      title: '현재 안전 정책 조회',
      description: '쓰기 활성화 여부·하드락·채널 allowlist·PII 마스킹·답장 상한 등 현재 안전 가드 상태를 보여줍니다.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => textResult(JSON.stringify(ctx.guard.policy(), null, 2)),
  );
}
