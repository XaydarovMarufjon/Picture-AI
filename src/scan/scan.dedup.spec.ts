import axios, { AxiosResponse } from 'axios';
import pLimit from 'p-limit';
import { ScanService } from './scan.service';

jest.mock('axios');
jest.mock('p-limit', () => ({
  __esModule: true,
  default: jest.fn((concurrency: number) => {
    let active = 0;
    const queue: Array<() => void> = [];
    return (task: () => Promise<unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        const run = () => {
          active++;
          void task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              queue.shift()?.();
            });
        };
        if (active < concurrency) run();
        else queue.push(run);
      });
  }),
}));
jest.mock('./crawler.service', () => ({ CrawlerService: class {} }));
jest.mock('./moderation/moderation.service', () => ({
  ModerationService: class {},
}));
jest.mock('src/prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});
jest.mock('./scan.gateway', () => ({ ScanGateway: class {} }));

function deferred() {
  let resolve!: (value: AxiosResponse<Buffer>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<AxiosResponse<Buffer>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    complete: (content: string) =>
      resolve({ data: Buffer.from(content) } as AxiosResponse<Buffer>),
    fail: () => reject(new Error('download failed')),
  };
}

describe('ScanService hash deduplication', () => {
  // Axios is fully mocked; this reference cannot depend on an instance.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const get = jest.mocked(axios.get);
  let service: ScanService;

  beforeEach(() => {
    jest.clearAllMocks();
    // This helper does not use constructor collaborators or initialize the app.
    service = Object.create(ScanService.prototype) as ScanService;
  });

  it('keeps unique images in input order when downloads finish in reverse', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    get.mockReturnValueOnce(first.promise);
    get.mockReturnValueOnce(second.promise);
    get.mockReturnValueOnce(third.promise);

    const result = service['dedupWithHash'](['first', 'second', 'third']);
    third.complete('C');
    second.complete('B');
    first.complete('A');

    await expect(result).resolves.toEqual(['first', 'second', 'third']);
  });

  it('keeps the first duplicate URL even when its download finishes last', async () => {
    const first = deferred();
    const second = deferred();
    get.mockReturnValueOnce(first.promise);
    get.mockReturnValueOnce(second.promise);

    const result = service['dedupWithHash'](['first', 'second']);
    second.complete('same image');
    first.complete('same image');

    await expect(result).resolves.toEqual(['first']);
  });

  it('preserves order across interleaved duplicate groups', async () => {
    const requests = Array.from({ length: 5 }, () => deferred());
    requests.forEach((request) => get.mockReturnValueOnce(request.promise));
    const result = service['dedupWithHash'](['A1', 'B1', 'A2', 'C1', 'B2']);
    requests[4].complete('B');
    requests[3].complete('C');
    requests[2].complete('A');
    requests[1].complete('B');
    requests[0].complete('A');
    await expect(result).resolves.toEqual(['A1', 'B1', 'C1']);
  });

  it('skips failed downloads without reordering the successful ones', async () => {
    const first = deferred();
    const failed = deferred();
    const last = deferred();
    get.mockReturnValueOnce(first.promise);
    get.mockReturnValueOnce(failed.promise);
    get.mockReturnValueOnce(last.promise);
    const result = service['dedupWithHash'](['first', 'failed', 'last']);
    last.complete('last');
    failed.fail();
    first.complete('first');
    await expect(result).resolves.toEqual(['first', 'last']);
  });

  it('retains a later duplicate when the earlier download fails', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    get.mockResolvedValueOnce({ data: Buffer.from('image') });
    await expect(service['dedupWithHash'](['failed', 'ok'])).resolves.toEqual([
      'ok',
    ]);
  });

  it('returns no URLs when every download fails', async () => {
    get.mockRejectedValue(new Error('offline'));
    await expect(service['dedupWithHash'](['a', 'b'])).resolves.toEqual([]);
  });

  it('handles empty input without making requests', async () => {
    await expect(service['dedupWithHash']([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps download options and the configured concurrency limit', async () => {
    get.mockResolvedValue({ data: Buffer.from('image') });
    await expect(service['dedupWithHash'](['a', 'a'])).resolves.toEqual(['a']);
    expect(pLimit).toHaveBeenCalledWith(5);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, 'a', {
      responseType: 'arraybuffer',
      timeout: 8000,
    });
  });

  it('preserves order when queued downloads start as concurrency slots free up', async () => {
    const requests = Array.from({ length: 7 }, () => deferred());
    requests.forEach((request) => get.mockReturnValueOnce(request.promise));
    const urls = requests.map((_, index) => `image-${index}`);
    const result = service['dedupWithHash'](urls);
    expect(get).toHaveBeenCalledTimes(5);
    requests[4].complete('4');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(get).toHaveBeenCalledTimes(6);
    requests[5].complete('5');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(get).toHaveBeenCalledTimes(7);
    requests[6].complete('6');
    requests
      .slice(0, 4)
      .reverse()
      .forEach((request, index) => request.complete(String(3 - index)));
    await expect(result).resolves.toEqual(urls);
  });

  it('does not retain hashes between separate calls', async () => {
    get.mockResolvedValue({ data: Buffer.from('image') });
    await expect(service['dedupWithHash'](['first'])).resolves.toEqual([
      'first',
    ]);
    await expect(service['dedupWithHash'](['second'])).resolves.toEqual([
      'second',
    ]);
  });
});
