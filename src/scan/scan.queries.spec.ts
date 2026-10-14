import type { Prisma, Scan } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { CrawlerService } from './crawler.service';
import type { ModerationService } from './moderation/moderation.service';
import type { ScanGateway } from './scan.gateway';
import { ScanService } from './scan.service';

jest.mock('./crawler.service', () => ({ CrawlerService: jest.fn() }));
jest.mock('./moderation/moderation.service', () => ({
  ModerationService: jest.fn(),
}));
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: jest.fn() }), {
  virtual: true,
});
// Read helpers never schedule work. Keep ESM-only p-limit out of CommonJS Jest
// and fail if a query unexpectedly enters the scan pipeline.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => {
    throw new Error('Read queries must not schedule scan work');
  },
}));

type ScanWithItems = Prisma.ScanGetPayload<{ include: { items: true } }>;

const row: Scan = {
  id: 42,
  siteUrl: 'https://site.test/articles?category=news',
  status: 'running',
  progress: 7,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
const item: ScanWithItems['items'][number] = {
  id: 11,
  scanId: row.id,
  imageUrl: 'https://cdn.test/photo.jpg',
  hash: 'test-hash',
  provider: 'huggingface',
  label: 'safe',
  score: 0,
  raw: { normal: 1 },
  createdAt: row.createdAt,
};

// These tests verify service-to-Prisma requests and returned values, not actual
// SQL ordering, persistence, controller validation, or scan progress accuracy.
describe('ScanService read queries (offline)', () => {
  let findMany: jest.Mock<Promise<ScanWithItems[]>, [Prisma.ScanFindManyArgs]>;
  let findUnique: jest.Mock<
    Promise<ScanWithItems | null>,
    [Prisma.ScanFindUniqueArgs]
  >;
  let service: ScanService;

  beforeEach(() => {
    findMany = jest.fn<Promise<ScanWithItems[]>, [Prisma.ScanFindManyArgs]>();
    findUnique = jest.fn<
      Promise<ScanWithItems | null>,
      [Prisma.ScanFindUniqueArgs]
    >();
    service = new ScanService(
      {} as CrawlerService,
      {} as ModerationService,
      { scan: { findMany, findUnique } } as unknown as PrismaService,
      {} as ScanGateway,
    );
  });

  it.each([undefined, 1, 25, 0])(
    'forwards latest limit %s with descending creation order',
    async (limit) => {
      const rows = [{ ...row, items: [] }];
      findMany.mockResolvedValue(rows);
      await expect(service.latest(limit)).resolves.toBe(rows);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        take: limit === undefined ? 100 : limit,
      });
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('returns an empty latest result without inventing rows', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.latest()).resolves.toEqual([]);
  });

  it('searches by the exact site URL and requests newest scans with items', async () => {
    const siteUrl = 'https://site.test/Path/?x=1&x=2#section';
    const rows = [{ ...row, siteUrl, items: [item] }];
    findMany.mockResolvedValue(rows);
    await expect(service.searchBySite(siteUrl)).resolves.toBe(rows);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { siteUrl },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns an empty site search unchanged', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.searchBySite(row.siteUrl)).resolves.toEqual([]);
  });

  it('returns full scan details and items without remapping them', async () => {
    const detail = { ...row, items: [item] };
    findUnique.mockResolvedValue(detail);
    await expect(service.getScan(42)).resolves.toBe(detail);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      include: { items: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(['getScan', 'getProgress'] as const)(
    '%s returns null for a missing scan',
    async (method) => {
      findUnique.mockResolvedValue(null);
      await expect(service[method](404)).resolves.toBeNull();
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 404 },
        include: { items: true },
      });
    },
  );

  it.each([
    { status: 'running', progress: 7, items: [item], done: 1 },
    { status: 'finished', progress: 0, items: [], done: 0 },
    {
      status: 'error',
      progress: null,
      items: [item, { ...item, id: 12 }],
      done: 2,
    },
  ])('maps $status progress without coercion or a percentage', async (data) => {
    const detail = {
      ...row,
      status: data.status,
      progress: data.progress,
      items: data.items,
    };
    findUnique.mockResolvedValue(detail);
    await expect(service.getProgress(42)).resolves.toEqual({
      status: data.status,
      total: data.progress,
      done: data.done,
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      include: { items: true },
    });
    expect(detail.items).toEqual(data.items);
  });

  it.each(['latest', 'searchBySite', 'getScan', 'getProgress'] as const)(
    '%s propagates database failures unchanged',
    async (method) => {
      const error = new Error('Database unavailable');
      findMany.mockRejectedValue(error);
      findUnique.mockRejectedValue(error);
      const result =
        method === 'searchBySite'
          ? service.searchBySite(row.siteUrl)
          : service[method](42);
      await expect(result).rejects.toBe(error);
      expect(findMany.mock.calls.length + findUnique.mock.calls.length).toBe(1);
    },
  );
});
