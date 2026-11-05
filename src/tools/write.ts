import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { seg } from '../api/client.js';
import { asObj, formatDateTime, str, toDate } from '../format.js';
import { type GuardDecision } from '../guard.js';
import { containsHtml, maskPii } from '../text.js';
import { apiErrorResult, channelIdArgSchema, runWrite, textResult, type ToolContext } from './common.js';

const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const confirmedSchema = z
  .boolean()
  .optional()
  .describe('false(기본)면 미리보기만 반환합니다. 사용자 확인 후 true 로 다시 호출해야 실행됩니다.');
const consultIdSchema = z.string().min(1).describe('상담 ID');

/** 줄바꿈을 \n 으로 통일하고 앞뒤 공백을 정리한다. */
export function normalizeReplyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** 서버 시계가 조금 늦어도 새 전송을 재생으로 오판하지 않도록 두는 여유 */
const REPLAY_CLOCK_SKEW_MS = 1000;

/**
 * 멱등 재생 판별: 서버의 `Idempotent-Replayed: true` 헤더가 있으면 확정,
 * 없으면 응답 chat.dateCreated 가 요청 시작보다 앞서는지로 추정한다.
 */
export function detectReplay(headers: Headers | undefined, dateCreated: unknown, startedAt: number): string | undefined {
  if (headers?.get('idempotent-replayed')?.toLowerCase() === 'true') return '서버 Idempotent-Replayed 헤더';
  const created = toDate(dateCreated);
  if (created && created.getTime() < startedAt - REPLAY_CLOCK_SKEW_MS) {
    return `메시지 생성 시각 ${formatDateTime(created)} 이 이번 요청보다 앞섭니다`;
  }
  return undefined;
}

export const NOTE_MAX_CHARS = 10_000;

const noteValidate = (content: string) => (): GuardDecision =>
  content.trim() ? { ok: true } : { ok: false, code: 'NOTE_EMPTY', message: '노트 내용이 공백뿐입니다.' };

export const CLOSE_CSAT_WARNING = '⚠ 종료 시 고객에게 만족도(CSAT) 요청이 발송됩니다.';

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  const showPii = ctx.config.showPii;

  server.registerTool(
    'reply',
    {
      title: '고객에게 답장',
      description:
        '상담 고객에게 답장을 보냅니다. 평문만 허용(HTML 금지, 서버는 본문을 그대로 저장), 2,000자 이하, 같은 상담 분당 5회·직전과 같은 본문 차단. confirmed:false(기본)면 보낼 본문과 고객 표시명만 미리 보여줍니다. ReplyRateLimited(429) 뒤 재시도는 새 멱등키로, IdempotentRequestInProgress(409) 뒤에는 30초 기다린 뒤 다시 확인하세요.',
      inputSchema: {
        consultId: consultIdSchema,
        text: z.string().describe('보낼 평문 본문. 줄바꿈은 \\n'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ consultId, text, confirmed, channelId: channelArg }) => {
      const body = normalizeReplyText(text);
      return runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        validate: () => ctx.guard.checkReply(consultId, body, containsHtml(body)),
        preview: async (channelId) => {
          const res = await ctx.client.get(`/talk/v1/consults/${seg(consultId)}`, { channelId });
          const consult = res.ok ? asObj(res.data) : {};
          const name = res.ok ? maskPii(str(consult.memberName) ?? '(이름 없음)', showPii) : `(고객 조회 실패: ${res.error.code})`;
          return [`[미리보기] 답장 — 상담 ${consultId}`, `받는 고객: ${name}`, `글자 수: ${body.length}`, '본문:', body].join('\n');
        },
        execute: async (channelId) => {
          const startedAt = Date.now();
          const res = await ctx.client.post(`/talk/v1/consults/${seg(consultId)}/messages`, {
            channelId,
            body: { message: body },
            headers: { 'Idempotency-Key': ctx.guard.replyIdempotencyKey(consultId, body) },
          });
          if (!res.ok) {
            ctx.guard.recordReplyFailure(consultId, body, res.error.code);
            return apiErrorResult(res.error);
          }
          // 재생이어도 그 본문은 이미 고객에게 간 것이므로 성공으로 기록한다.
          ctx.guard.recordReply(consultId, body);
          const chat = asObj(asObj(res.data).chat ?? res.data);
          const chatRef = str(chat.chatId) ? ` / chatId ${str(chat.chatId)}` : '';
          const replay = detectReplay(res.headers, chat.dateCreated, startedAt);
          if (replay) {
            return textResult(
              `이미 보낸 답장(재생)입니다 — 이번 호출로 새 메시지가 전송되지 않았습니다. 상담 ${consultId}${chatRef}\n(${replay})`,
            );
          }
          return textResult(`답장을 보냈습니다. 상담 ${consultId}${chatRef}`);
        },
      });
    },
  );

  server.registerTool(
    'add_note',
    {
      title: '내부 노트 추가',
      description: '상담에 내부 노트를 남깁니다(고객에게 보이지 않음).',
      inputSchema: {
        consultId: consultIdSchema,
        noteContent: z.string().min(1).max(NOTE_MAX_CHARS).describe('노트 내용 (10,000자 이하)'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false },
    },
    async ({ consultId, noteContent, confirmed, channelId: channelArg }) =>
      runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        validate: noteValidate(noteContent),
        preview: () => `[미리보기] 노트 추가 — 상담 ${consultId}\n내용:\n${noteContent}`,
        execute: async (channelId) => {
          const res = await ctx.client.post('/talk/v1/notes', { channelId, body: { consultId, noteContent } });
          if (!res.ok) return apiErrorResult(res.error);
          const note = asObj(asObj(res.data).note ?? res.data);
          return textResult(`노트를 추가했습니다. 상담 ${consultId}${str(note.noteId) ? ` / noteId ${str(note.noteId)}` : ''}`);
        },
      }),
  );

  server.registerTool(
    'update_note',
    {
      title: '내부 노트 수정',
      description: '기존 내부 노트의 내용을 바꿉니다(작성자 본인 또는 OWNER 만 가능 — 서버가 판단).',
      inputSchema: {
        noteId: z.string().min(1).describe('노트 ID (get_notes)'),
        noteContent: z.string().min(1).max(NOTE_MAX_CHARS).describe('새 노트 내용 (10,000자 이하)'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ noteId, noteContent, confirmed, channelId: channelArg }) =>
      runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        validate: noteValidate(noteContent),
        preview: () => `[미리보기] 노트 수정 — noteId ${noteId}\n새 내용:\n${noteContent}`,
        execute: async (channelId) => {
          const res = await ctx.client.patch(`/talk/v1/notes/${seg(noteId)}`, { channelId, body: { noteContent } });
          if (!res.ok) return apiErrorResult(res.error);
          return textResult(`노트 ${noteId} 를 수정했습니다.`);
        },
      }),
  );

  server.registerTool(
    'assign',
    {
      title: '담당자 배정/해제',
      description:
        '상담에 담당자를 배정합니다. 서버는 담당자를 교체하지 않고 **추가**(공동 담당)합니다. managerId 생략=나(API Key 소유자) 추가, null=담당자 전부 해제. 담당자를 바꾸려면 null 로 해제한 뒤 다시 배정하세요. managerId 는 계정 멤버 ID 가 아니라 채널 매니저 ID(get_consult 의 담당 ID 값)입니다.',
      inputSchema: {
        consultId: consultIdSchema,
        managerId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('추가할 채널 매니저 ID(Manager.managerId, get_consult 의 담당 ID). 생략=나, null=전부 해제'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ consultId, managerId, confirmed, channelId: channelArg }) => {
      const target =
        managerId === undefined ? '나(API Key 소유자) 추가' : managerId === null ? '담당자 전부 해제' : `${managerId} 추가(기존 담당자 유지)`;
      return runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        preview: () => `[미리보기] 담당자 변경 — 상담 ${consultId}\n대상: ${target}`,
        execute: async (channelId) => {
          const res = await ctx.client.patch(`/talk/v1/managers/${seg(consultId)}`, {
            channelId,
            body: managerId === undefined ? {} : { managerId },
          });
          if (!res.ok) return apiErrorResult(res.error);
          return textResult(`상담 ${consultId} 담당자를 변경했습니다: ${target}`);
        },
      });
    },
  );

  server.registerTool(
    'set_status',
    {
      title: '상담 상태 변경',
      description:
        "상담 상태를 progress(진행)/pending(보류, pendingTimeoutMinutes 후 자동 해제)/closed(종료)로 바꿉니다. closed 는 고객에게 만족도(CSAT) 요청을 발송합니다.",
      inputSchema: {
        consultId: consultIdSchema,
        status: z.enum(['progress', 'pending', 'closed']).describe('바꿀 상태'),
        pendingTimeoutMinutes: z.number().int().min(1).max(60 * 24 * 30).optional().describe('pending 일 때 자동 해제까지 분'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ consultId, status, pendingTimeoutMinutes, confirmed, channelId: channelArg }) =>
      runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        preview: () => {
          const lines = [`[미리보기] 상태 변경 — 상담 ${consultId}`, `새 상태: ${status}`];
          if (status === 'pending' && pendingTimeoutMinutes) lines.push(`자동 해제: ${pendingTimeoutMinutes}분 후`);
          if (status === 'closed') lines.push(CLOSE_CSAT_WARNING);
          return lines.join('\n');
        },
        execute: async (channelId) => {
          const body: Record<string, unknown> = { consultId, consultStatus: status };
          if (status === 'pending' && pendingTimeoutMinutes) body.pendingTimeoutMinutes = pendingTimeoutMinutes;
          const res = await ctx.client.patch('/talk/v1/consults/status', { channelId, body });
          if (!res.ok) return apiErrorResult(res.error);
          return textResult(`상담 ${consultId} 상태를 ${status} 로 바꿨습니다.`);
        },
      }),
  );

  server.registerTool(
    'add_tags',
    {
      title: '상담 태그 추가',
      description: '상담에 태그를 붙입니다. tagId 는 list_tags 로 확인하세요.',
      inputSchema: {
        consultId: consultIdSchema,
        tagIds: z.array(z.string().min(1)).min(1).max(20).describe('붙일 태그 ID 목록'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: false },
    },
    async ({ consultId, tagIds, confirmed, channelId: channelArg }) =>
      runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        preview: () => `[미리보기] 태그 추가 — 상담 ${consultId}\n태그: ${tagIds.join(', ')}`,
        execute: async (channelId) => {
          const res = await ctx.client.post(`/talk/v1/tags/consults/${seg(consultId)}`, { channelId, body: { tagIds } });
          if (!res.ok) return apiErrorResult(res.error);
          return textResult(`상담 ${consultId} 에 태그 ${tagIds.length}개를 붙였습니다.`);
        },
      }),
  );

  server.registerTool(
    'remove_tag',
    {
      title: '상담 태그 제거',
      description: '상담에서 태그 하나를 뗍니다.',
      inputSchema: {
        consultId: consultIdSchema,
        tagId: z.string().min(1).describe('뗄 태그 ID'),
        confirmed: confirmedSchema,
        channelId: channelIdArgSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ consultId, tagId, confirmed, channelId: channelArg }) =>
      runWrite(ctx, {
        confirmed,
        channelId: channelArg,
        preview: () => `[미리보기] 태그 제거 — 상담 ${consultId}\n태그: ${tagId}`,
        execute: async (channelId) => {
          const res = await ctx.client.delete(`/talk/v1/tags/consults/${seg(consultId)}/${seg(tagId)}`, { channelId });
          if (!res.ok) return apiErrorResult(res.error);
          return textResult(`상담 ${consultId} 에서 태그 ${tagId} 를 뗐습니다.`);
        },
      }),
  );
}
