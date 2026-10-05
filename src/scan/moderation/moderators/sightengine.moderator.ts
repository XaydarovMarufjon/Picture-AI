import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SightengineModerator implements IModerator {
  constructor(
    private apiUser: string,
    private apiSecret: string,
  ) {}

  async check(imageUrl: string): Promise<ModerationResult[]> {
    try {
      const { data } = await axios.get<unknown>(
        'https://api.sightengine.com/1.0/check.json',
        {
          params: {
            url: imageUrl,
            models: 'nudity,wad,gore',
            api_user: this.apiUser,
            api_secret: this.apiSecret,
          },
          timeout: 10000,
        },
      );

      if (
        !isRecord(data) ||
        data.status !== 'success' ||
        !isRecord(data.nudity)
      ) {
        throw new Error('Invalid Sightengine response');
      }

      const pornScore = data.nudity.raw ?? data.nudity.sexual_activity;
      if (
        typeof pornScore !== 'number' ||
        !Number.isFinite(pornScore) ||
        pornScore < 0 ||
        pornScore > 1
      ) {
        throw new Error('Invalid Sightengine nudity score');
      }

      const label = pornScore > 0.5 ? 'nsfw' : 'safe';

      return [
        {
          provider: 'sightengine',
          label,
          score: pornScore,
          raw: data,
        },
      ];
    } catch (e: unknown) {
      return [
        {
          provider: 'sightengine',
          label: 'error',
          score: null,
          raw: {
            error:
              e instanceof Error ? e.message : 'Sightengine request failed',
          },
        },
      ];
    }
  }
}
