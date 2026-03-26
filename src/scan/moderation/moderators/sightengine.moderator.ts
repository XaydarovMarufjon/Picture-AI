import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

export class SightengineModerator implements IModerator {
  constructor(
    private apiUser: string,
    private apiSecret: string,
  ) {}

  async check(imageUrl: string): Promise<ModerationResult[]> {
    try {
      const { data } = await axios.get(
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

      const nudity = data?.nudity || {};
      const pornScore = nudity.raw ?? nudity.sexual_activity ?? 0;

      const label = pornScore > 0.5 ? 'nsfw' : 'safe';

      return [{
        provider: 'sightengine',
        label,
        score: pornScore,
        raw: data,
      }];
    } catch (e: any) {
      return [{
        provider: 'sightengine',
        label: 'error',
        score: null,
        raw: { error: e?.message },
      }];
    }
  }
}