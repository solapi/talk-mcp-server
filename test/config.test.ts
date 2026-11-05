import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const deps = (files: Record<string, string>) => ({
  homedir: () => '/home/u',
  readFile: (p: string) => {
    if (p in files) return files[p] as string;
    throw new Error('ENOENT');
  },
});

describe('설정', () => {
  it('env 자격증명과 가드 env', () => {
    const c = loadConfig(
      {
        SOLAPI_API_KEY: 'k',
        SOLAPI_API_SECRET: 's',
        SOLAPI_TALK_CHANNEL_ID: 'CH',
        SOLAPI_TALK_MCP_ENABLE_WRITE: 'true',
        SOLAPI_TALK_MCP_ALLOWED_CHANNELS: 'CH, CH2 ,',
        SOLAPI_API_HOST: 'https://api.example.test/',
      },
      deps({}),
    );
    expect(c).toMatchObject({
      apiKey: 'k',
      apiHost: 'https://api.example.test',
      channelId: 'CH',
      enableWrite: true,
      disableWrite: false,
      allowedChannels: ['CH', 'CH2'],
      showPii: false,
      credentialSource: 'env',
    });
  });

  it('SOLAPI_PROFILE 은 ~/.solactl/credentials.json 의 profiles[name] 를 읽는다', () => {
    const c = loadConfig(
      { SOLAPI_PROFILE: 'work' },
      deps({ '/home/u/.solactl/credentials.json': JSON.stringify({ profiles: { work: { apiKey: 'pk', apiSecret: 'ps' } } }) }),
    );
    expect(c).toMatchObject({ apiKey: 'pk', apiSecret: 'ps', credentialSource: 'profile:work', apiHost: 'https://api.solapi.com' });
  });

  it('자격증명이 없거나 프로필이 없으면 ConfigError (시크릿을 메시지에 넣지 않는다)', () => {
    expect(() => loadConfig({}, deps({}))).toThrow(ConfigError);
    expect(() =>
      loadConfig({ SOLAPI_PROFILE: 'x' }, deps({ '/home/u/.solactl/credentials.json': '{"profiles":{}}' })),
    ).toThrow(/프로필 "x"/);
  });
});
