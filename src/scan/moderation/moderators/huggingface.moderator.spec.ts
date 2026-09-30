import axios from 'axios';
import { HuggingFaceModerator } from './huggingface.moderator';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

describe('HuggingFaceModerator', () => {
  let moderator: HuggingFaceModerator;
  const imageUrl = 'https://example.com/image.jpg';

  beforeEach(() => {
    jest.resetAllMocks();
    moderator = new HuggingFaceModerator('test-token');
    mockedAxios.get.mockResolvedValue({
      data: Buffer.from('image'),
      headers: { 'content-type': 'image/png' },
    });
  });

  it.each([
    [
      'flat',
      [
        { label: 'normal', score: 0.9 },
        { label: 'nsfw', score: 0.1 },
      ],
    ],
    [
      'nested',
      [
        [
          { label: 'normal', score: 0.9 },
          { label: 'nsfw', score: 0.1 },
        ],
      ],
    ],
  ])('accepts valid %s predictions', async (_name, data) => {
    mockedAxios.post.mockResolvedValue({ data });
    await expect(moderator.check(imageUrl)).resolves.toEqual([
      { provider: 'huggingface', label: 'safe', score: 0.9, raw: data },
    ]);
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    expect(mockedAxios.get.mock.calls).toHaveLength(0);
  });

  it.each(['porn', 'hentai', 'sexy', 'nsfw', 'erotica'])(
    'preserves the %s unsafe label mapping and selects the highest score',
    async (label) => {
      const data = [
        { label: 'normal', score: 0 },
        { label, score: 1 },
      ];
      mockedAxios.post.mockResolvedValue({ data });
      await expect(moderator.check(imageUrl)).resolves.toEqual([
        { provider: 'huggingface', label: 'nsfw', score: 1, raw: data },
      ]);
    },
  );

  const invalidResponses: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['string', 'normal'],
    ['error object', { error: 'Model is loading' }],
    ['single prediction object', { label: 'normal', score: 1 }],
    ['empty array', []],
    ['empty nested array', [[]]],
    [
      'multiple images',
      [[{ label: 'normal', score: 1 }], [{ label: 'nsfw', score: 1 }]],
    ],
    [
      'mixed nesting',
      [[{ label: 'normal', score: 1 }], { label: 'nsfw', score: 1 }],
    ],
    ['deep nesting', [[[{ label: 'normal', score: 1 }]]]],
    ['null entry', [null]],
    ['primitive entry', ['normal']],
    ['missing label', [{ score: 1 }]],
    ['missing score', [{ label: 'normal' }]],
    ['unknown label', [{ label: 'unknown', score: 1 }]],
    ['numeric label', [{ label: 1, score: 1 }]],
    ['string score', [{ label: 'normal', score: '0.9' }]],
    ['null score', [{ label: 'normal', score: null }]],
    ['NaN score', [{ label: 'normal', score: NaN }]],
    ['infinite score', [{ label: 'normal', score: Infinity }]],
    ['negative score', [{ label: 'normal', score: -0.1 }]],
    ['score over one', [{ label: 'normal', score: 1.1 }]],
    [
      'all-zero scores',
      [
        { label: 'normal', score: 0 },
        { label: 'nsfw', score: 0 },
      ],
    ],
    [
      'unknown lower-ranked label',
      [
        { label: 'normal', score: 0.9 },
        { label: 'other', score: 0.1 },
      ],
    ],
    [
      'invalid lower-ranked probability',
      [
        { label: 'normal', score: 0.9 },
        { label: 'nsfw', score: -1 },
      ],
    ],
  ];

  it.each(invalidResponses)(
    'returns an error for %s in both attempts',
    async (_name, data) => {
      mockedAxios.post.mockResolvedValue({ data });
      await expect(moderator.check(imageUrl)).resolves.toEqual([
        {
          provider: 'huggingface',
          label: 'error',
          score: null,
          raw: { error: 'HF failed both URL and buffer' },
        },
      ]);
      expect(mockedAxios.post.mock.calls).toHaveLength(2);
      expect(mockedAxios.get.mock.calls).toEqual([
        [imageUrl, expect.any(Object)],
      ]);
    },
  );

  it.each([
    ['normal', 'safe'],
    ['nsfw', 'nsfw'],
  ])(
    'retries invalid URL predictions with a valid %s buffer response',
    async (label, expectedLabel) => {
      const data = [{ label, score: 0.95 }];
      mockedAxios.post
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data });
      await expect(moderator.check(imageUrl)).resolves.toEqual([
        {
          provider: 'huggingface',
          label: expectedLabel,
          score: 0.95,
          raw: data,
        },
      ]);
      expect(mockedAxios.post.mock.calls[1]).toEqual([
        expect.any(String),
        Buffer.from('image'),
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'image/png',
          },
        }),
      ]);
    },
  );

  it('preserves the error result when the fallback download fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('Inference unavailable'));
    mockedAxios.get.mockRejectedValue(new Error('Download unavailable'));
    await expect(moderator.check(imageUrl)).resolves.toEqual([
      {
        provider: 'huggingface',
        label: 'error',
        score: null,
        raw: { error: 'HF failed both URL and buffer' },
      },
    ]);
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
  });
});
