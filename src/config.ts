import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_HOST = 'https://api.solapi.com';
/** trusted 모드 업스트림 기본값. 실제 배포에서는 TALK_API_BASE 로 내부 주소를 지정한다. */
export const DEFAULT_TRUSTED_API_BASE = 'http://127.0.0.1:7001';

/**
 * apikey: 이 프로세스가 API Key 하나로 HMAC 서명해 공개 API 를 부른다 (stdio·--http 단일 키).
 * trusted: 게이트웨이 뒤에서 요청마다 게이트웨이가 스탬프한 신원 헤더를 솔라피톡 API 내부 주소로 그대로 전달한다.
 */
export type ServerMode = 'apikey' | 'trusted';

export interface Config {
  mode: ServerMode;
  /** trusted 모드에서는 빈 문자열(쓰지 않음) */
  apiKey: string;
  /** trusted 모드에서는 빈 문자열(쓰지 않음) */
  apiSecret: string;
  /** apikey: 공개 API 호스트, trusted: TALK_API_BASE */
  apiHost: string;
  /** 부팅 시 고정할 채널. 없으면 list_channels → use_channel 로 고른다. */
  channelId?: string;
  /** true 면 부팅부터 쓰기 활성화 (세션 활성화 생략) */
  enableWrite: boolean;
  /** true 면 쓰기 하드락 — 도구로 풀 수 없다 */
  disableWrite: boolean;
  /** null 이면 제한 없음 */
  allowedChannels: string[] | null;
  showPii: boolean;
  promptFile?: string;
  /** 자격증명을 어디서 읽었는지 (시크릿 자체는 노출하지 않는다) */
  credentialSource: 'env' | `profile:${string}` | 'trusted-headers';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface ConfigDeps {
  homedir: () => string;
  readFile: (path: string) => string;
}

const defaultDeps: ConfigDeps = {
  homedir,
  readFile: (path) => readFileSync(path, 'utf8'),
};

export function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseChannelList(value: string | undefined): string[] | null {
  const list = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** ~/.solactl/credentials.json 형식: { "profiles": { "<name>": { "apiKey": "...", "apiSecret": "..." } } } */
export function credentialsFilePath(deps: Pick<ConfigDeps, 'homedir'> = defaultDeps): string {
  return join(deps.homedir(), '.solactl', 'credentials.json');
}

function readProfile(name: string, deps: ConfigDeps): { apiKey: string; apiSecret: string } {
  const path = credentialsFilePath(deps);
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch {
    throw new ConfigError(`SOLAPI_PROFILE=${name} 이지만 자격증명 파일(${path})을 읽을 수 없습니다.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`자격증명 파일(${path})이 올바른 JSON 이 아닙니다.`);
  }
  const profile = (parsed as { profiles?: Record<string, { apiKey?: unknown; apiSecret?: unknown }> })?.profiles?.[name];
  const apiKey = typeof profile?.apiKey === 'string' ? profile.apiKey.trim() : '';
  const apiSecret = typeof profile?.apiSecret === 'string' ? profile.apiSecret.trim() : '';
  if (!apiKey || !apiSecret) {
    throw new ConfigError(`자격증명 파일(${path})에 프로필 "${name}" 의 apiKey/apiSecret 이 없습니다.`);
  }
  return { apiKey, apiSecret };
}

/** CLI --trusted 또는 TALK_MCP_MODE=trusted */
export function isTrustedMode(cliTrusted: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return cliTrusted || nonEmpty(env.TALK_MCP_MODE)?.toLowerCase() === 'trusted';
}

/** trusted 모드에서 무시하는(테넌트 간 공유되면 안 되는) 환경변수 — 설정돼 있으면 기동 시 경고한다. */
export const TRUSTED_IGNORED_ENV = ['SOLAPI_TALK_CHANNEL_ID', 'SOLAPI_TALK_MCP_ENABLE_WRITE', 'SOLAPI_TALK_MCP_HTTP_TOKEN'] as const;

function loadTrustedConfig(env: NodeJS.ProcessEnv): Config {
  const apiHost = (nonEmpty(env.TALK_API_BASE) ?? DEFAULT_TRUSTED_API_BASE).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(apiHost)) {
    throw new ConfigError('TALK_API_BASE 는 http:// 또는 https:// 로 시작해야 합니다.');
  }
  return {
    mode: 'trusted',
    apiKey: '',
    apiSecret: '',
    apiHost,
    // 채널 고정·부팅 시 쓰기 활성화는 프로세스 전역이라 테넌트끼리 공유되므로 trusted 에서는 쓰지 않는다.
    channelId: undefined,
    enableWrite: false,
    disableWrite: parseBool(env.SOLAPI_TALK_MCP_DISABLE_WRITE),
    allowedChannels: parseChannelList(env.SOLAPI_TALK_MCP_ALLOWED_CHANNELS),
    showPii: parseBool(env.SOLAPI_TALK_MCP_SHOW_PII),
    promptFile: nonEmpty(env.SOLAPI_TALK_MCP_PROMPT_FILE),
    credentialSource: 'trusted-headers',
  };
}

export interface LoadConfigOptions {
  trusted?: boolean;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: ConfigDeps = defaultDeps,
  options: LoadConfigOptions = {},
): Config {
  if (options.trusted) return loadTrustedConfig(env);

  let apiKey = nonEmpty(env.SOLAPI_API_KEY);
  let apiSecret = nonEmpty(env.SOLAPI_API_SECRET);
  let credentialSource: Config['credentialSource'] = 'env';

  if (!apiKey || !apiSecret) {
    const profile = nonEmpty(env.SOLAPI_PROFILE);
    if (!profile) {
      throw new ConfigError(
        'SOLAPI_API_KEY/SOLAPI_API_SECRET 환경변수 또는 SOLAPI_PROFILE(~/.solactl/credentials.json 프로필)을 설정하세요.',
      );
    }
    ({ apiKey, apiSecret } = readProfile(profile, deps));
    credentialSource = `profile:${profile}`;
  }

  const apiHost = (nonEmpty(env.SOLAPI_API_HOST) ?? DEFAULT_API_HOST).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(apiHost)) {
    throw new ConfigError('SOLAPI_API_HOST 는 http:// 또는 https:// 로 시작해야 합니다.');
  }

  return {
    mode: 'apikey',
    apiKey,
    apiSecret,
    apiHost,
    channelId: nonEmpty(env.SOLAPI_TALK_CHANNEL_ID),
    enableWrite: parseBool(env.SOLAPI_TALK_MCP_ENABLE_WRITE),
    disableWrite: parseBool(env.SOLAPI_TALK_MCP_DISABLE_WRITE),
    allowedChannels: parseChannelList(env.SOLAPI_TALK_MCP_ALLOWED_CHANNELS),
    showPii: parseBool(env.SOLAPI_TALK_MCP_SHOW_PII),
    promptFile: nonEmpty(env.SOLAPI_TALK_MCP_PROMPT_FILE),
    credentialSource,
  };
}
