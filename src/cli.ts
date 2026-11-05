/** CLI 인자 파서 (부작용 없이 테스트할 수 있게 index.ts 와 분리) */
export interface CliArgs {
  help: boolean;
  version: boolean;
  httpPort?: number;
  host?: string;
  insecureNoToken: boolean;
  /** 게이트웨이 뒤 trusted 모드 (--http 와 함께만 유효) */
  trusted: boolean;
  /** MCP 엔드포인트 경로 (기본 /mcp) */
  path?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, version: false, insecureNoToken: false, trusted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--insecure-no-token') args.insecureNoToken = true;
    else if (a === '--trusted') args.trusted = true;
    else if (a === '--path') {
      const path = argv[i + 1];
      if (!path || !path.startsWith('/') || /[\s?#]/.test(path)) throw new Error('--path 뒤에 / 로 시작하는 경로를 주세요 (예: /mcp).');
      args.path = path;
      i += 1;
    } else if (a === '--http') {
      const port = Number(argv[i + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--http 뒤에 포트 번호(0~65535)를 주세요.');
      args.httpPort = port;
      i += 1;
    } else if (a === '--host') {
      const host = argv[i + 1];
      if (!host) throw new Error('--host 뒤에 주소를 주세요.');
      args.host = host;
      i += 1;
    } else {
      throw new Error(`알 수 없는 인자: ${a}`);
    }
  }
  return args;
}
