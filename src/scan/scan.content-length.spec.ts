import { Logger } from '@nestjs/common';
import axios from 'axios';
import type { PrismaService } from '../prisma/prisma.service';
import type { CrawlerService } from './crawler.service';
import type { ModerationService } from './moderation/moderation.service';
import type { ModerationResult } from './moderation/moderators/moderator.interface';
import type { ScanGateway } from './scan.gateway';
import { ScanService } from './scan.service';

jest.mock('axios');
jest.mock('./crawler.service', () => ({ CrawlerService: jest.fn() }));
jest.mock('./moderation/moderation.service', () => ({
  ModerationService: jest.fn(),
}));
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: jest.fn() }), {
  virtual: true,
});
// Jobs run immediately; real p-limit queue behavior is not under test.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (job: () => Promise<unknown>) => job(),
}));

const site = 'https://site.test/articles';
const image = 'https://cdn.test/photo.jpg';

describe('ScanService content-length filter (offline)', () => {
  let head: jest.SpiedFunction<typeof axios.head>;
  let get: jest.SpiedFunction<typeof axios.get>;
  let crawl: jest.Mock<Promise<string[]>, [string]>;
  let checkSmart: jest.Mock<Promise<ModerationResult[]>, [string]>;
  let create: jest.Mock;
  let update: jest.Mock;
  let upsert: jest.Mock;
  let progress: jest.Mock;
  let service: ScanService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    crawl = jest.fn<Promise<string[]>, [string]>().mockResolvedValue([image]);
    checkSmart = jest
      .fn<Promise<ModerationResult[]>, [string]>()
      .mockResolvedValue([{ provider: 'fixture', label: 'safe', score: 0.9 }]);
    create = jest.fn().mockResolvedValue({ id: 42 });
    update = jest.fn().mockResolvedValue(undefined);
    upsert = jest.fn().mockResolvedValue(undefined);
    progress = jest.fn();
    head = jest.spyOn(axios, 'head');
    get = jest
      .spyOn(axios, 'get')
      .mockImplementation((url) => Promise.resolve({ data: Buffer.from(url) }));
    service = new ScanService(
      { extractImageUrls: crawl } as unknown as CrawlerService,
      { checkSmart } as unknown as ModerationService,
      {
        scan: { create, update },
        scanItem: { upsert },
      } as unknown as PrismaService,
      { sendProgress: progress } as unknown as ScanGateway,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '  '],
    ['zero', '0'],
    ['negative', '-8192'],
    ['below threshold', '5119'],
    ['non-numeric', 'unknown'],
    ['NaN text', 'NaN'],
    ['positive infinity', 'Infinity'],
    ['negative infinity', '-Infinity'],
    ['overflowing number', '1e309'],
    ['number with unit', '8192 bytes'],
    ['combined values', '8192, 8192'],
  ])(
    'skips %s metadata before downloading or moderating',
    async (_name, length) => {
      head.mockResolvedValue({ headers: { 'content-length': length } });
      await expect(service.scan(site)).resolves.toEqual({
        scanId: 42,
        total: 1,
        processed: 0,
        saved: 0,
      });
      expect(head).toHaveBeenCalledWith(image, { timeout: 5000 });
      expect(get).not.toHaveBeenCalled();
      expect(checkSmart).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: { siteUrl: site, status: 'running', progress: 0 },
      });
      expect(update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { status: 'finished' },
      });
      expect(progress).toHaveBeenCalledWith({ stage: 'filter', count: 0 });
    },
  );

  it.each(['5120', '5121', '8192', ' 8192 ', '005120'])(
    'retains finite accepted length %s',
    async (length) => {
      head.mockResolvedValue({ headers: { 'content-length': length } });
      await expect(service.scan(site)).resolves.toEqual({
        scanId: 42,
        total: 1,
        processed: 1,
        saved: 1,
      });
      expect(checkSmart).toHaveBeenCalledWith(image);
      expect(get).toHaveBeenCalledTimes(2);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(progress).toHaveBeenCalledWith({ stage: 'filter', count: 1 });
    },
  );

  it('isolates malformed metadata and failed HEAD requests from valid images', async () => {
    const urls = ['invalid', 'first', 'failed', 'overflow', 'last'].map(
      (name) => `https://cdn.test/${name}.jpg`,
    );
    crawl.mockResolvedValue(urls);
    head.mockImplementation((url) => {
      if (url === urls[2]) return Promise.reject(new Error('offline fixture'));
      const length =
        url === urls[0] ? 'bad' : url === urls[3] ? 'Infinity' : '5120';
      return Promise.resolve({ headers: { 'content-length': length } });
    });
    await expect(service.scan(site)).resolves.toEqual({
      scanId: 42,
      total: 5,
      processed: 2,
      saved: 2,
    });
    expect(checkSmart.mock.calls).toEqual([[urls[1]], [urls[4]]]);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      urls[1],
      urls[4],
      urls[1],
      urls[4],
    ]);
    expect(progress).toHaveBeenCalledWith({ stage: 'filter', count: 2 });
    expect(progress).toHaveBeenLastCalledWith({
      stage: 'finished',
      scanId: 42,
    });
  });
});
