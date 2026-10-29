import type { AxiosAdapter } from 'axios';

export const apiRequestAdapter: AxiosAdapter | undefined = undefined;

export function getApiBaseUrl(): string {
  return '/api';
}
