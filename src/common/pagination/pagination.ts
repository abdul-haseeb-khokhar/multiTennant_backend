export const DEFAULT_TAKE = 20;
export const MAX_TAKE = 100;

export interface Page<T> {
  data: T[];
  total: number;
  skip: number;
  take: number;
}

/** Applies the default and the maximum even when a service is called without the DTO pipe. */
export function resolvePage(query: { skip?: number; take?: number } = {}) {
  const skip = Math.max(query.skip ?? 0, 0);
  const take = Math.min(Math.max(query.take ?? DEFAULT_TAKE, 1), MAX_TAKE);
  return { skip, take };
}

export function toPage<T>(
  data: T[],
  total: number,
  page: { skip: number; take: number },
): Page<T> {
  return { data, total, skip: page.skip, take: page.take };
}
