import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';

import { languageQueries } from 'api/language/queries';
import Layout from 'components/layout';
import MobilePageHeader from 'components/layout/MobilePageHeader';
import { LANGUAGE_CODES, LANGUAGE_NATIVE_NAMES, type LanguageCode } from 'static/language';
import { parseLanguage } from 'utils/language/language';
import { useLanguage } from 'utils/language/useLanguage';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';
import { createPageLoader, definePageLoad } from 'utils/ssr/pageLoader';
import showToast from 'utils/ts/showToast';

import styles from 'pages/setting/SettingPage.module.scss';

const FALLBACK_LANGUAGES = LANGUAGE_CODES.map((code) => ({ code, name: LANGUAGE_NATIVE_NAMES[code] }));

function useLanguageOptions(): Array<{ code: LanguageCode; name: string }> {
  const { data } = useQuery(languageQueries.list());
  if (!data) return FALLBACK_LANGUAGES;

  // 웹이 아직 모르는 코드는 고를 수 없으므로 뺀다
  return data.languages.flatMap(({ code, name }) => {
    const language = parseLanguage(code);

    return language ? [{ code: language, name }] : [];
  });
}

function LanguageSettingPage() {
  const { language, changeLanguage } = useLanguage();
  const options = useLanguageOptions();
  const [pendingLanguage, setPendingLanguage] = useState<LanguageCode | null>(null);
  const { mutate } = useMutation({
    mutationFn: changeLanguage,
    onError: () => {
      setPendingLanguage(null);
      showToast('error', '언어를 변경하지 못했어요. 잠시 후 다시 시도해주세요.');
    },
  });
  const selected = pendingLanguage ?? language;
  const isChanging = pendingLanguage !== null;

  return (
    <>
      <MobilePageHeader title="언어 설정" />
      <main className={styles.page}>
        <ul className={styles.list} role="radiogroup" aria-label="언어 설정">
          {options.map(({ code, name }) => (
            <li key={code}>
              <label className={styles.row}>
                <span className={styles.row__title} lang={code}>
                  {name}
                </span>
                <input
                  type="radio"
                  name="language"
                  value={code}
                  className={styles.radio}
                  checked={selected === code}
                  disabled={isChanging}
                  onChange={() => {
                    if (code === language) return;
                    setPendingLanguage(code);
                    mutate(code);
                  }}
                />
              </label>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

// 지원 언어 목록은 방문자와 무관하므로 미리 받아 둔다
const loadPage = definePageLoad(async ({ queryClient }, cacheControl) => {
  try {
    await queryClient.fetchQuery(languageQueries.list());
    cacheControl.enablePublicCache();
  } catch {
    // 목록을 못 받아도 내장 목록으로 그린다. 이 응답은 공유 캐시에 남기지 않는다.
  }

  return {};
});

const getPageData = createServerFn({ method: 'GET', strict: { output: false } })
  .validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, loadPage));
const pageLoader = createPageLoader(getPageData, loadPage);

export const Route = createFileRoute('/setting/language/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps, context }) => pageLoader({ params, search: deps.search }, context),
  staticData: { title: '언어 설정 | KOIN' },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <Layout mobileHeader="page">
      <LanguageSettingPage />
    </Layout>
  );
}
