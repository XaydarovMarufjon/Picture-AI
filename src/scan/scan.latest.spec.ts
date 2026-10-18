import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ScanController } from './scan.controller';
import { ScanService } from './scan.service';

// Keep the real HTTP controller, without importing ESM p-limit or starting
// scanners, scheduled jobs, database connections, or external provider calls.
jest.mock('./scan.service', () => ({ ScanService: class ScanService {} }));

describe('latest scan limit validation (offline HTTP)', () => {
  let app: INestApplication<App>;
  const latest = jest.fn<
    ReturnType<ScanService['latest']>,
    Parameters<ScanService['latest']>
  >();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ScanController],
      providers: [{ provide: ScanService, useValue: { latest } }],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  beforeEach(() => {
    latest.mockReset().mockResolvedValue([]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['', 500],
    ['?limit=', 500],
    ['?limit=25', 25],
    ['?limit=0', 0],
    ['?limit=-25', -25],
    ['?limit=0025', 25],
    ['?limit=%2B25', 25],
    ['?limit=%20', 0],
    ['?limit=25%20', 25],
    ['?limit=1e2', 100],
    ['?limit=0x10', 16],
    ['?limit=9007199254740991', Number.MAX_SAFE_INTEGER],
    ['?limit=-9007199254740991', Number.MIN_SAFE_INTEGER],
  ])('preserves valid pagination %s', async (query, expected) => {
    await request(app.getHttpServer())
      .get(`/scan/latest${query}`)
      .expect(200)
      .expect([]);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(expected);
  });

  it.each([
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1.5',
    '-1.5',
    '9007199254740992',
    '-9007199254740992',
    '9'.repeat(400),
  ])('rejects invalid limit %j before querying the service', async (limit) => {
    await request(app.getHttpServer())
      .get('/scan/latest')
      .query({ limit })
      .expect(400)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toBe('limit must be a safe integer');
      });
    expect(latest).not.toHaveBeenCalled();
  });

  it.each(['limit=1&limit=2', 'limit=&limit=', 'limit=25&limit=25'])(
    'rejects repeated parameters %s before querying the service',
    async (query) => {
      await request(app.getHttpServer())
        .get(`/scan/latest?${query}`)
        .expect(400);
      expect(latest).not.toHaveBeenCalled();
    },
  );
});
