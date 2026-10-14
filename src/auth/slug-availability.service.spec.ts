import { RateLimiter } from '../common/throttle/rate-limiter';
import { SlugService } from '../slugs/slug.service';
import {
  SLUG_CHECKS_PER_MINUTE,
  SlugAvailabilityService,
} from './slug-availability.service';

describe('SlugAvailabilityService', () => {
  let slugs: { isAvailable: jest.Mock; suggest: jest.Mock };
  let service: SlugAvailabilityService;

  beforeEach(() => {
    slugs = {
      isAvailable: jest.fn().mockResolvedValue(true),
      suggest: jest.fn().mockResolvedValue(['acme-2', 'acme-3']),
    };
    service = new SlugAvailabilityService(
      slugs as unknown as SlugService,
      new RateLimiter(),
    );
  });

  it('a free slug is available and comes with no suggestions', async () => {
    await expect(service.check('acme-support', '1.1.1.1')).resolves.toEqual({
      available: true,
      suggestions: [],
    });
    expect(slugs.suggest).not.toHaveBeenCalled();
  });

  it('a taken slug is not available and comes with free alternatives', async () => {
    slugs.isAvailable.mockResolvedValue(false);
    await expect(service.check('acme', '1.1.1.1')).resolves.toEqual({
      available: false,
      suggestions: ['acme-2', 'acme-3'],
    });
    expect(slugs.suggest).toHaveBeenCalledWith('acme');
  });

  it('answers only availability and suggestions: nothing about who holds the slug', async () => {
    slugs.isAvailable.mockResolvedValue(false);
    const answer = await service.check('acme', '1.1.1.1');
    expect(Object.keys(answer).sort()).toEqual(['available', 'suggestions']);
  });

  it(`is limited to ${SLUG_CHECKS_PER_MINUTE} checks a minute per address (429), and other addresses have their own count`, async () => {
    for (let i = 0; i < SLUG_CHECKS_PER_MINUTE; i++) {
      await service.check(`slug-${i}`, '1.1.1.1');
    }
    await expect(service.check('one-more', '1.1.1.1')).rejects.toMatchObject({
      status: 429,
    });
    await expect(service.check('one-more', '2.2.2.2')).resolves.toBeDefined();
  });
});
