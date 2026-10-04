import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModerationService } from './moderation.service';
import { HuggingFaceModerator } from './moderators/huggingface.moderator';
import { SightengineModerator } from './moderators/sightengine.moderator';
import { ModerationResult } from './moderators/moderator.interface';

const imageUrl = 'https://example.com/image.jpg';
const hfResult: ModerationResult[] = [
  { provider: 'huggingface', label: 'nsfw', score: 0.9 },
];
const seResult: ModerationResult[] = [
  { provider: 'sightengine', label: 'safe', score: 0.1 },
];
const hfError: ModerationResult[] = [
  { provider: 'huggingface', label: 'error', score: null },
];

// Provider promises are mocked: these tests never download images or call an API.
function pendingCheck(): Promise<ModerationResult[]> {
  return new Promise(() => {});
}

describe('ModerationService timeout cleanup', () => {
  let service: ModerationService;
  let hfCheck: jest.SpiedFunction<HuggingFaceModerator['check']>;
  let seCheck: jest.SpiedFunction<SightengineModerator['check']>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    hfCheck = jest
      .spyOn(HuggingFaceModerator.prototype, 'check')
      .mockResolvedValue(hfResult);
    seCheck = jest
      .spyOn(SightengineModerator.prototype, 'check')
      .mockResolvedValue(seResult);
    service = new ModerationService(
      new ConfigService({
        HF_TOKEN: 'test-token',
        SIGHTENGINE_USER: 'test-user',
        SIGHTENGINE_SECRET: 'test-secret',
      }),
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('clears the timeout when the first provider succeeds', async () => {
    await expect(service.checkSmart(imageUrl)).resolves.toBe(hfResult);

    expect(hfCheck).toHaveBeenCalledWith(imageUrl);
    expect(hfCheck).toHaveBeenCalledTimes(1);
    expect(seCheck).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears timeouts for both providers when an error result triggers fallback', async () => {
    hfCheck.mockResolvedValue(hfError);

    await expect(service.checkSmart(imageUrl)).resolves.toBe(seResult);

    expect(hfCheck).toHaveBeenCalledTimes(1);
    expect(seCheck).toHaveBeenCalledWith(imageUrl);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears timeouts when a safe result triggers a second provider check', async () => {
    hfCheck.mockResolvedValue([
      { provider: 'huggingface', label: 'safe', score: 0.9 },
    ]);

    await expect(service.checkSmart(imageUrl)).resolves.toBe(seResult);

    expect(seCheck).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the rejected attempt timeout before a successful retry', async () => {
    hfCheck.mockRejectedValueOnce(new Error('temporary failure'));

    await expect(service.checkSmart(imageUrl)).resolves.toBe(hfResult);

    expect(hfCheck).toHaveBeenCalledTimes(2);
    expect(seCheck).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves retries after a synchronous provider failure', async () => {
    hfCheck.mockImplementationOnce(() => {
      throw new Error('synchronous failure');
    });

    await expect(service.checkSmart(imageUrl)).resolves.toBe(hfResult);

    expect(hfCheck).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps only the current timeout active while retrying', async () => {
    let resolveRetry!: (value: ModerationResult[]) => void;
    hfCheck.mockRejectedValueOnce(new Error('temporary failure'));
    hfCheck.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRetry = resolve)),
    );

    const result = service.checkSmart(imageUrl);
    await jest.advanceTimersByTimeAsync(0);

    expect(hfCheck).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    resolveRetry(hfResult);
    await expect(result).resolves.toBe(hfResult);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears all rejected attempt timers before returning a fallback result', async () => {
    hfCheck.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.checkSmart(imageUrl)).resolves.toBe(seResult);

    expect(hfCheck).toHaveBeenCalledTimes(3);
    expect(seCheck).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears timers when both providers exhaust their retries', async () => {
    hfCheck.mockRejectedValue(new Error('HF unavailable'));
    seCheck.mockRejectedValue(new Error('SE unavailable'));

    await expect(service.checkSmart(imageUrl)).resolves.toEqual([
      {
        provider: 'se',
        label: 'error',
        score: null,
        raw: { error: 'SE unavailable' },
      },
    ]);

    expect(hfCheck).toHaveBeenCalledTimes(3);
    expect(seCheck).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains the 15-second timeout and two retries for a hanging provider', async () => {
    hfCheck.mockImplementation(pendingCheck);

    const result = service.checkSmart(imageUrl);
    await jest.advanceTimersByTimeAsync(14999);
    expect(hfCheck).toHaveBeenCalledTimes(1);
    expect(seCheck).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(hfCheck).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(15000);
    expect(hfCheck).toHaveBeenCalledTimes(3);
    expect(seCheck).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(15000);
    await expect(result).resolves.toBe(seResult);
    expect(hfCheck).toHaveBeenCalledTimes(3);
    expect(seCheck).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears a successful retry timeout after an earlier attempt timed out', async () => {
    hfCheck.mockImplementationOnce(pendingCheck);

    const result = service.checkSmart(imageUrl);
    await jest.advanceTimersByTimeAsync(15000);

    await expect(result).resolves.toBe(hfResult);
    expect(hfCheck).toHaveBeenCalledTimes(2);
    expect(seCheck).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not let a late result from a timed-out attempt replace the retry result', async () => {
    let resolveFirst!: (value: ModerationResult[]) => void;
    hfCheck.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );

    const result = service.checkSmart(imageUrl);
    await jest.advanceTimersByTimeAsync(15000);
    await expect(result).resolves.toBe(hfResult);

    resolveFirst(hfError);
    await jest.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(hfResult);
    expect(seCheck).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not accumulate timers across concurrent completed image checks', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.checkSmart(`https://example.com/image-${i}.jpg`),
      ),
    );

    expect(results).toEqual(Array.from({ length: 20 }, () => hfResult));
    expect(hfCheck).toHaveBeenCalledTimes(20);
    expect(jest.getTimerCount()).toBe(0);
  });
});
