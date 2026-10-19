import * as puppeteer from 'puppeteer';
import pLimit from 'p-limit';
import { CrawlerService } from './crawler.service';

jest.mock('puppeteer', () => ({ launch: jest.fn() }));
// Record the application's limiter configuration without testing p-limit itself.
// Jobs run immediately so deferred promises can control completion order.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: jest.fn(() => (job: () => Promise<unknown>) => job()),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function page(urls: string[] = []) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(urls),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const start = 'https://example.com/start';
const next = 'https://example.com/next';

describe('CrawlerService browser orchestration (offline)', () => {
  let service: CrawlerService;
  let browser: { newPage: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    browser = {
      newPage: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    jest
      .mocked(puppeteer.launch)
      .mockResolvedValue(browser as unknown as puppeteer.Browser);
    service = new CrawlerService();
  });

  it('propagates launch failure without attempting to acquire pages', async () => {
    const error = new Error('browser unavailable');
    jest.mocked(puppeteer.launch).mockRejectedValueOnce(error);

    await expect(service.extractImageUrls(start)).rejects.toBe(error);

    expect(browser.newPage).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(pLimit).not.toHaveBeenCalled();
  });

  it('closes the acquired browser when the initial page cannot be created', async () => {
    const error = new Error('cannot create crawl page');
    browser.newPage.mockRejectedValueOnce(error);

    await expect(service.extractImageUrls(start)).rejects.toBe(error);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(pLimit).not.toHaveBeenCalled();
  });

  it('closes the browser when extraction page creation fails after discovery', async () => {
    const discovery = page();
    const error = new Error('cannot create extraction page');
    browser.newPage
      .mockResolvedValueOnce(discovery)
      .mockRejectedValueOnce(error);

    await expect(service.extractImageUrls(start)).rejects.toBe(error);

    expect(discovery.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(pLimit).toHaveBeenCalledWith(5);
  });

  it('waits for discovery page cleanup before beginning image extraction', async () => {
    const discovery = page();
    const closing = deferred<void>();
    const closeStarted = deferred<void>();
    discovery.close.mockImplementation(() => {
      closeStarted.resolve();
      return closing.promise;
    });
    browser.newPage
      .mockResolvedValueOnce(discovery)
      .mockResolvedValueOnce(page(['/photo.jpg']));
    const result = service.extractImageUrls(start);
    await closeStarted.promise;

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(browser.newPage).toHaveBeenCalledTimes(1);
      expect(pLimit).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    } finally {
      closing.resolve();
      await result;
    }
    await expect(result).resolves.toEqual(['https://example.com/photo.jpg']);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
  });

  it('waits for every extraction and retains page order despite reverse completion', async () => {
    const first = page();
    const second = page(['/second.jpg', '/shared.jpg']);
    const firstImages = deferred<string[]>();
    const secondClosed = deferred<void>();
    first.evaluate.mockReturnValue(firstImages.promise);
    second.close.mockImplementation(() => {
      secondClosed.resolve();
      return Promise.resolve();
    });
    browser.newPage
      .mockResolvedValueOnce(page([next]))
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const result = service.extractImageUrls(start);
    await secondClosed.promise;

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(first.close).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    } finally {
      firstImages.resolve(['/first.jpg', '/shared.jpg']);
      await result;
    }

    await expect(result).resolves.toEqual([
      'https://example.com/first.jpg',
      'https://example.com/shared.jpg',
      'https://example.com/second.jpg',
    ]);
    expect(pLimit).toHaveBeenCalledTimes(1);
    expect(pLimit).toHaveBeenCalledWith(5);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(first.close.mock.invocationCallOrder[0]).toBeLessThan(
      browser.close.mock.invocationCallOrder[0],
    );
  });

  it('does not resolve until browser cleanup has completed', async () => {
    browser.newPage.mockImplementation(() => Promise.resolve(page()));
    const closing = deferred<void>();
    const closeStarted = deferred<void>();
    browser.close.mockImplementation(() => {
      closeStarted.resolve();
      return closing.promise;
    });
    let settled = false;
    const result = service.extractImageUrls(start).then((images) => {
      settled = true;
      return images;
    });
    await closeStarted.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      closing.resolve();
      await result;
    }
    await expect(result).resolves.toEqual([]);
    expect(settled).toBe(true);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('propagates browser cleanup failure rather than reporting successful cleanup', async () => {
    browser.newPage.mockImplementation(() => Promise.resolve(page()));
    const error = new Error('browser close failed');
    browser.close.mockRejectedValueOnce(error);

    await expect(service.extractImageUrls(start)).rejects.toBe(error);

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
