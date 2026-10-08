import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CrawlerService } from '../src/scan/crawler.service';
import { CronService } from '../src/scan/cron.service';
import { ModerationService } from '../src/scan/moderation/moderation.service';
import { ScanGateway } from '../src/scan/scan.gateway';
import { ScanService } from '../src/scan/scan.service';

// These module factories also isolate imports: provider overrides alone would
// still load the ESM-only p-limit dependency in this CommonJS Jest runner.
jest.mock('../src/scan/crawler.service', () => ({
  CrawlerService: class CrawlerService {},
}));
jest.mock('../src/scan/scan.service', () => ({
  ScanService: class ScanService {},
}));

describe('HTTP routes (offline integration)', () => {
  let app: INestApplication<App> | undefined;
  const scanService = {
    scan: jest.fn<
      ReturnType<ScanService['scan']>,
      Parameters<ScanService['scan']>
    >(),
    latest: jest.fn<
      ReturnType<ScanService['latest']>,
      Parameters<ScanService['latest']>
    >(),
    searchBySite: jest.fn<
      ReturnType<ScanService['searchBySite']>,
      Parameters<ScanService['searchBySite']>
    >(),
    getScan: jest.fn<
      ReturnType<ScanService['getScan']>,
      Parameters<ScanService['getScan']>
    >(),
    getProgress: jest.fn<
      ReturnType<ScanService['getProgress']>,
      Parameters<ScanService['getProgress']>
    >(),
  };
  const siteUrl = 'https://example.com/gallery';
  const scan = {
    id: 42,
    siteUrl,
    status: 'finished',
    progress: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const serializedScan = { ...scan, createdAt: scan.createdAt.toISOString() };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ScanService)
      .useValue(scanService)
      // Empty doubles deliberately have no startup hooks, scheduled work,
      // browser, database, moderation, or WebSocket behavior.
      .overrideProvider(CrawlerService)
      .useValue({})
      .overrideProvider(ModerationService)
      .useValue({})
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(CronService)
      .useValue({})
      .overrideProvider(ScanGateway)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.useLogger(false);
    // Keep the HTTP validation settings aligned with src/main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  function http() {
    if (!app) throw new Error('Test application has not initialized');
    return request(app.getHttpServer());
  }

  it('GET / returns the greeting', async () => {
    await http().get('/').expect(200).expect('Hello World!');
  });

  it('POST /scan delegates a valid URL and returns the scan summary', async () => {
    const result = { scanId: 42, total: 3, processed: 2, saved: 2 };
    scanService.scan.mockResolvedValue(result);

    await http()
      .post('/scan')
      .send({ url: siteUrl })
      .expect(201)
      .expect(result);

    expect(scanService.scan).toHaveBeenCalledTimes(1);
    expect(scanService.scan).toHaveBeenCalledWith(siteUrl);
  });

  it.each([
    ['missing URL', {}],
    ['empty URL', { url: '' }],
    ['malformed URL', { url: 'https://not a url' }],
    ['numeric URL', { url: 123 }],
    ['null URL', { url: null }],
    ['unsupported protocol', { url: 'ftp://example.com/gallery' }],
  ])('POST /scan rejects %s before scanning', async (_name, body) => {
    await http().post('/scan').send(body).expect(400);

    expect(scanService.scan).not.toHaveBeenCalled();
  });

  it('GET /scan/latest uses the default limit', async () => {
    scanService.latest.mockResolvedValue([scan]);

    await http().get('/scan/latest').expect(200).expect([serializedScan]);

    expect(scanService.latest).toHaveBeenCalledTimes(1);
    expect(scanService.latest).toHaveBeenCalledWith(500);
    expect(scanService.getProgress).not.toHaveBeenCalled();
  });

  it('GET /scan/latest passes a numeric custom limit', async () => {
    scanService.latest.mockResolvedValue([]);

    await http()
      .get('/scan/latest')
      .query({ limit: '25' })
      .expect(200)
      .expect([]);

    expect(scanService.latest).toHaveBeenCalledWith(25);
  });

  it('GET /scan searches by the exact site URL', async () => {
    const url = `${siteUrl}?page=2&tag=picture`;
    scanService.searchBySite.mockResolvedValue([{ ...scan, items: [] }]);

    await http()
      .get('/scan')
      .query({ url })
      .expect(200)
      .expect([{ ...serializedScan, items: [] }]);

    expect(scanService.searchBySite).toHaveBeenCalledTimes(1);
    expect(scanService.searchBySite).toHaveBeenCalledWith(url);
  });

  it('GET /scan rejects a missing site URL', async () => {
    await http().get('/scan').expect(400);

    expect(scanService.searchBySite).not.toHaveBeenCalled();
  });

  it('GET /scan/detail parses the ID and returns the scan', async () => {
    scanService.getScan.mockResolvedValue({ ...scan, items: [] });

    await http()
      .get('/scan/detail')
      .query({ id: '42' })
      .expect(200)
      .expect({ ...serializedScan, items: [] });

    expect(scanService.getScan).toHaveBeenCalledTimes(1);
    expect(scanService.getScan).toHaveBeenCalledWith(42);
  });

  it.each(['abc', '1.5'])('GET /scan/detail rejects ID %j', async (id) => {
    await http().get('/scan/detail').query({ id }).expect(400);

    expect(scanService.getScan).not.toHaveBeenCalled();
  });

  it('GET /scan/detail rejects a missing ID', async () => {
    await http().get('/scan/detail').expect(400);

    expect(scanService.getScan).not.toHaveBeenCalled();
  });

  it('GET /scan/:id/progress parses the ID and returns progress', async () => {
    const progress = { status: 'running', total: 10, done: 5 };
    scanService.getProgress.mockResolvedValue(progress);

    await http().get('/scan/42/progress').expect(200).expect(progress);

    expect(scanService.getProgress).toHaveBeenCalledTimes(1);
    expect(scanService.getProgress).toHaveBeenCalledWith(42);
  });

  it.each(['abc', '1.5'])(
    'GET /scan/:id/progress rejects ID %j',
    async (id) => {
      await http().get(`/scan/${id}/progress`).expect(400);

      expect(scanService.getProgress).not.toHaveBeenCalled();
    },
  );

  it('returns an HTTP error when the scan service rejects', async () => {
    scanService.scan.mockRejectedValue(new Error('Scan failed'));

    await http()
      .post('/scan')
      .send({ url: siteUrl })
      .expect(500)
      .expect({ statusCode: 500, message: 'Internal server error' });

    expect(scanService.scan).toHaveBeenCalledTimes(1);
  });
});
