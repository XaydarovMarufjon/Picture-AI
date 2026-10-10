import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import axios from 'axios';
import { createHash } from 'crypto';
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
// Execute every job without loading ESM-only p-limit. These tests cover the
// scan pipeline, not the dependency's queue or concurrency guarantees.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (job: () => Promise<unknown>) => job(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const siteUrl = 'https://site.test/articles';
const imageUrl = 'https://cdn.test/photo.jpg';
const secondImage = 'https://cdn.test/second.jpg';
const safeRaw = { normal: 0.9 };
const safe: ModerationResult = {
  provider: 'huggingface',
  label: 'safe',
  score: 0.1,
  raw: safeRaw,
};
const hashOf = (url: string) => createHash('md5').update(url).digest('hex');

describe('ScanService scan pipeline (offline)', () => {
  let head: jest.SpiedFunction<typeof axios.head>;
  let get: jest.SpiedFunction<typeof axios.get>;
  let crawl: jest.Mock<Promise<string[]>, [string]>;
  let checkSmart: jest.Mock<Promise<ModerationResult[]>, [string]>;
  let create: jest.Mock<Promise<{ id: number }>, [Prisma.ScanCreateArgs]>;
  let update: jest.Mock<Promise<void>, [Prisma.ScanUpdateArgs]>;
  let upsert: jest.Mock<Promise<void>, [Prisma.ScanItemUpsertArgs]>;
  let sendProgress: jest.Mock<void, [unknown]>;
  let service: ScanService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    crawl = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValue([imageUrl]);
    checkSmart = jest
      .fn<Promise<ModerationResult[]>, [string]>()
      .mockResolvedValue([safe]);
    create = jest
      .fn<Promise<{ id: number }>, [Prisma.ScanCreateArgs]>()
      .mockResolvedValue({ id: 42 });
    update = jest
      .fn<Promise<void>, [Prisma.ScanUpdateArgs]>()
      .mockResolvedValue(undefined);
    upsert = jest
      .fn<Promise<void>, [Prisma.ScanItemUpsertArgs]>()
      .mockResolvedValue(undefined);
    sendProgress = jest.fn<void, [unknown]>();
    head = jest.spyOn(axios, 'head');
    get = jest.spyOn(axios, 'get');
    head.mockResolvedValue({ headers: { 'content-length': '8192' } });
    get.mockImplementation((url) =>
      Promise.resolve({ data: Buffer.from(url) }),
    );
    service = new ScanService(
      { extractImageUrls: crawl } as unknown as CrawlerService,
      { checkSmart } as unknown as ModerationService,
      {
        scan: { create, update },
        scanItem: { upsert },
      } as unknown as PrismaService,
      { sendProgress } as unknown as ScanGateway,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('carries the selected image and provider result through persistence and completion', async () => {
    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 1,
      processed: 1,
      saved: 1,
    });

    expect(crawl).toHaveBeenCalledTimes(1);

    expect(crawl).toHaveBeenCalledWith(siteUrl);
    expect(head).toHaveBeenCalledTimes(1);
    expect(head).toHaveBeenCalledWith(imageUrl, { timeout: 5000 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, imageUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });
    expect(get).toHaveBeenNthCalledWith(2, imageUrl, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { siteUrl, status: 'running', progress: 1 },
    });
    expect(checkSmart).toHaveBeenCalledTimes(1);
    expect(checkSmart).toHaveBeenCalledWith(imageUrl);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      where: { hash: hashOf(imageUrl) },
      update: {
        createdAt: expect.any(Date) as unknown,
        label: 'safe',
        score: 0.1,
        raw: safeRaw,
      },
      create: {
        scanId: 42,
        imageUrl,
        hash: hashOf(imageUrl),
        provider: 'huggingface',
        label: 'safe',
        score: 0.1,
        raw: safeRaw,
        createdAt: expect.any(Date) as unknown,
      },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: 'finished' },
    });
    expect(sendProgress.mock.calls).toEqual([
      [{ stage: 'start', url: siteUrl }],
      [{ stage: 'crawl', count: 1 }],
      [{ stage: 'filter', count: 1 }],
      [{ stage: 'dedup', count: 1 }],
      [{ stage: 'finished', scanId: 42 }],
    ]);
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      checkSmart.mock.invocationCallOrder[0],
    );
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });

  it('completes an empty crawl without downloading, moderating, or saving images', async () => {
    crawl.mockResolvedValue([]);

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 0,
      processed: 0,
      saved: 0,
    });

    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(checkSmart).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { siteUrl, status: 'running', progress: 0 },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(sendProgress).toHaveBeenLastCalledWith({
      stage: 'finished',
      scanId: 42,
    });
  });

  it('filters decorative, non-HTTP, undersized, and unavailable images before downloading', async () => {
    const small = 'https://cdn.test/small.jpg';
    const unavailable = 'https://cdn.test/unavailable.jpg';
    crawl.mockResolvedValue([
      'data:image/png;base64,AA==',
      'https://cdn.test/logo.jpg',
      'https://cdn.test/icon.jpg',
      'https://cdn.test/avatar.jpg',
      'https://cdn.test/sprite.jpg',
      'https://cdn.test/drawing.svg',
      small,
      unavailable,
      imageUrl,
    ]);
    head.mockImplementation((url) => {
      if (url === unavailable) return Promise.reject(new Error('HEAD failed'));
      return Promise.resolve({
        headers: { 'content-length': url === small ? '5119' : '5120' },
      });
    });

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 9,
      processed: 1,
      saved: 1,
    });

    expect(head.mock.calls.map(([url]) => url)).toEqual([
      small,
      unavailable,
      imageUrl,
    ]);
    expect(get.mock.calls.map(([url]) => url)).toEqual([imageUrl, imageUrl]);
    expect(checkSmart).toHaveBeenCalledTimes(1);
    expect(checkSmart).toHaveBeenCalledWith(imageUrl);
    expect(sendProgress).toHaveBeenCalledWith({ stage: 'filter', count: 1 });
  });

  it('moderates each content hash once and skips failed hash downloads', async () => {
    const failedImage = 'https://cdn.test/failed.jpg';
    crawl.mockResolvedValue([imageUrl, secondImage, failedImage]);
    get.mockImplementation((url) =>
      url === failedImage
        ? Promise.reject(new Error('download failed'))
        : Promise.resolve({ data: Buffer.from('same pixels') }),
    );

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 3,
      processed: 1,
      saved: 1,
    });

    expect(checkSmart).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(sendProgress).toHaveBeenCalledWith({ stage: 'dedup', count: 1 });
  });

  it('ranks all candidates before limiting moderation and persistence to 200 images', async () => {
    const ordinary = Array.from(
      { length: 200 },
      (_, index) => `https://cdn.test/photo-${index}.jpg`,
    );
    const banner = 'https://cdn.test/banner.jpg';
    const news = 'https://cdn.test/news.jpg';
    const product = 'https://cdn.test/product.jpg';
    crawl.mockResolvedValue([...ordinary, banner, news, product]);

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 203,
      processed: 200,
      saved: 200,
    });

    expect(checkSmart.mock.calls.map(([url]) => url)).toEqual([
      product,
      news,
      banner,
      ...ordinary.slice(0, 197),
    ]);
    expect(upsert).toHaveBeenCalledTimes(200);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { siteUrl, status: 'running', progress: 200 },
    });
    expect(sendProgress).toHaveBeenCalledWith({ stage: 'dedup', count: 203 });
  });

  it('isolates a rejected image moderation result while saving a successful image', async () => {
    crawl.mockResolvedValue([imageUrl, secondImage]);
    checkSmart.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 2,
      processed: 2,
      saved: 1,
    });

    expect(checkSmart).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.imageUrl).toBe(secondImage);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('flattens multiple provider results and supplies nullable persistence defaults', async () => {
    checkSmart.mockResolvedValue([
      safe,
      { provider: 'sightengine', label: 'error' },
    ]);

    await expect(service.scan(siteUrl)).resolves.toEqual({
      scanId: 42,
      total: 1,
      processed: 1,
      saved: 2,
    });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map(([args]) => args.create.provider)).toEqual([
      'huggingface',
      'sightengine',
    ]);
    expect(upsert.mock.calls[1][0]).toMatchObject({
      create: { imageUrl, scanId: 42, label: 'error', score: null, raw: {} },
      update: { label: 'error', score: null, raw: {} },
    });
  });

  it('reports moderation progress on each fifth completed image', async () => {
    crawl.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => `${imageUrl}?id=${index}`),
    );

    await service.scan(siteUrl);

    expect(sendProgress.mock.calls).toEqual([
      [{ stage: 'start', url: siteUrl }],
      [{ stage: 'crawl', count: 11 }],
      [{ stage: 'filter', count: 11 }],
      [{ stage: 'dedup', count: 11 }],
      [{ stage: 'moderation', done: 5, total: 11, progress: 45 }],
      [{ stage: 'moderation', done: 10, total: 11, progress: 91 }],
      [{ stage: 'finished', scanId: 42 }],
    ]);
  });

  it('waits for persistence to resolve before marking the scan finished', async () => {
    const saving = deferred<void>();
    const saveStarted = deferred<void>();
    upsert.mockImplementation(() => {
      saveStarted.resolve();
      return saving.promise;
    });
    const scan = service.scan(siteUrl);
    await saveStarted.promise;

    expect(update).not.toHaveBeenCalled();
    expect(sendProgress).not.toHaveBeenCalledWith({
      stage: 'finished',
      scanId: 42,
    });
    saving.resolve();
    await scan;

    expect(update).toHaveBeenCalledTimes(1);
    expect(sendProgress).toHaveBeenLastCalledWith({
      stage: 'finished',
      scanId: 42,
    });
  });

  it('waits for the final database update before announcing completion', async () => {
    const finishing = deferred<void>();
    const updateStarted = deferred<void>();
    update.mockImplementation(() => {
      updateStarted.resolve();
      return finishing.promise;
    });
    const scan = service.scan(siteUrl);
    await updateStarted.promise;

    expect(sendProgress).not.toHaveBeenCalledWith({
      stage: 'finished',
      scanId: 42,
    });
    finishing.resolve();
    await scan;

    expect(sendProgress).toHaveBeenLastCalledWith({
      stage: 'finished',
      scanId: 42,
    });
  });

  it('propagates crawl failure without creating a scan or starting moderation', async () => {
    const error = new Error('crawl failed');
    crawl.mockRejectedValue(error);

    await expect(service.scan(siteUrl)).rejects.toBe(error);

    expect(create).not.toHaveBeenCalled();
    expect(checkSmart).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(sendProgress.mock.calls).toEqual([
      [{ stage: 'start', url: siteUrl }],
    ]);
  });

  it('propagates scan creation failure without moderating or saving images', async () => {
    const error = new Error('create failed');
    create.mockRejectedValue(error);

    await expect(service.scan(siteUrl)).rejects.toBe(error);

    expect(checkSmart).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(sendProgress).toHaveBeenLastCalledWith({ stage: 'dedup', count: 1 });
  });

  it('does not report completion when image persistence rejects', async () => {
    const error = new Error('save failed');
    upsert.mockRejectedValue(error);

    await expect(service.scan(siteUrl)).rejects.toBe(error);

    expect(update).not.toHaveBeenCalled();
    expect(sendProgress).toHaveBeenLastCalledWith({ stage: 'dedup', count: 1 });
  });

  it('does not report completion when the final database update rejects', async () => {
    const error = new Error('finish failed');
    update.mockRejectedValue(error);

    await expect(service.scan(siteUrl)).rejects.toBe(error);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(sendProgress).toHaveBeenLastCalledWith({ stage: 'dedup', count: 1 });
  });
});
