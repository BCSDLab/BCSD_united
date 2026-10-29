import { swaggerUI } from '@hono/swagger-ui';
import type { Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import sourceContract from '@api/openapi/source-contract.json';

const capabilityParameter = {
  name: 'token',
  in: 'path',
  required: true,
  description: '서버가 발급한 서명된 파일 접근 토큰이다. URL 자체가 접근 권한이므로 외부에 공유하지 않는다.',
  schema: { type: 'string', maxLength: 8192 },
};

const errorContent = {
  'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
};

const capabilityErrors = {
  '403': {
    description: 'INVALID_FILE_CAPABILITY: 서명, HTTP 메서드, 파일 키가 올바르지 않거나 토큰이 만료되었다.',
    content: errorContent,
  },
  '503': {
    description: 'INTEGRATION_NOT_CONFIGURED: 파일 URL 서명 설정이 없거나 올바르지 않다.',
    content: errorContent,
  },
};

const openapiJson = JSON.stringify({
  ...sourceContract,
  servers: [{ url: '/' }],
  paths: {
    ...sourceContract.paths,
    '/health': {
      get: {
        tags: ['Native Worker'],
        operationId: 'getNativeWorkerHealth',
        summary: 'Worker 상태 확인',
        description:
          '인증과 DB 조회 없이 Worker 환경 정보를 반환한다. DB나 외부 연동의 정상 동작을 보장하는 readiness 검사는 아니다.',
        security: [],
        responses: {
          '200': {
            description: 'Worker가 요청을 처리할 수 있다.',
            headers: {
              'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'service', 'environment', 'release'],
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    service: { type: 'string', enum: ['koin-api'] },
                    environment: { type: 'string' },
                    release: { type: 'string', description: '배포 릴리스 값이 없으면 unknown이다.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/storage/capabilities/{token}': {
      parameters: [capabilityParameter],
      put: {
        tags: ['Native Worker'],
        operationId: 'putNativeFileCapability',
        summary: '서명된 URL로 R2 파일 업로드',
        description:
          '업로드 URL 발급 응답의 pre_signed_url을 사용한다. 토큰은 PUT 메서드, 파일 키, 만료 시각, Content-Type과 바이트 길이에 묶여 있다. 본문은 multipart가 아닌 원본 파일이며 Content-Type은 발급 요청의 content_type과 정확히 같아야 한다. Content-Length를 보내면 발급 요청의 content_length와 같아야 하며 실제 스트림 길이도 검사한다. 업로드 URL은 발급 후 10분 동안 유효하다. 토큰만으로 접근할 수 있지만 브라우저가 웹 세션 쿠키를 함께 보내면 공통 인증 미들웨어의 허용 Origin 및 X-CSRF-Token 검사가 적용된다.',
        security: [],
        requestBody: {
          required: true,
          description:
            '서명된 content_type과 content_length에 일치하는 원본 파일 바이트이다. Swagger UI가 서명된 Content-Type을 자동으로 추론하지 않으므로 실제 파일 업로드 클라이언트에서 해당 헤더를 지정한다.',
          content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          '200': { description: '파일 업로드 완료. 응답 본문은 없다.' },
          '400': {
            description:
              'UPLOAD_METADATA_MISMATCH: Content-Type, Content-Length 또는 본문이 일치하지 않는다. UPLOAD_FAILED: 실제 바이트 길이가 다르거나 R2 쓰기에 실패했다.',
            content: errorContent,
          },
          ...capabilityErrors,
        },
      },
      get: {
        tags: ['Native Worker'],
        operationId: 'getNativeFileCapability',
        summary: '서명된 URL로 R2 파일 다운로드',
        description:
          'GET 메서드와 파일 키에 묶인 만료 전 토큰으로 파일을 내려받는다. PUT 업로드 토큰은 사용할 수 없다. 다운로드 토큰의 기본 유효 시간은 10분이고 발급 시 최대 1시간으로 지정할 수 있다. 토큰만으로 접근할 수 있지만 웹 세션 쿠키를 함께 보내면 공통 인증 미들웨어의 허용 Origin 검사가 적용된다.',
        security: [],
        responses: {
          '200': {
            description: 'R2에 저장된 HTTP 메타데이터와 원본 파일 바이트를 반환한다.',
            headers: {
              'Cache-Control': {
                description: '기본값은 private, no-store이며 R2 HTTP 메타데이터로 덮어쓸 수 있다.',
                schema: { type: 'string' },
              },
              'Content-Disposition': {
                description: '기본값은 attachment이며 R2 HTTP 메타데이터로 덮어쓸 수 있다.',
                schema: { type: 'string' },
              },
              'X-Content-Type-Options': { schema: { type: 'string', enum: ['nosniff'] } },
              ETag: { description: 'R2 객체의 HTTP ETag이다.', schema: { type: 'string' } },
            },
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { description: 'FILE_NOT_FOUND: R2 객체가 없다.', content: errorContent },
          ...capabilityErrors,
        },
      },
    },
  },
});

export function registerOpenApi(app: Hono<ApiEnv>): void {
  app.get('/openapi.json', (c) =>
    c.body(openapiJson, 200, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    }),
  );
  app.get(
    '/docs',
    swaggerUI({
      url: '/openapi.json',
      title: 'KOIN API',
      version: '5.32.0',
      validatorUrl: '',
      persistAuthorization: false,
      queryConfigEnabled: false,
    }),
  );
}
