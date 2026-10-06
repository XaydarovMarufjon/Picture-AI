import { Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import { CrawlerService } from './crawler.service';

jest.mock('puppeteer', () => ({ launch: jest.fn() }));
jest.mock('p-limit', () => ({
  __esModule: true,
  default:
    () =>
    <T>(callback: () => T | Promise<T>) =>
      Promise.resolve().then(callback),
}));

type PageFixture = {
  links?: string[];
  images?: string[];
  redirectedTo?: string;
  navigationError?: Error;
};

const startUrl = 'https://example.com/start';

// Execute the real synchronous page callback against a small DOM fixture.
// Puppeteer, concurrency scheduling, and all navigation are mocked.
function evaluateInPage(
  callback: (origin: string) => string[],
  origin: string,
  fixture: PageFixture,
  url: string,
) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const locationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => {
        if (selector === 'a') {
          return (fixture.links ?? []).map((href) => ({ href }));
        }
        if (selector === 'img') {
          return (fixture.images ?? []).map((src) => ({ src, srcset: '' }));
        }
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(fixture.redirectedTo ?? url),
  });

  try {
    return callback(origin);
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (locationDescriptor) {
      Object.defineProperty(globalThis, 'location', locationDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  }
}

function mockBrowser(fixtures: Record<string, PageFixture>) {
  const visited: string[] = [];
  const pages: Array<{ close: jest.Mock }> = [];
  const close = jest.fn().mockResolvedValue(undefined);
  const newPage = jest.fn(() => {
    let url = '';
    const page = {
      goto: jest.fn((nextUrl: string) => {
        url = nextUrl;
        visited.push(url);
        const error = fixtures[url]?.navigationError;
        return error ? Promise.reject(error) : Promise.resolve();
      }),
      evaluate: jest.fn(
        (callback: (origin: string) => string[], origin: string) =>
          Promise.resolve(
            evaluateInPage(callback, origin, fixtures[url] ?? {}, url),
          ),
      ),
      close: jest.fn().mockResolvedValue(undefined),
    };
    pages.push(page);
    return Promise.resolve(page);
  });

  jest.mocked(puppeteer.launch).mockResolvedValue({
    newPage,
    close,
  } as unknown as puppeteer.Browser);

  return { visited, pages, close };
}

describe('CrawlerService page origin boundary', () => {
  let service: CrawlerService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    service = new CrawlerService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['hostname prefix', 'https://example.com.evil.test/page'],
    ['hostname suffix', 'https://example.com-extra.test/page'],
    ['URL credentials', 'https://example.com@evil.test/page'],
    ['different port', 'https://example.com:8443/page'],
    ['different scheme', 'http://example.com/page'],
    ['subdomain', 'https://sub.example.com/page'],
    ['unrelated host', 'https://other.test/page'],
    ['script URL', 'javascript:void(0)'],
    ['data URL', 'data:text/html,example'],
    ['mail URL', 'mailto:hello@example.com'],
  ])('does not enqueue a link with %s', async (_description, externalUrl) => {
    const localUrl = 'https://example.com/news';
    const browser = mockBrowser({
      [startUrl]: { links: [externalUrl, localUrl] },
    });

    await service.extractImageUrls(startUrl);

    expect(browser.visited).toEqual([startUrl, localUrl, startUrl, localUrl]);
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const page of browser.pages) {
      expect(page.close).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores malformed links without discarding valid links that follow', async () => {
    const localUrl = 'https://example.com/news';
    const browser = mockBrowser({
      [startUrl]: { links: ['https://[invalid', '', localUrl] },
    });

    await service.extractImageUrls(startUrl);

    expect(browser.visited).toEqual([startUrl, localUrl, startUrl, localUrl]);
  });

  it('accepts the normalized starting origin and retains path/query ordering', async () => {
    const start = 'https://EXAMPLE.com:443/start';
    const links = ['https://example.com/news', 'https://example.com/?page=2'];
    const browser = mockBrowser({ [start]: { links } });

    await service.extractImageUrls(start);

    expect(browser.visited).toEqual([start, ...links, start, ...links]);
  });

  it('keeps the starting origin when a page redirects to another site', async () => {
    const localUrl = 'https://example.com/news';
    const browser = mockBrowser({
      [startUrl]: {
        redirectedTo: 'https://other.test/landing',
        links: ['https://other.test/next', localUrl],
      },
    });

    await service.extractImageUrls(startUrl);

    expect(browser.visited).toEqual([startUrl, localUrl, startUrl, localUrl]);
  });

  it('still returns off-site images discovered on accepted pages', async () => {
    const image = 'https://cdn.other.test/photo.jpg';
    mockBrowser({ [startUrl]: { images: [image] } });

    await expect(service.extractImageUrls(startUrl)).resolves.toEqual([image]);
  });

  it('retains duplicate-link suppression and the 20-page limit', async () => {
    const links = Array.from(
      { length: 25 },
      (_, index) => `https://example.com/page-${index}`,
    );
    const browser = mockBrowser({
      [startUrl]: { links: [startUrl, links[0], ...links] },
      [links[0]]: { links: [startUrl, links[1]] },
    });

    await service.extractImageUrls(startUrl);

    const expected = [startUrl, ...links.slice(0, 19)];
    expect(browser.visited).toEqual([...expected, ...expected]);
  });

  it('closes pages and the browser after a navigation failure', async () => {
    const localUrl = 'https://example.com/news';
    const browser = mockBrowser({
      [startUrl]: { links: [localUrl] },
      [localUrl]: { navigationError: new Error('navigation failed') },
    });

    await expect(service.extractImageUrls(startUrl)).resolves.toEqual([]);

    expect(browser.visited).toEqual([startUrl, localUrl, startUrl, localUrl]);
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const page of browser.pages) {
      expect(page.close).toHaveBeenCalledTimes(1);
    }
  });
});
