import { indentBody, maskByKey, maskPii, oneLine, stripHtml } from './text.js';

export type Obj = Record<string, unknown>;

export function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : {};
}

export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** 배열 응답과 { items } / { <key> } 응답을 모두 배열로 */
export function asList(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asObj(value);
  for (const key of ['items', ...keys]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

const TIME_ZONE = 'Asia/Seoul';

function parts(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 2026-11-04 */
export function formatDay(date: Date): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 10:21 */
export function formatClock(date: Date): string {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

/** 2026-11-04 10:21 */
export function formatDateTime(value: unknown): string {
  const d = toDate(value);
  return d ? `${formatDay(d)} ${formatClock(d)}` : '-';
}

export function senderLabel(
  senderType: string | undefined,
  senderName: string | undefined,
  isVisible: unknown,
  clientKind?: string,
): string {
  const base = baseSenderLabel(senderType, senderName, isVisible);
  // 출처 표기: MCP 등 외부 클라이언트로 보낸 메시지는 ·MCP 처럼 붙인다
  return clientKind ? `${base}·${clientKind.toUpperCase()}` : base;
}

function baseSenderLabel(senderType: string | undefined, senderName: string | undefined, isVisible: unknown): string {
  if (isVisible === false) {
    if (senderType === 'system') return '시스템·비공개';
    return senderName ? `내부메모 ${senderName}` : '내부메모';
  }
  switch (senderType) {
    case 'user':
      return '고객';
    case 'manager':
      return senderName ? `상담원 ${senderName}` : '상담원';
    case 'bot':
      return '봇';
    case 'system':
      return '시스템';
    default:
      return senderType ? `기타:${senderType}` : '기타';
  }
}

export interface FormatOptions {
  showPii: boolean;
}

/** 채팅 한 건을 `[고객 10:21] 본문` 형태 한 덩어리로 */
export function formatChat(chat: unknown, opts: FormatOptions): { day?: string; text: string } {
  const c = asObj(chat);
  const date = toDate(c.dateCreated ?? c.createdAt);
  const label = senderLabel(str(c.senderType), str(c.senderName), c.isVisible, str(c.clientKind));
  const clock = date ? ` ${formatClock(date)}` : '';
  let body = maskPii(stripHtml(str(c.message) ?? ''), opts.showPii);
  const fileName = str(c.fileName);
  if (str(c.fileUrl) || fileName) {
    const kind = str(c.fileType) ?? '파일';
    body = `${body}${body ? '\n' : ''}(첨부 ${kind}: ${maskPii(fileName ?? '이름 없음', opts.showPii)})`;
  }
  const buttonLabel = str(c.buttonLabel);
  if (!body && buttonLabel) body = `(버튼 선택: ${buttonLabel})`;
  if (!body) body = '(내용 없음)';
  return { day: date ? formatDay(date) : undefined, text: `[${label}${clock}] ${indentBody(body)}` };
}

export function formatChats(chats: unknown[], opts: FormatOptions): string {
  const lines: string[] = [];
  let lastDay: string | undefined;
  for (const chat of chats) {
    const { day, text } = formatChat(chat, opts);
    if (day && day !== lastDay) {
      lines.push(`--- ${day} ---`);
      lastDay = day;
    }
    lines.push(text);
  }
  return lines.join('\n');
}

function lastSenderWord(type: string | undefined): string {
  switch (type) {
    case 'user':
      return '고객';
    case 'manager':
      return '상담원';
    case 'bot':
      return '봇';
    case 'system':
      return '시스템';
    default:
      return type ?? '?';
  }
}

export function joinNames(value: unknown): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v).join(', ') : '';
}

/** 상담 목록 한 줄 */
export function formatConsultLine(consult: unknown, opts: FormatOptions): string {
  const c = asObj(consult);
  const name = maskPii(str(c.memberName) ?? '(이름 없음)', opts.showPii);
  const managers = joinNames(c.managerNames) || '미배정';
  const unread = str(c.adminUnReadCount) ?? '0';
  const head = `- ${str(c.consultId) ?? '?'} [${str(c.consultStatus) ?? '?'}] ${name} | 담당: ${managers} | 미읽음 ${unread}`;
  const last = str(c.lastMessage);
  const tail = last
    ? `\n    마지막(${lastSenderWord(str(c.lastSenderType))} ${formatDateTime(c.lastMessageTime)}): ${oneLine(maskPii(stripHtml(last), opts.showPii))}`
    : '';
  return head + tail;
}

const SENSITIVE_KEY = /password|passwd|secret|token|hash|salt|apikey|credential/i;

/** 모양을 모르는 객체를 key: value 줄로 (한 단계 중첩까지, 민감 키 제외) */
export function formatKeyValues(value: unknown, opts: FormatOptions, indent = '', depth = 0): string[] {
  const obj = asObj(value);
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(key) || raw === null || raw === undefined || raw === '') continue;
    const s = str(raw);
    if (s !== undefined) {
      lines.push(`${indent}${key}: ${oneLine(maskByKey(key, stripHtml(s), opts.showPii), 300)}`);
    } else if (Array.isArray(raw)) {
      const prim = raw.map(str).filter((x): x is string => x !== undefined);
      if (prim.length > 0) lines.push(`${indent}${key}: ${oneLine(maskByKey(key, prim.join(', '), opts.showPii), 300)}`);
      else if (raw.length > 0) lines.push(`${indent}${key}: (${raw.length}개 항목)`);
    } else if (depth < 1) {
      const nested = formatKeyValues(raw, opts, `${indent}  `, depth + 1);
      if (nested.length > 0) lines.push(`${indent}${key}:`, ...nested);
    }
  }
  return lines;
}

/** 고객 프로필에서 보여줄 키(대소문자 무시). 그 밖의 키는 출력하지 않는다. */
export const PROFILE_KEYS = [
  'name',
  'nickname',
  'email',
  'phoneNumber',
  'mobileNumber',
  'phone',
  'mobile',
  'company',
  'companyName',
  'memo',
];
const PROFILE_KEY_SET = new Set(PROFILE_KEYS.map((k) => k.toLowerCase()));

/** 프로필은 화이트리스트 키만, 키별 마스킹·URL 쿼리 제거 후 한 줄씩 */
export function formatProfile(profile: unknown, opts: FormatOptions, indent = ''): string[] {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(asObj(profile))) {
    if (!PROFILE_KEY_SET.has(key.toLowerCase())) continue;
    const s = str(raw);
    if (s === undefined || s === '') continue;
    lines.push(`${indent}${key}: ${oneLine(maskByKey(key, stripHtml(s), opts.showPii), 300)}`);
  }
  return lines;
}
