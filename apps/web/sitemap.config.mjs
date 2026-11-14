/**
 * 운영 공개 페이지 sitemap과 robots.txt 설정.
 * 빌드 뒤 scripts/generate-sitemap.mjs가 정적 파일을 생성한다. stage 빌드는 이 설정을 쓰지 않는다.
 */

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
  siteUrl: 'https://koreatech.in',
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
