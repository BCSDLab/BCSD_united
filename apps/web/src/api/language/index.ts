import APIClient from 'utils/ts/apiClient';

import { Languages, Messages, MyLanguage, Policy, UpdateMyLanguage } from './APIDetail';

export const getLanguages = APIClient.of(Languages);

export const getMyLanguage = APIClient.of(MyLanguage);

export const updateMyLanguage = APIClient.of(UpdateMyLanguage);

export const getPolicy = APIClient.of(Policy);

export const getMessages = APIClient.of(Messages);
