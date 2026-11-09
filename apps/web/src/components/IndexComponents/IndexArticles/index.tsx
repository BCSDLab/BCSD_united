import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { articleQueries } from 'api/articles/queries';
import ArrowRightIcon from 'assets/svg/common/arrow-right-icon.svg';
import { convertArticlesTag } from 'components/Articles/utils/convertArticlesTag';
import { createArticlesWithNewSelector } from 'components/Articles/utils/selectArticlesData';
import ROUTES from 'static/routes';
import useLogger from 'utils/hooks/analytics/useLogger';
import useIsLoggedIn from 'utils/hooks/state/useIsLoggedIn';

import styles from './IndexArticles.module.scss';

interface IndexArticlesProps {
  serverNow: string;
}

export default function IndexArticles({ serverNow }: IndexArticlesProps) {
  const isLoggedIn = useIsLoggedIn();
  const { data: articlesData } = useQuery({
    ...articleQueries.list(isLoggedIn, '1'),
    select: createArticlesWithNewSelector(serverNow),
  });
  const logger = useLogger();

  return (
    <section className={styles.template}>
      <div className={styles.template__header}>
        <Link
          to={ROUTES.Articles()}
          onClick={() =>
            logger.actionEventClick({
              event_name: 'DA2',
              event_label: 'board__main__notice_entry__title_entry__click',
              value: '공지사항',
            })
          }
        >
          <h2 className={styles.template__title}>공지사항</h2>
        </Link>
        <Link
          to={ROUTES.Articles()}
          className={styles.template__link}
          onClick={() =>
            logger.actionEventClick({
              event_name: 'DA2',
              event_label: 'board__main__notice_entry__more_entry__click',
              value: '공지사항 더보기',
            })
          }
        >
          전체보기
          <ArrowRightIcon aria-hidden />
        </Link>
      </div>

      <ul className={styles.list}>
        {articlesData?.articles.slice(0, 5).map((article) => (
          <li key={article.id} className={styles.list__item}>
            <Link
              to={ROUTES.ArticlesDetail({ id: String(article.id) })}
              preload={false}
              className={styles['list__item-link']}
              onClick={() =>
                logger.actionEventClick({
                  event_name: 'DA2',
                  event_label: 'board__main__notice_detail__entry__click',
                  value: String(article.id),
                })
              }
            >
              <span className={styles['list__item-type']}>{convertArticlesTag(article.board_id)}</span>
              <span className={styles['list__item-title']}>{article.title}</span>
              {article.isNew && (
                <img
                  className={styles['list__item-tag']}
                  src="https://static.koreatech.in/upload/7f2af097aeeca368b0a491f9e00f80ca.png"
                  alt="NEW"
                  aria-hidden
                />
              )}
            </Link>
            <span className={styles['list__item-registered']}>{article.registered_at.replaceAll('-', '.')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
