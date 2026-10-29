/**
 * 공개 페이지 sitemap과 robots.txt 설정.
 * 빌드 뒤 scripts/generate-sitemap.mjs가 정적 파일을 생성한다.
 * stage/prod 환경 분기는 NEXT_PUBLIC_API_PATH 에 'stage' 포함 여부로 판단 (src/static/url.ts 와 동일 규칙).
 */

const IS_STAGE = process.env.NEXT_PUBLIC_API_PATH?.includes('stage');
const SITE_URL = IS_STAGE ? 'https://stage.koreatech.in' : 'https://koreatech.in';

const PRIVATE_PATHS = [
  '/auth',
  '/auth/*',
  '/webview/*',
  '/report/*',
  '/callvan/add',
  '/callvan/chat/*',
  '/callvan/notifications',
  '/callvan/*/participants',
  '/callvan/*/report/*',
  '/timetable/modify',
  '/clubs/new',
  '/clubs/edit/*',
  '/clubs/recruitment/edit/*',
  '/clubs/*/event/edit/*',
  '/lost-item/edit/*',
  '/lost-item/report/*',
  '/lost-item/chat',
  '/team/chat',
  '/store/review/*',
  '/store/review/edit/**',
];

export default {
  siteUrl: SITE_URL,
  generateRobotsTxt: true,
  sitemapSize: 5000,
  changefreq: 'daily',
  priority: 0.7,
  exclude: ['/404', '/_error', '/_app', '/_document', ...PRIVATE_PATHS],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/auth',
          '/webview',
          '/report',
          '/callvan/add',
          '/callvan/chat',
          '/callvan/notifications',
          '/timetable/modify',
          '/clubs/new',
          '/clubs/edit',
          '/clubs/recruitment/edit',
          '/lost-item/edit',
          '/lost-item/report',
          '/lost-item/chat',
          '/team/chat',
          '/store/review',
        ],
      },
    ],
  },
};
