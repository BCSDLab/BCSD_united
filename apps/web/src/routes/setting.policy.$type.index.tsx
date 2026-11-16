import { createFileRoute, notFound } from '@tanstack/react-router';

import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import Seo from 'components/seo/Seo';
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from 'static/policy';
import { marketing } from 'static/terms';

import styles from 'pages/setting/SettingPolicyPage.module.scss';

const POLICY_TYPES = ['privacy', 'terms', 'marketing'] as const;
type PolicyType = (typeof POLICY_TYPES)[number];

const POLICY_TITLES: Record<PolicyType, string> = {
  privacy: '개인정보 처리방침',
  terms: '코인 이용약관',
  marketing: '마케팅 수신 동의 약관',
};

interface PolicySection {
  id: number;
  title: string;
  content: string | string[];
  items?: string[];
  additionalContent?: string;
  additionalItems?: string[];
}

function PolicyList({ items }: { items: string[] }) {
  return (
    <ul className={styles.section__items}>
      {items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- static/policy의 고정 텍스트라 재정렬되지 않는다.
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
        // eslint-disable-next-line react/no-array-index-key -- static/policy의 고정 텍스트라 재정렬되지 않는다.
        <p key={index}>{text}</p>
      ))}
      {items && <PolicyList items={items} />}
      {additionalContent && <p>{additionalContent}</p>}
      {additionalItems && <PolicyList items={additionalItems} />}
    </section>
  ));
}

function SettingPolicyPage({ type }: { type: PolicyType }) {
  return (
    <>
      <Seo title={`${POLICY_TITLES[type]} | KOIN`} />
      <MobilePageHeader title={POLICY_TITLES[type]} />
      <main className={styles.page}>
        {type === 'privacy' && <PolicySections sections={PRIVACY_POLICY} />}
        {type === 'terms' && <PolicySections sections={TERMS_OF_SERVICE} />}
        {/* 첫 줄은 약관 제목이라 헤더와 겹친다 */}
        {type === 'marketing' && <p className={styles.text}>{marketing.split('\n').slice(1).join('\n').trim()}</p>}
      </main>
    </>
  );
}

const isPolicyType = (value: string): value is PolicyType => (POLICY_TYPES as readonly string[]).includes(value);

export const Route = createFileRoute('/setting/policy/$type/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  beforeLoad: ({ params }) => {
    if (!isPolicyType(params.type)) throw notFound();
  },
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
