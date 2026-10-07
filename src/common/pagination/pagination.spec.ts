import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';
import { DEFAULT_TAKE, MAX_TAKE, resolvePage, toPage } from './pagination';

describe('pagination', () => {
  it('defaults to skip 0, take 20 and caps take at 100', () => {
    expect(DEFAULT_TAKE).toBe(20);
    expect(MAX_TAKE).toBe(100);
    expect(resolvePage()).toEqual({ skip: 0, take: 20 });
    expect(resolvePage({ skip: 10, take: 50 })).toEqual({ skip: 10, take: 50 });
    expect(resolvePage({ take: 100 })).toEqual({ skip: 0, take: 100 });
    expect(resolvePage({ take: 101 })).toEqual({ skip: 0, take: 100 });
  });

  it('never returns a negative skip or a take below 1', () => {
    expect(resolvePage({ skip: -5, take: 0 })).toEqual({ skip: 0, take: 1 });
  });

  it('builds the { data, total, skip, take } envelope', () => {
    expect(toPage(['a'], 7, { skip: 3, take: 1 })).toEqual({
      data: ['a'],
      total: 7,
      skip: 3,
      take: 1,
    });
  });

  describe('PaginationQueryDto', () => {
    const errors = (query: Record<string, string>) =>
      validateSync(plainToInstance(PaginationQueryDto, query));

    it('accepts query strings and valid bounds', () => {
      expect(errors({})).toHaveLength(0);
      expect(errors({ skip: '0', take: '1' })).toHaveLength(0);
      expect(errors({ skip: '40', take: '100' })).toHaveLength(0);
    });

    it.each<Record<string, string>>([
      { take: '101' },
      { take: '0' },
      { skip: '-1' },
      { take: 'abc' },
      { skip: '1.5' },
    ])('rejects %j', (query) => {
      expect(errors(query).length).toBeGreaterThan(0);
    });
  });
});
