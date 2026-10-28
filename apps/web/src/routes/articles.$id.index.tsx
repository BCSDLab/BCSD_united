import { createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadPageData, validatePageInput } from 'utils/ssr/pageData';


import * as Sentry from '@sentry/core';
import { getArticle, getHotArticles } from 'api/articles';
import type { ArticleResponseWithNew, HotArticle } from 'api/articles/entity';
import ArticlesPageLayout from 'components/Articles/ArticlesPage';
import ArticleAiSummary from 'components/Articles/components/ArticleAiSummary';
import ArticleContent from 'components/Articles/components/ArticleContent';
import ArticleHeader from 'components/Articles/components/ArticleHeader';
import MobileArticleDetailFooter from 'components/Articles/components/MobileArticleDetailFooter';
import { isNewArticle } from 'components/Articles/utils/setArticleRegisteredDate';
import { SSRLayout } from 'components/layout';
import { ARTICLE_DETAIL_ISR_REVALIDATE_SECONDS, isNotFoundKoinError, withStaticFetchRetry } from 'utils/ts/isr';





export default function ArticlesDetailPage({
  article,
  hotArticles,
}: {
  article: ArticleResponseWithNew;
  hotArticles?: HotArticle[];
}) {
  return (
    <ArticlesPageLayout>
      <ArticleHeader
        boardId={article.board_id}
        title={article.title}
        registeredAt={article.registered_at}
        author={article.author}
        hit={article.hit}
        isNew={article.isNew}
      />
      <ArticleAiSummary aiSummary={article.ai_summary} />
      <ArticleContent content={article.content} attachments={article.attachments} />
      <MobileArticleDetailFooter prevId={article.prev_id} nextId={article.next_id} hotArticles={hotArticles} />
    </ArticlesPageLayout>
  );
}



const getPageData = createServerFn({ method: 'GET', strict: { output: false } }).validator(validatePageInput)
  .handler(({ data }) => loadPageData(data, async ({ params }, cacheControl) => {
  const { id } = params;
  if (!id) {
    cacheControl.enablePublicCache(`public, s-maxage=${ARTICLE_DETAIL_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
throw notFound();
  }

  try {
    const article = await withStaticFetchRetry('article.detail', () => getArticle(id));
    const hotArticles = (await withStaticFetchRetry('article.hot', () => getHotArticles()).catch(() => [])) ?? [];
    const serverTime = new Date();

    const articleWithNew = Sentry.startSpan(
      {
        name: 'Transform article detail',
        op: 'koin.isr.transform',
        onlyIfParent: true,
        attributes: { 'isr.resource': 'article.detail' },
      },
      (): ArticleResponseWithNew => ({
        ...article,
        isNew: isNewArticle(article.registered_at, serverTime),
      }),
    );

    cacheControl.enablePublicCache(`public, s-maxage=${ARTICLE_DETAIL_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
return { article: articleWithNew, hotArticles };
  } catch (error) {
    if (isNotFoundKoinError(error)) {
      cacheControl.enablePublicCache(`public, s-maxage=${ARTICLE_DETAIL_ISR_REVALIDATE_SECONDS}, stale-while-revalidate=300`);
throw notFound();
    }
    throw error;
  }
}));

export const Route = createFileRoute('/articles/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ params, deps }) => getPageData({ data: { params, search: deps.search } }),
  component: RouteComponent,
});

function RouteComponent() {
  const props = Route.useLoaderData();
  const page = <ArticlesDetailPage {...props} />;
  return <SSRLayout>{page}</SSRLayout>;
}
