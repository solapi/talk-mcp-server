import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { requireScope } from './scope.js';

export const REPLY_MAX_CHARS = 2000;
export const REPLY_RATE_LIMIT = 5;
export const REPLY_RATE_WINDOW_MS = 60_000;

export type GuardCode =
  | 'WRITE_HARD_LOCKED'
  | 'WRITE_NOT_ENABLED'
  | 'CHANNEL_REQUIRED'
  | 'CHANNEL_NOT_ALLOWED'
  | 'CHANNEL_CONFLICT'
  | 'REPLY_TOO_LONG'
  | 'REPLY_EMPTY'
  | 'REPLY_HTML'
  | 'REPLY_RATE_LIMITED'
  | 'REPLY_DUPLICATE'
  | 'NOTE_EMPTY';

export type GuardDecision = { ok: true } | { ok: false; code: GuardCode; message: string };

/** 멱등·레이트리밋 기록 Map 하나가 가질 수 있는 최대 항목 수. 넘으면 가장 오래 넣은 것부터 버린다(장기 실행 trusted 모드 메모리 상한). */
export const MAX_TRACKED_ENTRIES = 10_000;

function setCapped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key); // 다시 넣어 삽입 순서를 최신으로
  map.set(key, value);
  while (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * 프로세스(=MCP 세션) 동안만 유지되는 상태. 재시작하면 쓰기 활성화·채널 선택이 초기화된다.
 * --http 단일 키 모드도 한 프로세스가 한 설정(한 API Key)을 쓰므로 같은 상태를 공유한다.
 * trusted 모드에서는 channelId·writeEnabled 를 쓰지 않고, 답장 기록 Map 의 키에 memberId 를 넣어 테넌트별로 나눈다.
 */
export class SessionState {
  channelId?: string;
  writeEnabled: boolean;
  readonly replyLog = new Map<string, { sentAt: number[]; lastText?: string }>();
  /** 멱등키 기준값 → 서버가 실패로 확정한(429) 시도 횟수. 실패 응답도 같은 키로 30초 캐시되므로 다음 시도는 접미사를 붙인다. */
  readonly replyRetries = new Map<string, number>();
  /** 상담+본문 → 성공 전송 횟수 (멱등키에 들어간다) */
  readonly replySentCount = new Map<string, number>();
  /**
   * wait_for_updates 의 채널별 마지막 cursor 와 그 응답에서 본 `consultId@dateUpdated` 키(같은 밀리초 중복 수신 제거용).
   * apikey 모드(한 프로세스 = 한 사용자)에서만 쓴다. trusted 모드는 여러 사용자가 프로세스를 공유하므로 기억하지 않는다.
   */
  readonly updatesCursor = new Map<string, { cursor: string; seen: Set<string> }>();

  constructor(config: Pick<Config, 'channelId' | 'enableWrite'>) {
    this.channelId = config.channelId;
    this.writeEnabled = config.enableWrite;
  }
}

/**
 * 멱등키 = sha256(consultId + text + sentCount) 앞 32자 (구분자 \n).
 * sentCount 는 이 프로세스에서 같은 상담·같은 본문을 성공적으로 보낸 횟수다. 서버가 같은 키의 성공 응답을
 * 10분간 재생하므로, A→B→A 처럼 의도적으로 같은 본문을 다시 보낼 때는 키가 달라져야 실제로 전송된다.
 * 타임아웃 뒤 재시도처럼 성공 기록이 없는 재전송은 같은 키라 서버에서 한 번만 처리된다.
 */
export function idempotencyKey(consultId: string, text: string, sentCount = 0): string {
  return createHash('sha256').update(`${consultId}\n${text}\n${sentCount}`).digest('hex').slice(0, 32);
}

function replyBodyKey(consultId: string, text: string): string {
  return createHash('sha256').update(`${consultId}\n${text}`).digest('hex');
}

/** 서버가 "보내지 않았음" 을 확정하는 실패 코드. 이 뒤의 재시도는 새 키(접미사)로 보낸다. */
const RETRY_WITH_NEW_KEY = new Set(['ReplyRateLimited']);

export class WriteGuard {
  constructor(
    private readonly config: Config,
    private readonly session: SessionState,
    private readonly now: () => number = Date.now,
  ) {}

  get trusted(): boolean {
    return this.config.mode === 'trusted';
  }

  isChannelAllowed(channelId: string): boolean {
    return this.config.allowedChannels === null || this.config.allowedChannels.includes(channelId);
  }

  /** 도구 인자 없이 정해진 채널: trusted 는 요청 헤더 x-channel-id, apikey 는 세션(use_channel·SOLAPI_TALK_CHANNEL_ID) */
  defaultChannelId(): string | undefined {
    return this.trusted ? requireScope().channelId : this.session.channelId;
  }

  /**
   * 읽기·쓰기 공통: 채널을 정하고 allowlist 안인지 본다.
   * trusted: 헤더 x-channel-id → 도구 인자 channelId (둘 다 있는데 다르면 거부). apikey: 도구 인자 → 세션 채널.
   */
  resolveChannel(argChannelId?: string): { ok: true; channelId: string } | { ok: false; code: GuardCode; message: string } {
    const arg = argChannelId?.trim() || undefined;
    const fallback = this.defaultChannelId();
    if (this.trusted && arg && fallback && arg !== fallback) {
      return {
        ok: false,
        code: 'CHANNEL_CONFLICT',
        message: `요청 헤더 x-channel-id(${fallback}) 와 channelId 인자(${arg}) 가 다릅니다. 헤더를 지우거나 같은 값을 쓰세요.`,
      };
    }
    const channelId = this.trusted ? (fallback ?? arg) : (arg ?? fallback);
    if (!channelId) {
      return {
        ok: false,
        code: 'CHANNEL_REQUIRED',
        message: this.trusted
          ? '채널이 정해지지 않았습니다. list_channels 로 채널 ID 를 확인한 뒤 도구의 channelId 인자로 넘기거나, MCP 클라이언트 설정에 x-channel-id 헤더를 넣으세요.'
          : '채널이 선택되지 않았습니다. SOLAPI_TALK_CHANNEL_ID 를 설정하거나 list_channels 후 use_channel 도구로 고르세요(또는 도구의 channelId 인자).',
      };
    }
    if (!this.isChannelAllowed(channelId)) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_ALLOWED',
        message: `채널 ${channelId} 는 SOLAPI_TALK_MCP_ALLOWED_CHANNELS 에 없어 사용할 수 없습니다.`,
      };
    }
    return { ok: true, channelId };
  }

  /**
   * 쓰기 가드: 하드락 → 세션 활성화 → 채널 allowlist. confirmed 판단은 호출부(도구)에서 한다.
   * trusted 모드는 세션 활성화 단계가 없다(프로세스 전역 스위치를 테넌트끼리 공유하면 안 되므로) — confirmed 2단계가 확인 장치다.
   */
  checkWrite(channelId: string): GuardDecision {
    if (this.config.disableWrite) {
      return {
        ok: false,
        code: 'WRITE_HARD_LOCKED',
        message: 'SOLAPI_TALK_MCP_DISABLE_WRITE=true 로 쓰기가 잠겨 있습니다. 이 잠금은 도구로 풀 수 없습니다.',
      };
    }
    if (!this.trusted && !this.session.writeEnabled) {
      return {
        ok: false,
        code: 'WRITE_NOT_ENABLED',
        message:
          '쓰기 도구가 비활성 상태입니다. 사용자가 원하면 enable_write 도구로 이 세션 동안만 켤 수 있습니다(재시작 시 다시 꺼짐). 항상 켜려면 SOLAPI_TALK_MCP_ENABLE_WRITE=true.',
      };
    }
    if (!this.isChannelAllowed(channelId)) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_ALLOWED',
        message: `채널 ${channelId} 는 SOLAPI_TALK_MCP_ALLOWED_CHANNELS 에 없어 쓰기를 할 수 없습니다.`,
      };
    }
    return { ok: true };
  }

  enableWrite(): GuardDecision {
    if (this.config.disableWrite) {
      return {
        ok: false,
        code: 'WRITE_HARD_LOCKED',
        message: 'SOLAPI_TALK_MCP_DISABLE_WRITE=true 로 쓰기가 잠겨 있어 활성화할 수 없습니다.',
      };
    }
    this.session.writeEnabled = true;
    return { ok: true };
  }

  /** reply 전용 추가 가드: 길이·HTML·분당 횟수·직전 본문 중복 */
  checkReply(consultId: string, text: string, hasHtml: boolean): GuardDecision {
    if (!text.trim()) return { ok: false, code: 'REPLY_EMPTY', message: '보낼 본문이 비어 있습니다.' };
    if (text.length > REPLY_MAX_CHARS) {
      return {
        ok: false,
        code: 'REPLY_TOO_LONG',
        message: `답장은 ${REPLY_MAX_CHARS}자 이하여야 합니다(현재 ${text.length}자). 나눠 보내거나 줄이세요.`,
      };
    }
    if (hasHtml) {
      return { ok: false, code: 'REPLY_HTML', message: '답장에 HTML 태그를 쓸 수 없습니다. 평문과 줄바꿈만 사용하세요.' };
    }
    const entry = this.session.replyLog.get(this.scoped(consultId));
    if (entry) {
      const since = this.now() - REPLY_RATE_WINDOW_MS;
      const recent = entry.sentAt.filter((t) => t > since);
      if (recent.length >= REPLY_RATE_LIMIT) {
        return {
          ok: false,
          code: 'REPLY_RATE_LIMITED',
          message: `같은 상담에 1분 동안 ${REPLY_RATE_LIMIT}회까지만 답장할 수 있습니다. 잠시 후 다시 시도하세요.`,
        };
      }
      if (entry.lastText === text) {
        return { ok: false, code: 'REPLY_DUPLICATE', message: '직전에 보낸 답장과 본문이 같아 보내지 않았습니다.' };
      }
    }
    return { ok: true };
  }

  /**
   * 답장 멱등키. 기본은 sha256(consultId+text) 앞 32자, 429 로 거절된 뒤의 재시도는 `-r<n>` 접미사를 붙여
   * 서버의 30초 실패 캐시를 피한다. 409(처리 중)·타임아웃은 같은 키를 유지해 중복 전송을 막는다.
   */
  replyIdempotencyKey(consultId: string, text: string): string {
    const base = this.baseKey(consultId, text);
    const retries = this.session.replyRetries.get(this.scoped(base)) ?? 0;
    return retries > 0 ? `${base}-r${retries}` : base;
  }

  recordReplyFailure(consultId: string, text: string, code: string): void {
    if (!RETRY_WITH_NEW_KEY.has(code)) return;
    const key = this.scoped(this.baseKey(consultId, text));
    setCapped(this.session.replyRetries, key, (this.session.replyRetries.get(key) ?? 0) + 1);
  }

  /** trusted 모드는 기록 Map 키 앞에 memberId 를 붙여 테넌트끼리 레이트리밋·중복 판정·멱등 횟수를 섞지 않는다. */
  private scoped(key: string): string {
    return this.trusted ? `${requireScope().memberId}\n${key}` : key;
  }

  /** trusted 모드는 멱등키 해시에도 memberId 를 넣는다 — 다른 사용자가 같은 상담에 같은 본문을 보내도 서버가 재생으로 묶지 않게. */
  private baseKey(consultId: string, text: string): string {
    const sentCount = this.session.replySentCount.get(this.scoped(replyBodyKey(consultId, text))) ?? 0;
    return idempotencyKey(this.scoped(consultId), text, sentCount);
  }

  /** 실제 전송 성공 후에만 기록한다(미리보기·실패는 횟수에 넣지 않음). */
  recordReply(consultId: string, text: string): void {
    const since = this.now() - REPLY_RATE_WINDOW_MS;
    const logKey = this.scoped(consultId);
    const entry = this.session.replyLog.get(logKey) ?? { sentAt: [] };
    entry.sentAt = entry.sentAt.filter((t) => t > since);
    entry.sentAt.push(this.now());
    entry.lastText = text;
    setCapped(this.session.replyLog, logKey, entry);
    this.session.replyRetries.delete(this.scoped(this.baseKey(consultId, text)));
    const bodyKey = this.scoped(replyBodyKey(consultId, text));
    setCapped(this.session.replySentCount, bodyKey, (this.session.replySentCount.get(bodyKey) ?? 0) + 1);
  }

  policy() {
    if (this.trusted) {
      const headerChannel = requireScope().channelId;
      return {
        mode: 'trusted (게이트웨이 뒤 호스팅 · 멀티테넌트)',
        writeHardLocked: this.config.disableWrite,
        writeEnabled: !this.config.disableWrite,
        writeActivation:
          '호스팅 모드는 enable_write 세션 활성화가 없습니다(여러 사용자가 한 프로세스를 공유하므로). 쓰기는 confirmed 2단계로만 실행됩니다.',
        allowedChannels: this.config.allowedChannels ?? '제한 없음',
        currentChannelId: headerChannel ?? null,
        channelSource: headerChannel ? '요청 헤더 x-channel-id' : '없음 — 도구마다 channelId 인자를 넘기세요',
        showPii: this.config.showPii,
        reply: {
          maxChars: REPLY_MAX_CHARS,
          perConsultPerMinute: REPLY_RATE_LIMIT,
          blockSameAsPrevious: true,
          scope: '레이트리밋·중복 판정은 사용자(memberId)별·서버 인스턴스별로 따로 셉니다.',
          idempotencyKey: 'sha256(consultId + text + 같은 본문 성공 횟수) 앞 32자 (429 뒤 재시도는 -r<n> 접미사)',
        },
        twoStepConfirm: '모든 쓰기 도구는 confirmed:false(기본) 면 미리보기만 반환하고 confirmed:true 일 때 실행합니다.',
      };
    }
    return {
      mode: 'apikey',
      writeHardLocked: this.config.disableWrite,
      writeEnabled: !this.config.disableWrite && this.session.writeEnabled,
      writeEnabledAtBoot: this.config.enableWrite,
      allowedChannels: this.config.allowedChannels ?? '제한 없음',
      currentChannelId: this.session.channelId ?? null,
      showPii: this.config.showPii,
      reply: {
        maxChars: REPLY_MAX_CHARS,
        perConsultPerMinute: REPLY_RATE_LIMIT,
        blockSameAsPrevious: true,
        idempotencyKey: 'sha256(consultId + text + 같은 본문 성공 횟수) 앞 32자 (429 뒤 재시도는 -r<n> 접미사)',
      },
      twoStepConfirm: '모든 쓰기 도구는 confirmed:false(기본) 면 미리보기만 반환하고 confirmed:true 일 때 실행합니다.',
    };
  }
}
