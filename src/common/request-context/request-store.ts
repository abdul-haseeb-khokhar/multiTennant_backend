import { AsyncLocalStorage } from 'node:async_hooks';

/** Request metadata that services (the audit log) need without every call passing `req` along. */
export interface RequestMeta {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export const requestStore = new AsyncLocalStorage<RequestMeta>();

export function currentRequestMeta(): RequestMeta {
  return requestStore.getStore() ?? {};
}
