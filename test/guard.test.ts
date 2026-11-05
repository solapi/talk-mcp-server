import { describe, expect, it } from 'vitest';
import { idempotencyKey, SessionState, WriteGuard } from '../src/guard.js';
import { makeConfig } from './helpers.js';

function setup(overrides = {}, now = () => 1_000_000) {
  const config = makeConfig(overrides);
  const session = new SessionState(config);
  return { session, guard: new WriteGuard(config, session, now) };
}

describe('쓰기 가드 상태 전이', () => {
  it('기본은 비활성 → enable_write 로 활성', () => {
    const { guard } = setup();
    expect(guard.checkWrite('CH_A')).toMatchObject({ ok: false, code: 'WRITE_NOT_ENABLED' });
    expect(guard.enableWrite()).toEqual({ ok: true });
    expect(guard.checkWrite('CH_A')).toEqual({ ok: true });
  });

  it('ENABLE_WRITE=true 면 부팅부터 활성', () => {
    const { guard } = setup({ enableWrite: true });
    expect(guard.checkWrite('CH_A')).toEqual({ ok: true });
  });

  it('하드락은 ENABLE_WRITE·enable_write 보다 우선하고 풀 수 없다', () => {
    const { guard } = setup({ enableWrite: true, disableWrite: true });
    expect(guard.checkWrite('CH_A')).toMatchObject({ ok: false, code: 'WRITE_HARD_LOCKED' });
    expect(guard.enableWrite()).toMatchObject({ ok: false, code: 'WRITE_HARD_LOCKED' });
    expect(guard.checkWrite('CH_A')).toMatchObject({ ok: false, code: 'WRITE_HARD_LOCKED' });
    expect(guard.policy().writeEnabled).toBe(false);
  });

  it('채널 allowlist', () => {
    const { guard, session } = setup({ enableWrite: true, allowedChannels: ['CH_A'] });
    expect(guard.checkWrite('CH_B')).toMatchObject({ ok: false, code: 'CHANNEL_NOT_ALLOWED' });
    session.channelId = 'CH_B';
    expect(guard.resolveChannel()).toMatchObject({ ok: false, code: 'CHANNEL_NOT_ALLOWED' });
    session.channelId = undefined;
    expect(guard.resolveChannel()).toMatchObject({ ok: false, code: 'CHANNEL_REQUIRED' });
  });

  it('새 세션(재시작)은 다시 비활성', () => {
    const first = setup();
    first.guard.enableWrite();
    const second = setup();
    expect(second.guard.checkWrite('CH_A')).toMatchObject({ ok: false, code: 'WRITE_NOT_ENABLED' });
  });
});

describe('reply 가드', () => {
  it('길이·빈 본문·HTML', () => {
    const { guard } = setup();
    expect(guard.checkReply('C1', 'a'.repeat(2001), false)).toMatchObject({ code: 'REPLY_TOO_LONG' });
    expect(guard.checkReply('C1', '   ', false)).toMatchObject({ code: 'REPLY_EMPTY' });
    expect(guard.checkReply('C1', '안녕', true)).toMatchObject({ code: 'REPLY_HTML' });
    expect(guard.checkReply('C1', 'a'.repeat(2000), false)).toEqual({ ok: true });
  });

  it('직전 본문과 같으면 거부, 분당 5회 상한, 1분 지나면 풀림', () => {
    let t = 0;
    const { guard } = setup({}, () => t);
    guard.recordReply('C1', 'm0');
    expect(guard.checkReply('C1', 'm0', false)).toMatchObject({ code: 'REPLY_DUPLICATE' });
    for (let i = 1; i < 5; i += 1) guard.recordReply('C1', `m${i}`);
    expect(guard.checkReply('C1', 'new', false)).toMatchObject({ code: 'REPLY_RATE_LIMITED' });
    expect(guard.checkReply('C2', 'new', false)).toEqual({ ok: true });
    t = 60_001;
    expect(guard.checkReply('C1', 'new', false)).toEqual({ ok: true });
  });

  it('멱등키는 sha256(consultId+text) 앞 32자로 결정적', () => {
    const k = idempotencyKey('C1', '안녕하세요');
    expect(k).toHaveLength(32);
    expect(k).toBe(idempotencyKey('C1', '안녕하세요'));
    expect(k).not.toBe(idempotencyKey('C2', '안녕하세요'));
  });
});
