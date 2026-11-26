import { cn } from '@bcsdlab/utils';
import { useQuery } from '@tanstack/react-query';

import type { ArticleAiSummary as ArticleAiSummaryData, ArticleAiSummaryItem } from 'api/articles/entity';
import { articleQueries } from 'api/articles/queries';
import AiSummaryIcon from 'assets/svg/Articles/ai-summary.svg';
import TranslateButton from 'components/translation/TranslateButton';
import useContentTranslation, { translationSource } from 'components/translation/useContentTranslation';

import styles from './ArticleAiSummary.module.scss';

interface ArticleAiSummaryProps {
  articleId: number;
  aiSummary: ArticleAiSummaryData;
}

export default function ArticleAiSummary({ articleId, aiSummary: initialAiSummary }: ArticleAiSummaryProps) {
  // 409로 글을 다시 받았으면 새 요약을 그려 번역문·아이콘과 원문 버전을 맞춘다
  const { data: refetchedArticle } = useQuery({ ...articleQueries.detail(String(articleId)), enabled: false });
  const aiSummary = refetchedArticle?.ai_summary ?? initialAiSummary;
  const isNonSuccessStatus = aiSummary.status !== 'SUCCESS';
  const translation = useContentTranslation<{ items?: ArticleAiSummaryItem[] | null }>({
    resourceType: 'ARTICLE_SUMMARY',
    resourceId: articleId,
    translatePath: `/v2/articles/${articleId}/ai-summary/translations`,
    // 요약이 끝난 뒤에만 번역할 수 있다
    sourceVersion: aiSummary.status === 'SUCCESS' ? aiSummary.translation_source_version : null,
    source: translationSource(
      articleQueries.detail(String(articleId)),
      (data) => data.ai_summary.translation_source_version,
    ),
  });
  // 번역을 보여주는 동안에만 요약 문장을 번역문으로 바꾼다. 아이콘은 같은 순서의 원문 아이콘을 쓴다.
  const translatedItems = translation.translated?.items;
  const items = translatedItems
    ? translatedItems.map((item, index) => ({ ...item, icon: aiSummary.items[index]?.icon ?? item.icon }))
    : aiSummary.items;

  return (
    <section
      className={cn({
        [styles.container]: true,
        [styles['container--message']]: isNonSuccessStatus,
      })}
      aria-labelledby="article-ai-summary-title"
    >
      <div className={styles['heading-row']}>
        <div className={styles.heading}>
          <h2 id="article-ai-summary-title" className={styles.heading__title}>
            AI 요약
          </h2>
          <AiSummaryIcon className={styles['heading__ai-icon']} aria-hidden />
        </div>
        {translation.canTranslate && <TranslateButton state={translation.state} onClick={translation.toggle} />}
      </div>

      {aiSummary.status === 'SUCCESS' && (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={`${item.icon}-${item.text}`} className={styles.list__item}>
              <span className={styles.list__icon} aria-hidden>
                {item.icon}
              </span>
              <span className={styles.list__text}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}

      {isNonSuccessStatus && (
        <p className={styles.message}>{aiSummary.status === 'PENDING' ? '요약중...' : '요약할 내용이 없어요.'}</p>
      )}
    </section>
  );
}
