import * as puppeteer from 'puppeteer';
import { CrawlerService } from './crawler.service';

jest.mock('puppeteer', () => ({ launch: jest.fn() }));
// Exercise extraction and URL resolution offline, not p-limit's scheduling.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (task: () => Promise<unknown>) => task(),
}));

interface PageFixture {
  images?: Array<{ src?: string; srcset?: string }>;
  sources?: Array<string | null>;
  metadata?: string[];
}

const pageUrl = 'https://example.com/articles/index.html';

function evaluateInPage(callback: () => string[], fixture: PageFixture) {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => {
        switch (selector) {
          case 'a':
            return [];
          case 'img':
            return fixture.images ?? [];
          case 'source':
            return (fixture.sources ?? []).map((srcset) => ({
              getAttribute: (name: string) =>
                name === 'srcset' ? srcset : null,
            }));
          case 'meta[property="og:image"]':
            return (fixture.metadata ?? []).map((content) => ({
              getAttribute: (name: string) =>
                name === 'content' ? content : null,
            }));
          default:
            throw new Error(`Unexpected selector: ${selector}`);
        }
      },
    },
  });

  try {
    return callback();
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', previousDocument);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  }
}

function mockBrowser(fixture: PageFixture) {
  const pages: Array<{ goto: jest.Mock; close: jest.Mock }> = [];
  const close = jest.fn().mockResolvedValue(undefined);
  const newPage = jest.fn(() => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn((callback: () => string[]) =>
        Promise.resolve(evaluateInPage(callback, fixture)),
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
  return { pages, close };
}

function withSrcset(element: 'img' | 'source', srcset: string): PageFixture {
  return element === 'img' ? { images: [{ srcset }] } : { sources: [srcset] };
}

describe.each(['img', 'source'] as const)(
  'CrawlerService %s srcset extraction',
  (element) => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it.each([
      ['space', ' '],
      ['tab', '\t'],
      ['line feed', '\n'],
      ['form feed', '\f'],
      ['carriage return', '\r'],
      ['mixed ASCII whitespace', '\t\r\n\f  '],
    ])('separates URLs from descriptors using %s', async (_name, separator) => {
      const browser = mockBrowser(
        withSrcset(
          element,
          `/small.jpg${separator}320w, /large.jpg${separator}640w`,
        ),
      );

      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual([
        'https://example.com/small.jpg',
        'https://example.com/large.jpg',
      ]);
      expect(browser.pages).toHaveLength(2);
      for (const page of browser.pages) {
        expect(page.goto).toHaveBeenCalledWith(pageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        expect(page.close).toHaveBeenCalledTimes(1);
      }
      expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('handles density descriptors, surrounding whitespace and bare URLs', async () => {
      mockBrowser(
        withSrcset(
          element,
          '\t photo.jpg\t1x,\n ../retina.jpg\n2x,\r\n /original.jpg \f',
        ),
      );

      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual([
        'https://example.com/articles/photo.jpg',
        'https://example.com/retina.jpg',
        'https://example.com/original.jpg',
      ]);
    });

    it('preserves URL punctuation and encoded whitespace before the descriptor', async () => {
      mockBrowser(
        withSrcset(
          element,
          '//cdn.example.com/a%20b%09c.jpg?v=2#preview\t2x, /photo%0A.jpg 1x',
        ),
      );

      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual([
        'https://cdn.example.com/a%20b%09c.jpg?v=2#preview',
        'https://example.com/photo%0A.jpg',
      ]);
    });

    it('keeps non-ASCII whitespace within a URL rather than treating it as a descriptor separator', async () => {
      mockBrowser(withSrcset(element, '/a\u00a0b\u2003c.jpg 2x'));

      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual(['https://example.com/a%C2%A0b%E2%80%83c.jpg']);
    });

    it('ignores empty comma-separated candidates', async () => {
      mockBrowser(withSrcset(element, ', \t\n, /photo.jpg\t2x, ,'));

      await expect(
        new CrawlerService().extractImageUrls(pageUrl),
      ).resolves.toEqual(['https://example.com/photo.jpg']);
    });
  },
);

describe('CrawlerService combined image sources', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retains discovery order and deduplicates resolved URLs across image sources', async () => {
    mockBrowser({
      images: [
        {
          src: 'https://example.com/photo.jpg',
          srcset: '/photo.jpg\t1x, /retina.jpg\n2x',
        },
        { srcset: '/retina.jpg 1x, /third.jpg\f2x' },
      ],
      sources: ['/third.jpg\r320w, /wide.jpg\t640w'],
      metadata: ['/wide.jpg', '/social.jpg'],
    });

    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([
      'https://example.com/photo.jpg',
      'https://example.com/retina.jpg',
      'https://example.com/third.jpg',
      'https://example.com/wide.jpg',
      'https://example.com/social.jpg',
    ]);
  });

  it('returns an empty list for absent or whitespace-only srcsets', async () => {
    mockBrowser({
      images: [{}, { srcset: '' }, { srcset: '\t\n\f\r ' }],
      sources: [null, '', '\t\n\f\r '],
    });

    await expect(
      new CrawlerService().extractImageUrls(pageUrl),
    ).resolves.toEqual([]);
  });
});
