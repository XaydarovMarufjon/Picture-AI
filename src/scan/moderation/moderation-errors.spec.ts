import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModerationService } from './moderation.service';
import { HuggingFaceModerator } from './moderators/huggingface.moderator';
import { SightengineModerator } from './moderators/sightengine.moderator';
import { ModerationResult } from './moderators/moderator.interface';

jest.mock('./moderators/huggingface.moderator');
jest.mock('./moderators/sightengine.moderator');

const url = 'https://example.test/photo.jpg';
const safe: ModerationResult[] = [
  { provider: 'sightengine', label: 'safe', score: 0.1 },
];
const reasons: [string, unknown, string][] = [
  ['null', null, 'Unknown moderation error'],
  ['undefined', undefined, 'Unknown moderation error'],
  ['string', 'provider unavailable', 'provider unavailable'],
  ['Error', new Error('request failed'), 'request failed'],
  ['number', 42, 'Unknown moderation error'],
  ['plain object', { detail: 'failure' }, 'Unknown moderation error'],
];

function setup(both = true) {
  const config = new ConfigService();
  const settings: Record<string, string> = { HF_TOKEN: 'synthetic-token' };
  if (both) {
    settings.SIGHTENGINE_USER = 'synthetic-user';
    settings.SIGHTENGINE_SECRET = 'synthetic-secret';
  }
  jest.spyOn(config, 'get').mockImplementation((key: string) => settings[key]);
  const service = new ModerationService(config);
  const hf = jest.mocked(HuggingFaceModerator).mock.instances.at(-1)!;
  const se = both
    ? jest.mocked(SightengineModerator).mock.instances.at(-1)!
    : undefined;
  return {
    service,
    hf: jest.spyOn(hf, 'check'),
    se: se ? jest.spyOn(se, 'check').mockResolvedValue(safe) : undefined,
  };
}

describe('ModerationService unknown rejection recovery', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    for (const method of ['log', 'debug', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation(() => {});
    }
    warn = jest.spyOn(Logger.prototype, 'warn');
  });

  afterEach(() => {
    // Existing timeout cleanup is a separate draft; do not advance orphan timers.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(reasons)(
    'retries %s rejection before falling back',
    async (_name, reason, message) => {
      const { service, hf, se } = setup();
      hf.mockRejectedValue(reason);
      await expect(service.checkSmart(url)).resolves.toBe(safe);
      expect(hf.mock.calls).toEqual([[url], [url], [url]]);
      expect(se).toHaveBeenCalledTimes(1);
      expect(se).toHaveBeenCalledWith(url);
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(warn).toHaveBeenCalledWith(
          `HF failed (try ${attempt}): ${message}`,
        );
      }
    },
  );

  it.each(reasons)(
    'returns a structured error for %s without fallback',
    async (_name, reason, message) => {
      const { service, hf } = setup(false);
      hf.mockRejectedValue(reason);
      await expect(service.checkSmart(url)).resolves.toEqual([
        {
          provider: 'hf',
          label: 'error',
          score: null,
          raw: { error: message },
        },
      ]);
      expect(hf).toHaveBeenCalledTimes(3);
    },
  );

  it('recovers on a later retry after a synchronous undefined throw', async () => {
    const { service, hf, se } = setup();
    hf.mockImplementationOnce(() => {
      // Exercise JavaScript providers that throw a non-Error value.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    }).mockResolvedValue(safe);
    await expect(service.checkSmart(url)).resolves.toBe(safe);
    expect(hf).toHaveBeenCalledTimes(2);
    expect(se).not.toHaveBeenCalled();
  });

  it('isolates failures from both providers and keeps subsequent calls usable', async () => {
    const { service, hf, se } = setup();
    hf.mockRejectedValue(null);
    se!.mockRejectedValue(undefined);
    await expect(service.checkSmart(url)).resolves.toEqual([
      {
        provider: 'se',
        label: 'error',
        score: null,
        raw: { error: 'Unknown moderation error' },
      },
    ]);
    expect(hf).toHaveBeenCalledTimes(3);
    expect(se).toHaveBeenCalledTimes(3);
    hf.mockResolvedValue(safe);
    await expect(service.checkSmart(url)).resolves.toBe(safe);
    expect(hf).toHaveBeenCalledTimes(4);
  });

  it('does not inspect or stringify arbitrary rejected objects', async () => {
    const { service, hf } = setup(false);
    const getMessage = jest.fn(() => {
      throw new Error('must not inspect');
    });
    const stringify = jest.fn(() => {
      throw new Error('must not stringify');
    });
    const reason = Object.defineProperty({ toString: stringify }, 'message', {
      get: getMessage,
    });
    hf.mockRejectedValue(reason);
    await expect(service.checkSmart(url)).resolves.toEqual([
      {
        provider: 'hf',
        label: 'error',
        score: null,
        raw: { error: 'Unknown moderation error' },
      },
    ]);
    expect(getMessage).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
  });
});
