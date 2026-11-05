import { createRequire } from 'node:module';

// src/ 와 dist/ 모두 패키지 루트 바로 아래에 있으므로 ../package.json 이 같은 파일을 가리킨다.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;
/** 솔라피톡 API 가 출처 표기(clientKind)에 쓰는 헤더 값 */
export const TALK_CLIENT_HEADER_VALUE = `mcp/${PACKAGE_VERSION}`;
