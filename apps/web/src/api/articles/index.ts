import { createServerFn } from '@tanstack/react-start';

import APIClient from 'utils/ts/apiClient';

import {
  GetArticles,
  GetHotArticles,
  GetArticlesHotKeyword,
  SearchArticles,
  GetArticle,
  GetLostItemArticles,
  GetSingleLostItemArticle,
  DeleteLostItemArticle,
  PostLostItemArticles,
  PostReportLostItemArticle,
  PostLostItemChatroom,
  PostBlockLostItemChatroom,
  GetLostItemStat,
  PostFoundLostItem,
  PutLostItemArticle,
  GetLostItemSearch,
} from './APIDetail';
import { fetchArticleContent } from './content.server';
import { getArticleContentUrl } from './contentUrl';

const readArticleContent = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (typeof value !== 'string' || !getArticleContentUrl(value)) {
      throw new TypeError('Invalid article content URL');
    }

    return value;
  })
  .handler(({ data }) => fetchArticleContent(data));

export const getArticles = (page: string, boardId?: number) => APIClient.of(GetArticles)(page, boardId);

export const getArticle = async (id: string | undefined) => {
  const article = await APIClient.of(GetArticle)(id);
  const contentUrl = getArticleContentUrl(article.content);
  if (!contentUrl) return article;

  return { ...article, content: await readArticleContent({ data: contentUrl }) };
};

export const getHotArticles = APIClient.of(GetHotArticles);

export const getArticlesHotKeyword = APIClient.of(GetArticlesHotKeyword);

export const searchArticles = APIClient.of(SearchArticles);

export const getLostItemArticles = APIClient.of(GetLostItemArticles);

export const getSingleLostItemArticle = APIClient.of(GetSingleLostItemArticle);

export const postLostItemArticle = APIClient.of(PostLostItemArticles);

export const deleteLostItemArticle = APIClient.of(DeleteLostItemArticle);

export const postReportLostItemArticle = APIClient.of(PostReportLostItemArticle);

export const postLostItemChatroom = APIClient.of(PostLostItemChatroom);

export const postBlockLostItemChatroom = APIClient.of(PostBlockLostItemChatroom);

export const getLostItemStat = APIClient.of(GetLostItemStat);

export const postFoundLostItem = APIClient.of(PostFoundLostItem);

export const putLostItemArticle = APIClient.of(PutLostItemArticle);

export const getLostItemSearch = APIClient.of(GetLostItemSearch);
