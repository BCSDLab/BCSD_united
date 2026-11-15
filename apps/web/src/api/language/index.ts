import APIClient from 'utils/ts/apiClient';

import { Languages, MyLanguage, UpdateMyLanguage } from './APIDetail';

export const getLanguages = APIClient.of(Languages);

export const getMyLanguage = APIClient.of(MyLanguage);

export const updateMyLanguage = APIClient.of(UpdateMyLanguage);
