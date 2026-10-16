import { Logger } from '@nestjs/common';
import { CronService } from './cron.service';
import type { ScanService } from './scan.service';

// No scheduler, database, browser, or moderation requests are started.
jest.mock('./scan.service', () => ({ ScanService: jest.fn() }));

type ScanResult = Awaited<ReturnType<ScanService['scan']>>;
const result: ScanResult = { scanId: 1, total: 0, processed: 0, saved: 0 };
const sites = ['https://first.example', 'https://second.example'];
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferredScan() {
  let resolve!: (value: ScanResult) => void;
  const promise = new Promise<ScanResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CronService non-Error scan failures', () => {
  let scan: jest.Mocked<Pick<ScanService, 'scan'>>;
  let service: CronService;
  let errorLog: jest.SpyInstance;
  let finishLog: jest.SpyInstance;

  beforeEach(() => {
    finishLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    scan = { scan: jest.fn().mockResolvedValue(result) };
    service = new CronService(scan as unknown as ScanService);
    service['sites'] = [...sites];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'Unknown scan error'],
    ['undefined', undefined, 'Unknown scan error'],
    ['string', 'connection lost', 'connection lost'],
    ['number', 503, 'Unknown scan error'],
    ['boolean', false, 'Unknown scan error'],
    ['symbol', Symbol('failure'), 'Unknown scan error'],
    ['object', { code: 'offline' }, 'Unknown scan error'],
    ['Error', new Error('crawler unavailable'), 'crawler unavailable'],
  ])(
    'isolates a %s rejection and logs the failing site',
    async (_, reason, message) => {
      scan.scan.mockRejectedValueOnce(reason);

      await expect(service.handleScan()).resolves.toBeUndefined();

      expect(scan.scan.mock.calls).toEqual(sites.map((site) => [site]));
      expect(errorLog.mock.calls).toEqual([
        [`Error scanning ${sites[0]}: ${message}`],
      ]);
      await service.handleScan();
      expect(scan.scan).toHaveBeenCalledTimes(sites.length * 2);
    },
  );

  it.each([null, undefined])(
    'keeps the batch locked after a %s rejection until the slow site settles',
    async (reason) => {
      const slow = deferredScan();
      scan.scan.mockRejectedValueOnce(reason).mockReturnValueOnce(slow.promise);
      let settled = false;
      // Observe both outcomes immediately so a regression cannot create an
      // unhandled rejection before the assertions report the premature finish.
      const batch = service.handleScan().then(
        () => {
          settled = true;
          return { status: 'fulfilled' };
        },
        (error: unknown) => {
          settled = true;
          return { status: 'rejected', error };
        },
      );
      try {
        await nextTurn();
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(finishLog).not.toHaveBeenCalledWith('✅ Auto scan finished');

        await service.handleScan();
        await service.handleScan();
        expect(scan.scan).toHaveBeenCalledTimes(sites.length);
      } finally {
        slow.resolve(result);
        await batch;
      }

      await expect(batch).resolves.toEqual({ status: 'fulfilled' });
      expect(finishLog).toHaveBeenCalledWith('✅ Auto scan finished');
      await service.handleScan();
      expect(scan.scan.mock.calls).toEqual(
        [...sites, ...sites].map((site) => [site]),
      );
    },
  );

  it('settles multiple non-Error failures and permits the next batch', async () => {
    scan.scan.mockRejectedValueOnce(null).mockRejectedValueOnce(undefined);

    await expect(service.handleScan()).resolves.toBeUndefined();
    expect(errorLog.mock.calls).toEqual(
      sites.map((site) => [`Error scanning ${site}: Unknown scan error`]),
    );
    await service.handleScan();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length * 2);
  });
});
