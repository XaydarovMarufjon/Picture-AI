import { Logger } from '@nestjs/common';
import { CronService } from './cron.service';
import type { ScanService } from './scan.service';

// Exercise the real batch orchestration without loading browser, database,
// moderation, or ESM-only p-limit dependencies. No scheduler is started here.
jest.mock('./scan.service', () => ({ ScanService: jest.fn() }));

type ScanResult = Awaited<ReturnType<ScanService['scan']>>;

const result: ScanResult = { scanId: 1, total: 0, processed: 0, saved: 0 };
const sites = [
  'https://first.example',
  'https://second.example',
  'https://third.example',
];

function deferredScan() {
  let resolve!: (value: ScanResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ScanResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Drain promise reactions without real timers or assuming their chain depth.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('CronService batch orchestration', () => {
  let scan: jest.Mocked<Pick<ScanService, 'scan'>>;
  let service: CronService;
  let errorLog: jest.SpyInstance;
  let warningLog: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warningLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    scan = { scan: jest.fn().mockResolvedValue(result) };
    service = new CronService(scan as unknown as ScanService);
    // Use deterministic synthetic targets, leaving production configuration alone.
    service['sites'] = [...sites];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts each configured site once without waiting for earlier sites', async () => {
    const pending = sites.map(() => deferredScan());
    pending.forEach(({ promise }) => scan.scan.mockReturnValueOnce(promise));

    const batch = service.handleScan();

    expect(scan.scan.mock.calls).toEqual(sites.map((site) => [site]));

    pending.forEach(({ resolve }) => resolve(result));
    await expect(batch).resolves.toBeUndefined();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('waits for the slowest site even when results finish out of order', async () => {
    const pending = sites.map(() => deferredScan());
    pending.forEach(({ promise }) => scan.scan.mockReturnValueOnce(promise));
    let finished = false;
    const batch = service.handleScan().then(() => {
      finished = true;
    });

    pending[2].resolve(result);
    pending[0].resolve(result);
    await nextTurn();
    expect(finished).toBe(false);

    pending[1].resolve(result);
    await batch;
    expect(finished).toBe(true);
  });

  it('skips repeated overlapping runs and keeps the guard until every site settles', async () => {
    const pending = sites.map(() => deferredScan());
    pending.forEach(({ promise }) => scan.scan.mockReturnValueOnce(promise));
    const batch = service.handleScan();

    await expect(service.handleScan()).resolves.toBeUndefined();
    await expect(service.handleScan()).resolves.toBeUndefined();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length);

    pending[0].resolve(result);
    pending[1].resolve(result);
    await nextTurn();
    await service.handleScan();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length);
    expect(warningLog).toHaveBeenCalledTimes(3);

    pending[2].resolve(result);
    await batch;
    await service.handleScan();
    expect(scan.scan.mock.calls).toEqual(
      [...sites, ...sites].map((site) => [site]),
    );
  });

  it('allows later batches after a successful run', async () => {
    await service.handleScan();
    await service.handleScan();
    await service.handleScan();

    expect(scan.scan.mock.calls).toEqual(
      [...sites, ...sites, ...sites].map((site) => [site]),
    );
    expect(warningLog).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])(
    'isolates a rejection from site %i and records the failing target',
    async (failedIndex) => {
      scan.scan.mockImplementation((site) =>
        site === sites[failedIndex]
          ? Promise.reject(new Error('crawler unavailable'))
          : Promise.resolve(result),
      );

      await expect(service.handleScan()).resolves.toBeUndefined();

      expect(scan.scan.mock.calls).toEqual(sites.map((site) => [site]));
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        `Error scanning ${sites[failedIndex]}: crawler unavailable`,
      );

      scan.scan.mockResolvedValue(result);
      await service.handleScan();
      expect(scan.scan).toHaveBeenCalledTimes(sites.length * 2);
    },
  );

  it('keeps a failed-fast batch locked while another site is still scanning', async () => {
    const failed = deferredScan();
    const slow = deferredScan();
    scan.scan
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(slow.promise);
    let finished = false;
    const batch = service.handleScan().then(() => {
      finished = true;
    });

    failed.reject(new Error('network failure'));
    await nextTurn();
    expect(errorLog).toHaveBeenCalledWith(
      `Error scanning ${sites[0]}: network failure`,
    );
    expect(finished).toBe(false);
    await service.handleScan();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length);

    slow.resolve(result);
    await batch;
    expect(finished).toBe(true);
    await service.handleScan();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length * 2);
  });

  it('handles every site failing and releases the guard for the next run', async () => {
    scan.scan.mockRejectedValue(new Error('service unavailable'));

    await expect(service.handleScan()).resolves.toBeUndefined();

    expect(scan.scan.mock.calls).toEqual(sites.map((site) => [site]));
    expect(errorLog.mock.calls).toEqual(
      sites.map((site) => [`Error scanning ${site}: service unavailable`]),
    );

    scan.scan.mockResolvedValue(result);
    await service.handleScan();
    expect(scan.scan).toHaveBeenCalledTimes(sites.length * 2);
    expect(warningLog).not.toHaveBeenCalled();
  });

  it('releases the guard if a scanner unexpectedly throws synchronously', async () => {
    const failure = new Error('unexpected synchronous failure');
    scan.scan.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(service.handleScan()).rejects.toBe(failure);
    expect(scan.scan).toHaveBeenCalledTimes(1);

    await expect(service.handleScan()).resolves.toBeUndefined();
    expect(scan.scan.mock.calls).toEqual(
      [sites[0], ...sites].map((site) => [site]),
    );
    expect(warningLog).not.toHaveBeenCalled();
  });

  it('completes an empty batch and allows a subsequently configured batch', async () => {
    service['sites'] = [];

    await expect(service.handleScan()).resolves.toBeUndefined();
    expect(scan.scan).not.toHaveBeenCalled();

    service['sites'] = [...sites];
    await service.handleScan();
    expect(scan.scan.mock.calls).toEqual(sites.map((site) => [site]));
    expect(warningLog).not.toHaveBeenCalled();
  });

  it('does not share the running guard between service instances', async () => {
    const pending = deferredScan();
    scan.scan.mockReturnValueOnce(pending.promise);
    const firstBatch = service.handleScan();

    const otherScan: jest.Mocked<Pick<ScanService, 'scan'>> = {
      scan: jest.fn().mockResolvedValue(result),
    };
    const otherService = new CronService(otherScan as unknown as ScanService);
    otherService['sites'] = [sites[0]];
    await expect(otherService.handleScan()).resolves.toBeUndefined();
    expect(otherScan.scan).toHaveBeenCalledTimes(1);
    expect(otherScan.scan).toHaveBeenCalledWith(sites[0]);
    expect(warningLog).not.toHaveBeenCalled();

    pending.resolve(result);
    await firstBatch;
  });
});
