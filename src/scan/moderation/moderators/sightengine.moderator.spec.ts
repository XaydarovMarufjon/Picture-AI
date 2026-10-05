import axios from 'axios';
import { SightengineModerator } from './sightengine.moderator';

jest.mock('axios');

describe('SightengineModerator', () => {
  const imageUrl = 'https://example.com/image.jpg';
  const get = jest.spyOn(axios, 'get');
  let moderator: SightengineModerator;

  beforeEach(() => {
    jest.resetAllMocks();
    moderator = new SightengineModerator('test-user', 'test-secret');
  });

  describe.each(['raw', 'sexual_activity'])('%s score', (field) => {
    it.each([
      [0, 'safe'],
      [0.2, 'safe'],
      [0.5, 'safe'],
      [0.500001, 'nsfw'],
      [1, 'nsfw'],
    ])('classifies %s as %s', async (score, label) => {
      const data = { status: 'success', nudity: { [field]: score } };
      get.mockResolvedValueOnce({ data });

      const results = await moderator.check(imageUrl);

      expect(results).toEqual([
        { provider: 'sightengine', label, score, raw: data },
      ]);
      expect(results[0].raw).toBe(data);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['numeric string', '0.2'],
      ['empty string', ''],
      ['boolean', false],
      ['array', [0.2]],
      ['object', { score: 0.2 }],
      ['NaN', NaN],
      ['positive infinity', Infinity],
      ['negative infinity', -Infinity],
      ['negative score', -0.1],
      ['score above one', 1.1],
    ])('returns an error for %s', async (_name, score) => {
      get.mockResolvedValueOnce({
        data: { status: 'success', nudity: { [field]: score } },
      });

      await expect(moderator.check(imageUrl)).resolves.toEqual([
        {
          provider: 'sightengine',
          label: 'error',
          score: null,
          raw: { error: expect.any(String) as unknown },
        },
      ]);
      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'upstream unavailable'],
    ['number', 200],
    ['boolean', false],
    ['array', [{ status: 'success', nudity: { raw: 0.1 } }]],
    ['empty object', {}],
    ['missing status', { nudity: { raw: 0.1 } }],
    ['failure status', { status: 'failure', nudity: { raw: 0.1 } }],
    ['pending status', { status: 'pending', nudity: { raw: 0.1 } }],
    ['missing nudity', { status: 'success' }],
    ['null nudity', { status: 'success', nudity: null }],
    ['empty nudity', { status: 'success', nudity: {} }],
    ['string nudity', { status: 'success', nudity: 'safe' }],
    ['array nudity', { status: 'success', nudity: [{ raw: 0.1 }] }],
  ])('returns an error for a response with %s', async (_name, data) => {
    get.mockResolvedValueOnce({ data });

    await expect(moderator.check(imageUrl)).resolves.toEqual([
      {
        provider: 'sightengine',
        label: 'error',
        score: null,
        raw: { error: expect.any(String) as unknown },
      },
    ]);
  });

  it('keeps raw score precedence, including zero', async () => {
    get.mockResolvedValueOnce({
      data: { status: 'success', nudity: { raw: 0, sexual_activity: 0.9 } },
    });

    await expect(moderator.check(imageUrl)).resolves.toEqual([
      expect.objectContaining({ label: 'safe', score: 0 }),
    ]);
  });

  it('uses sexual_activity when raw is null', async () => {
    get.mockResolvedValueOnce({
      data: { status: 'success', nudity: { raw: null, sexual_activity: 0.9 } },
    });

    await expect(moderator.check(imageUrl)).resolves.toEqual([
      expect.objectContaining({ label: 'nsfw', score: 0.9 }),
    ]);
  });

  it('rejects invalid raw rather than hiding it behind a valid fallback', async () => {
    get.mockResolvedValueOnce({
      data: { status: 'success', nudity: { raw: '0', sexual_activity: 0.1 } },
    });

    await expect(moderator.check(imageUrl)).resolves.toEqual([
      expect.objectContaining({ label: 'error', score: null }),
    ]);
  });

  it('preserves the request endpoint, model selection, credentials and timeout', async () => {
    get.mockResolvedValueOnce({
      data: { status: 'success', nudity: { raw: 0.1 } },
    });

    await moderator.check(imageUrl);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      'https://api.sightengine.com/1.0/check.json',
      {
        params: {
          url: imageUrl,
          models: 'nudity,wad,gore',
          api_user: 'test-user',
          api_secret: 'test-secret',
        },
        timeout: 10000,
      },
    );
  });

  it('preserves the public error result on transport failure', async () => {
    get.mockRejectedValueOnce(new Error('request timed out'));

    await expect(moderator.check(imageUrl)).resolves.toEqual([
      {
        provider: 'sightengine',
        label: 'error',
        score: null,
        raw: { error: 'request timed out' },
      },
    ]);
  });

  it.each([null, undefined, 'request failed'])(
    'returns an error for a non-Error rejection (%s)',
    async (reason) => {
      get.mockRejectedValueOnce(reason);

      await expect(moderator.check(imageUrl)).resolves.toEqual([
        {
          provider: 'sightengine',
          label: 'error',
          score: null,
          raw: { error: 'Sightengine request failed' },
        },
      ]);
    },
  );
});
