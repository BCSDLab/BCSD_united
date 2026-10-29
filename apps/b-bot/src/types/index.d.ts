interface ImportMetaEnv {
  // Vite
  readonly DEV: boolean;

  readonly SLACK_BOT_TOKEN: string;
  readonly SLACK_BOT_SIGNING_SECRET: string;
  readonly CLARITY_TOKEN: string;
  readonly DATABASE_URL?: string;
  readonly GOOGLE_AUTH_SECRET?: string;
  readonly DB_HOST: string;
  readonly DB_PORT: string;
  readonly DB_USER: string;
  readonly DB_PASSWORD: string;
  readonly DB_NAME: string;
  readonly APP_BASE_URL: string;
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  readonly GOOGLE_REDIRECT_URI?: string;
  readonly ADMIN_NAME: string;
  /** 생협 기존 매장 조회 등 공개 API 기본 주소. 어드민 쓰기 API는 STAGE/PROD로 나뉜다. */
  readonly KOIN_API_BASE_URL?: string;
  readonly KOIN_ADMIN_EMAIL: string;
  readonly KOIN_ADMIN_PASSWORD: string;
  readonly KOIN_STAGE_API_BASE_URL?: string;
  readonly KOIN_STAGE_ADMIN_EMAIL?: string;
  readonly KOIN_STAGE_ADMIN_PASSWORD?: string;
  readonly KOIN_PROD_API_BASE_URL?: string;
  readonly KOIN_STAGE_SERVICE_TOKEN?: string;
  readonly KOIN_PROD_SERVICE_TOKEN?: string;
  readonly DINING_WORKER_ENVS?: string;
  readonly KOIN_PROD_ADMIN_EMAIL?: string;
  readonly KOIN_PROD_ADMIN_PASSWORD?: string;
  readonly SUPERSET_BASE_URL?: string;
  readonly SUPERSET_USERNAME?: string;
  readonly SUPERSET_PASSWORD?: string;
  readonly SUPERSET_DATASET_IDS?: string;
  readonly NOTION_TOKEN?: string;
  readonly GDRIVE_FOLDER_IDS?: string;
  /** 멤버 명단 원본(인터널). 예: https://internal.bcsdlab.com */
  readonly INTERNAL_API_BASE_URL?: string;
  readonly INTERNAL_SERVICE_TOKEN?: string;
}
interface ImportMeta {
  env: ImportMetaEnv;
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}
