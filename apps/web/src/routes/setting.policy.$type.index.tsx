import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import type { PolicySection } from 'api/language/entity';
import { languageQueries } from 'api/language/queries';
import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import Seo from 'components/seo/Seo';
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from 'static/policy';
import { marketing } from 'static/terms';
import { useLanguage } from 'utils/language/useLanguage';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';

import styles from 'pages/setting/SettingPolicyPage.module.scss';

const POLICY_TYPES = ['privacy', 'terms', 'marketing'] as const;
type PolicyType = (typeof POLICY_TYPES)[number];
type ApiPolicyType = Exclude<PolicyType, 'marketing'>;

const POLICY_TITLES: Record<PolicyType, string> = {
  privacy: '개인정보 처리방침',
  terms: '코인 이용약관',
  marketing: '마케팅 수신 동의 약관',
};

function PolicyList({ items }: { items: string[] }) {
  return (
    <ul className={styles.section__items}>
      {items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- 약관 문단은 순서가 고정이라 재정렬되지 않는다.
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function PolicySections({ sections }: { sections: readonly PolicySection[] }) {
  return sections.map(({ id, title, content, items, additionalContent, additionalItems }) => (
    <section key={id} className={styles.section}>
      <h2 className={styles.section__title}>{title}</h2>
      {(Array.isArray(content) ? content : [content]).map((text, index) => (
        // eslint-disable-next-line react/no-array-index-key -- 약관 문단은 순서가 고정이라 재정렬되지 않는다.
        <p key={index}>{text}</p>
      ))}
      {items && <PolicyList items={items} />}
      {additionalContent && <p>{additionalContent}</p>}
      {additionalItems && <PolicyList items={additionalItems} />}
    </section>
  ));
}

// 내장 문서는 정책 API를 받지 못했을 때만 쓴다
const BUILT_IN_POLICIES: Record<ApiPolicyType, readonly PolicySection[]> = {
  privacy: PRIVACY_POLICY,
  terms: TERMS_OF_SERVICE,
};

// 개인정보 처리방침과 이용약관은 화면 언어로 받는다. 번역이 없으면 서버가 한국어 원문을 내려준다.
function ApiPolicy({ type }: { type: ApiPolicyType }) {
  const { language } = useLanguage();
  // 언어가 바뀌어 새 문서를 받는 동안 내장 문서로 깜빡이지 않도록 이전 문서를 유지한다
  const { data } = useQuery({ ...languageQueries.policy(type, language), placeholderData: keepPreviousData });

  return (
    <div lang={data?.language ?? 'ko-KR'} className={styles.sections}>
      <PolicySections sections={data?.sections ?? BUILT_IN_POLICIES[type]} />
    </div>
  );
}

function SettingPolicyPage({ type }: { type: PolicyType }) {
  return (
    <>
      <Seo title={`${POLICY_TITLES[type]} | KOIN`} />
      <MobilePageHeader title={POLICY_TITLES[type]} />
      <main className={styles.page}>
        {type === 'marketing' ? (
          // 마케팅 수신 동의 약관은 정책 API가 없어 한국어 원문만 보여준다. 첫 줄은 약관 제목이라 헤더와 겹친다.
          <p lang="ko-KR" className={styles.text}>
            {marketing.split('\n').slice(1).join('\n').trim()}
          </p>
        ) : (
          <ApiPolicy type={type} />
        )}
      </main>
    </>
  );
}

const isPolicyType = (value: string): value is PolicyType => (POLICY_TYPES as readonly string[]).includes(value);

const loadPage = definePageLoad(async ({ params, queryClient }, cacheControl, serverRequest) => {
  const { type } = params;
  try {
    if (type === 'privacy' || type === 'terms') {
      await queryClient.fetchQuery(languageQueries.policy(type, serverRequest.language));
    }
    cacheControl.enablePublicCache();
  } catch {
    // 받지 못하면 내장 문서로 그린다. 이 응답은 공유 캐시에 남기지 않는다.
  }

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/setting/policy/$type/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  beforeLoad: ({ params }) => {
    if (!isPolicyType(params.type)) throw notFound();
  },
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  staticData: { hasPageSeo: true },
  component: RouteComponent,
});

function RouteComponent() {
  const { type } = Route.useParams();
  if (!isPolicyType(type)) return null;

  return (
    <Layout mobileHeader="page">
      <SettingPolicyPage type={type} />
    </Layout>
  );
}
