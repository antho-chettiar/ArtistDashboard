import { analyticsHeaders } from '../../services/madAnalytics.service';

jest.mock('../../utils/database', () => ({ prisma: {} }));

describe('analyticsHeaders', () => {
  const original = process.env.ANALYTICS_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.ANALYTICS_API_KEY;
    else process.env.ANALYTICS_API_KEY = original;
  });

  it('adds the shared-secret header when ANALYTICS_API_KEY is configured', () => {
    process.env.ANALYTICS_API_KEY = ' secret-value ';
    expect(analyticsHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      'X-Analytics-Key': 'secret-value',
    });
  });

  it('sends nothing extra when no key is configured (local development)', () => {
    delete process.env.ANALYTICS_API_KEY;
    expect(analyticsHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    });
    expect(analyticsHeaders()).toEqual({});
  });

  it('treats a blank key as not configured', () => {
    process.env.ANALYTICS_API_KEY = '   ';
    expect(analyticsHeaders()).toEqual({});
  });
});
