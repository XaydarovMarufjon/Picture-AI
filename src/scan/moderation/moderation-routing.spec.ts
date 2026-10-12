import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModerationService } from './moderation.service';
import { HuggingFaceModerator } from './moderators/huggingface.moderator';
import { SightengineModerator } from './moderators/sightengine.moderator';
import { ModerationResult } from './moderators/moderator.interface';

// Replace provider constructors, so configuration/routing tests cannot make
// inference requests or download images. Provider parsers are outside this suite.
jest.mock('./moderators/huggingface.moderator');
jest.mock('./moderators/sightengine.moderator');

const imageUrl = 'https://example.test/photo.jpg';
const bothProviders = {
  HF_TOKEN: 'test-hf-token',
  SIGHTENGINE_USER: 'test-se-user',
  SIGHTENGINE_SECRET: 'test-se-secret',
};
const hfConstructor = jest.mocked(HuggingFaceModerator);
const seConstructor = jest.mocked(SightengineModerator);

function createService(settings: Record<string, string | undefined> = {}) {
  const config = new ConfigService();
  // Do not read the machine's environment, even when a key is absent.
  jest.spyOn(config, 'get').mockImplementation((key: string) => settings[key]);
  return new ModerationService(config);
}

function hfCheck() {
  const instance = hfConstructor.mock.instances.at(-1);
  if (!instance) throw new Error('Hugging Face was not constructed');
  return jest.spyOn(instance, 'check');
}

function seCheck() {
  const instance = seConstructor.mock.instances.at(-1);
  if (!instance) throw new Error('Sightengine was not constructed');
  return jest.spyOn(instance, 'check');
}

function result(
  provider: string,
  label: string,
  score?: number | null,
): ModerationResult[] {
  return [{ provider, label, score, raw: { marker: `${provider}-${label}` } }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ModerationService provider configuration and routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Timer cleanup/retry behavior is covered separately. The current master
    // leaves settled-attempt timers alive, so do not advance them here.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each<Record<string, string>>([
    {},
    { HF_TOKEN: '' },
    { HF_MODEL: 'example/custom-model' },
    { SIGHTENGINE_USER: 'test-se-user' },
    { SIGHTENGINE_SECRET: 'test-se-secret' },
    { SIGHTENGINE_USER: 'test-se-user', SIGHTENGINE_SECRET: '' },
    { SIGHTENGINE_USER: '', SIGHTENGINE_SECRET: 'test-se-secret' },
  ])('rejects configuration without a usable provider: %j', (settings) => {
    expect(() => createService(settings)).toThrow(
      'Hech qanday moderation provider sozlanmagan!',
    );
    expect(hfConstructor).not.toHaveBeenCalled();
    expect(seConstructor).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'Falconsai/nsfw_image_detection'],
    ['', 'Falconsai/nsfw_image_detection'],
    ['example/custom-model', 'example/custom-model'],
  ])(
    'passes the configured HF model %j and token to its provider',
    (model, expected) => {
      createService({
        HF_TOKEN: bothProviders.HF_TOKEN,
        ...(model === undefined ? {} : { HF_MODEL: model }),
      });

      expect(hfConstructor).toHaveBeenCalledTimes(1);
      expect(hfConstructor).toHaveBeenCalledWith(
        bothProviders.HF_TOKEN,
        expected,
      );
      expect(seConstructor).not.toHaveBeenCalled();
    },
  );

  it('constructs only Sightengine when both of its credentials are present', async () => {
    const service = createService({
      SIGHTENGINE_USER: bothProviders.SIGHTENGINE_USER,
      SIGHTENGINE_SECRET: bothProviders.SIGHTENGINE_SECRET,
    });
    const checks = result('sightengine', 'safe', 0.1);
    seCheck().mockResolvedValue(checks);

    await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

    expect(hfConstructor).not.toHaveBeenCalled();
    expect(seConstructor).toHaveBeenCalledTimes(1);
    expect(seConstructor).toHaveBeenCalledWith(
      bothProviders.SIGHTENGINE_USER,
      bothProviders.SIGHTENGINE_SECRET,
    );
    expect(seCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledWith(imageUrl);
  });

  it.each([
    { SIGHTENGINE_USER: 'test-se-user' },
    { SIGHTENGINE_SECRET: 'test-se-secret' },
  ])(
    'keeps HF usable with incomplete Sightengine configuration: %j',
    async (partial) => {
      const service = createService({
        HF_TOKEN: bothProviders.HF_TOKEN,
        ...partial,
      });
      const checks = result('huggingface', 'safe', 0.9);
      hfCheck().mockResolvedValue(checks);

      await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

      expect(hfCheck()).toHaveBeenCalledTimes(1);
      expect(hfCheck()).toHaveBeenCalledWith(imageUrl);
      expect(seConstructor).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 0, 0.199999, 0.2])(
    'retains an HF safe result at score %j without a second provider request',
    async (score) => {
      const service = createService(bothProviders);
      const checks = result('huggingface', 'safe', score);
      hfCheck().mockResolvedValue(checks);

      await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

      expect(hfCheck()).toHaveBeenCalledTimes(1);
      expect(hfCheck()).toHaveBeenCalledWith(imageUrl);
      expect(seCheck()).not.toHaveBeenCalled();
    },
  );

  it('uses the complete Sightengine result immediately above the fallback boundary', async () => {
    const service = createService(bothProviders);
    const checks = [
      ...result('sightengine', 'nsfw', 0.8),
      ...result('sightengine', 'safe', 0.1),
    ];
    hfCheck().mockResolvedValue(result('huggingface', 'safe', 0.200001));
    seCheck().mockResolvedValue(checks);

    await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

    expect(hfCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledWith(imageUrl);
  });

  it.each([
    { name: 'empty', checks: [] as ModerationResult[] },
    { name: 'error', checks: result('huggingface', 'error', null) },
  ])(
    'preserves an $name HF result when no fallback provider exists',
    async ({ checks }) => {
      const service = createService({ HF_TOKEN: bothProviders.HF_TOKEN });
      hfCheck().mockResolvedValue(checks);

      await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

      expect(hfCheck()).toHaveBeenCalledTimes(1);
      expect(seConstructor).not.toHaveBeenCalled();
    },
  );

  it('falls back on an empty HF result and preserves a returned fallback error', async () => {
    const service = createService(bothProviders);
    const checks = result('sightengine', 'error', null);
    hfCheck().mockResolvedValue([]);
    seCheck().mockResolvedValue(checks);

    await expect(service.checkSmart(imageUrl)).resolves.toBe(checks);

    expect(hfCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledWith(imageUrl);
  });

  it('keeps concurrent images and fallback results separate when HF finishes out of order', async () => {
    const service = createService(bothProviders);
    const firstUrl = `${imageUrl}?id=first`;
    const secondUrl = `${imageUrl}?id=second`;
    const first = deferred<ModerationResult[]>();
    const second = deferred<ModerationResult[]>();
    const safe = result('huggingface', 'safe', 0.2);
    const fallback = result('sightengine', 'nsfw', 0.8);
    hfCheck().mockImplementation((url) => {
      if (url === firstUrl) return first.promise;
      if (url === secondUrl) return second.promise;
      throw new Error(`Unexpected image: ${url}`);
    });
    seCheck().mockResolvedValue(fallback);

    const firstCheck = service.checkSmart(firstUrl);
    const secondCheck = service.checkSmart(secondUrl);
    second.resolve(result('huggingface', 'safe', 0.9));
    await expect(secondCheck).resolves.toBe(fallback);

    expect(seCheck()).toHaveBeenCalledTimes(1);
    expect(seCheck()).toHaveBeenCalledWith(secondUrl);

    first.resolve(safe);
    await expect(firstCheck).resolves.toBe(safe);

    expect(hfCheck().mock.calls).toEqual([[firstUrl], [secondUrl]]);
    expect(seCheck()).toHaveBeenCalledTimes(1);
  });
});
