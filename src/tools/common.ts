import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApiError, TalkApiClient } from '../api/client.js';
import type { Config } from '../config.js';
import type { GuardDecision, SessionState, WriteGuard } from '../guard.js';
import { truncateOutput, UNTRUSTED_NOTICE } from '../text.js';

export interface ToolContext {
  config: Config;
  client: TalkApiClient;
  session: SessionState;
  guard: WriteGuard;
}

export function textResult(text: string, options: { untrusted?: boolean } = {}): CallToolResult {
  const body = options.untrusted ? `${UNTRUSTED_NOTICE}\n\n${text}` : text;
  return { content: [{ type: 'text', text: truncateOutput(body) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: truncateOutput(message) }], isError: true };
}

const API_ERROR_HINTS: Record<string, string> = {
  ManagerRoleReadOnly: '이 API Key 소유자는 채널에서 읽기 전용(VIEWER) 역할이라 쓰기를 할 수 없습니다.',
  ReplyRateLimited:
    '서버 레이트리밋(채널 60/분·매니저 30/분)에 걸렸습니다. 잠시 후 다시 시도하세요(다음 시도는 새 멱등키로 보냅니다).',
  IdempotencyKeyRequired: '서버가 Idempotency-Key 를 요구했습니다(클라이언트 버그일 수 있음).',
  InvalidIdempotencyKey: '서버가 Idempotency-Key 형식을 거부했습니다(클라이언트 버그일 수 있음).',
  IdempotentRequestInProgress:
    '같은 답장이 아직 처리 중입니다. 30초쯤 기다린 뒤 get_messages 로 전송 여부를 먼저 확인하고, 안 갔을 때만 다시 시도하세요.',
  ChannelAccessDenied: '이 API Key 소유자는 현재 채널에 접근할 수 없습니다. list_channels 로 확인하세요.',
  TalkMcpAgentNotEnabled:
    '이 채널은 AI 에이전트(MCP) 접근이 아직 열려 있지 않습니다. 솔라피 운영팀에 채널의 AI 에이전트 허용을 요청하세요. list_channels 에서 "MCP 미개방" 표시로 확인할 수 있습니다.',
  ChannelIdRequired: '채널 ID 가 전달되지 않았습니다. use_channel 로 채널을 고르거나 도구의 channelId 인자를 넘기세요.',
  ConsultNotFound: '상담을 찾을 수 없습니다. consultId 와 현재 채널을 확인하세요.',
  ReplyMessageRequired: '보낼 본문이 비어 있습니다.',
  ConsultFilterConflict: 'unassigned 와 managerId 는 함께 쓸 수 없습니다.',
  NoteEditForbidden: '노트는 작성자 본인 또는 채널 OWNER 만 수정할 수 있습니다.',
  NoteContentRequired: '노트 내용이 비어 있습니다.',
};

export function apiErrorResult(error: ApiError): CallToolResult {
  const status = error.status ? ` HTTP ${error.status}` : '';
  // 일부 404 는 { errorCode:'ResourceNotFound', errorMessage:'ConsultNotFound' } 처럼 구체 코드가 message 에 온다
  const hint = API_ERROR_HINTS[error.code] ?? API_ERROR_HINTS[error.message];
  let extra = hint ? `\n${hint}` : '';
  if (!hint && (error.status === 401 || error.status === 403)) {
    extra = '\nAPI Key 가 올바른지, 키 소유자가 이 채널의 매니저인지 확인하세요.';
  }
  return errorResult(`API 오류(${error.code}${status}): ${error.message}${extra}`);
}

export function guardErrorResult(decision: Exclude<GuardDecision, { ok: true }>): CallToolResult {
  return errorResult(`[${decision.code}] ${decision.message}`);
}

/** 채널이 필요한 도구 공통 선택 인자. 호스팅(trusted) 모드처럼 세션이 없을 때 채널을 정하는 수단이다. */
export const channelIdArgSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    '작업할 채널 ID (list_channels). 생략하면 현재 채널(use_channel·SOLAPI_TALK_CHANNEL_ID, 호스팅 모드는 x-channel-id 헤더)을 씁니다.',
  );

/** 채널을 확정하고 콜백을 실행한다. 채널이 없거나 allowlist 밖이면 안내 오류. */
export async function withChannel(
  ctx: ToolContext,
  channelArg: string | undefined,
  fn: (channelId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const resolved = ctx.guard.resolveChannel(channelArg);
  if (!resolved.ok) return errorResult(`[${resolved.code}] ${resolved.message}`);
  return fn(resolved.channelId);
}

export const PREVIEW_FOOTER =
  '※ 아직 실행되지 않았습니다(미리보기). 사용자에게 내용을 보여주고 확인을 받은 뒤 같은 인자에 confirmed:true 를 붙여 다시 호출하세요.';

export interface WriteSpec {
  confirmed: boolean | undefined;
  /** 도구 인자 channelId (선택) */
  channelId?: string;
  /** 도구별 추가 검증 (reply 길이·레이트 등). 미리보기 단계에서도 실행된다. */
  validate?: () => GuardDecision;
  preview: (channelId: string) => Promise<string> | string;
  execute: (channelId: string) => Promise<CallToolResult>;
}

/** 쓰기 도구 공통 흐름: 채널 → 하드락 → 세션 활성화(apikey 모드만) → allowlist → 도구별 검증 → confirmed 분기 */
export async function runWrite(ctx: ToolContext, spec: WriteSpec): Promise<CallToolResult> {
  return withChannel(ctx, spec.channelId, async (channelId) => {
    const decision = ctx.guard.checkWrite(channelId);
    if (!decision.ok) return guardErrorResult(decision);
    const extra = spec.validate?.();
    if (extra && !extra.ok) return guardErrorResult(extra);
    if (spec.confirmed !== true) {
      const preview = await spec.preview(channelId);
      return textResult(`${preview}\n\n${PREVIEW_FOOTER}`);
    }
    return spec.execute(channelId);
  });
}
