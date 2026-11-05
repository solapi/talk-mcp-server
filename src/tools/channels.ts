import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { asList, asObj, str } from '../format.js';
import { apiErrorResult, errorResult, textResult, type ToolContext } from './common.js';

function channelName(ch: Record<string, unknown>): string {
  return str(ch.channelName) ?? str(ch.name) ?? '(이름 없음)';
}

export function registerChannelTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_channels',
    {
      title: '내 채널 목록',
      description:
        'API Key 소유자가 매니저로 속한 솔라피톡 채널 목록을 조회합니다. 채널이 정해지지 않았다면 먼저 이 도구로 고른 뒤 use_channel 을 호출하세요.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const res = await ctx.client.get('/talk/v1/channels/my');
      if (!res.ok) return apiErrorResult(res.error);
      const channels = asList(res.data, 'channels').map(asObj);
      if (channels.length === 0) return textResult('속한 채널이 없습니다. API Key 소유자가 채널 매니저인지 확인하세요.');
      const lines = channels.map((ch) => {
        const id = str(ch.channelId) ?? str(ch.id) ?? '?';
        const marks = [
          id === ctx.guard.defaultChannelId() ? '현재 선택' : undefined,
          ctx.guard.isChannelAllowed(id) ? undefined : 'allowlist 밖',
          str(ch.role) ? `역할 ${str(ch.role)}` : undefined,
          ch.mcpAgentEnabled === false ? 'MCP 미개방' : undefined,
        ].filter(Boolean);
        return `- ${id} ${channelName(ch)}${marks.length ? ` (${marks.join(', ')})` : ''}`;
      });
      return textResult(`채널 ${channels.length}개\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'use_channel',
    {
      title: '작업 채널 선택',
      description:
        '이 세션에서 사용할 채널을 고릅니다(프로세스 재시작 시 초기화). SOLAPI_TALK_MCP_ALLOWED_CHANNELS 가 있으면 그 안의 채널만 고를 수 있습니다.',
      inputSchema: { channelId: z.string().min(1).describe('list_channels 에서 확인한 채널 ID') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ channelId }) => {
      if (ctx.guard.trusted) {
        return errorResult(
          '[UNSUPPORTED_IN_HOSTED_MODE] 호스팅(trusted) 모드는 요청 사이에 세션이 없어 채널을 기억하지 않습니다. 채널이 필요한 도구마다 channelId 인자를 넘기거나, MCP 클라이언트 설정에 x-channel-id 헤더를 넣으세요.',
        );
      }
      const id = channelId.trim();
      if (!ctx.guard.isChannelAllowed(id)) {
        return errorResult(`[CHANNEL_NOT_ALLOWED] 채널 ${id} 는 SOLAPI_TALK_MCP_ALLOWED_CHANNELS 에 없어 고를 수 없습니다.`);
      }
      const res = await ctx.client.get('/talk/v1/channels/my');
      let warning = '';
      if (res.ok) {
        const ids = asList(res.data, 'channels').map((c) => str(asObj(c).channelId) ?? str(asObj(c).id));
        if (!ids.includes(id)) {
          return errorResult(`채널 ${id} 는 이 API Key 소유자의 채널 목록에 없습니다. list_channels 로 확인하세요.`);
        }
      } else {
        warning = `\n(채널 목록 확인 실패: ${res.error.code} — 선택은 했지만 실제 접근 권한은 다음 호출에서 확인됩니다.)`;
      }
      ctx.session.channelId = id;
      return textResult(`이 세션의 작업 채널을 ${id} 로 정했습니다.${warning}`);
    },
  );
}
