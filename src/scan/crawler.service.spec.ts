import * as puppeteer from 'puppeteer';
import { CrawlerService } from './crawler.service';

jest.mock('puppeteer', () => ({ launch: jest.fn() }));
// This suite tests URL resolution and cleanup, not p-limit's concurrency.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (task: () => Promise<unknown>) => task(),
}));

describe('CrawlerService image URL resolution', () => {
  const pageUrl = 'https://example.com/articles/page';
  let page: {
    goto: jest.Mock;
    evaluate: jest.Mock;
    close: jest.Mock;
  };
  let browser: { newPage: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    page = {
      goto: jest.fn().mockResolvedValue(undefined),
      // The first evaluation crawls links; the second extracts images.
      evaluate: jest.fn().mockResolvedValueOnce([]),
      close: jest.fn().mockResolvedValue(undefined),
    };
    browser = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    jest
      .mocked(puppeteer.launch)
      .mockResolvedValue(browser as unknown as puppeteer.Browser);
  });

  it.each([
    ['first', ['http://[invalid', '/photo.jpg', 'images/large.jpg']],
    ['middle', ['/photo.jpg', 'http://[invalid', 'images/large.jpg']],
    ['last', ['/photo.jpg', 'images/large.jpg', 'http://[invalid']],
  ])('keeps valid images when a malformed candidate is %s', async (_, urls) => {
    page.evaluate.mockResolvedValueOnce(urls);

    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([
      'https://example.com/photo.jpg',
      'https://example.com/articles/images/large.jpg',
    ]);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('preserves absolute and relative URLs and deduplicates resolved images', async () => {
    page.evaluate.mockResolvedValueOnce([
      '/photo.jpg',
      'https://example.com/photo.jpg',
      '//cdn.example.com/large.jpg',
      '../other.jpg',
      'https://cdn.example.com/image.jpg?size=large#preview',
    ]);

    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([
      'https://example.com/photo.jpg',
      'https://cdn.example.com/large.jpg',
      'https://example.com/other.jpg',
      'https://cdn.example.com/image.jpg?size=large#preview',
    ]);
  });

  it('keeps parseable non-HTTP candidates for the existing downstream filter', async () => {
    const urls = [
      'data:image/png;base64,abc',
      'blob:https://example.com/image-id',
    ];
    page.evaluate.mockResolvedValueOnce(['http://[invalid', ...urls]);
    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual(urls);
  });

  it.each([
    { urls: [] },
    { urls: ['http://[invalid', 'https://[also-invalid'] },
  ])(
    'returns no images for empty or entirely malformed candidates (%j)',
    async ({ urls }) => {
      page.evaluate.mockResolvedValueOnce(urls);
      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual([]);
      expect(page.close).toHaveBeenCalledTimes(2);
      expect(browser.close).toHaveBeenCalledTimes(1);
    },
  );

  it('still closes resources when image evaluation fails', async () => {
    page.evaluate.mockRejectedValueOnce(new Error('page detached'));
    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([]);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('still closes resources when image navigation fails', async () => {
    page.goto
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([]);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
