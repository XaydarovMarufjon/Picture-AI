import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

export class SightengineModerator implements IModerator {
  constructor(
    private apiUser: string,
    private apiSecret: string,
  ) {}

  async check(imageUrl: string): Promise<ModerationResult> {
    const { data } = await axios.get('https://api.sightengine.com/1.0/check.json', {
      params: {
        url: imageUrl,
        models: 'nudity,wad,gore',
        api_user: this.apiUser,
        api_secret: this.apiSecret,
      },
      timeout: 20000,
    });

    // Nudity modelida: raw/partial/safe qiymatlar bo‘ladi
    const nudity = data?.nudity || data?.nudity2 || {};
    // Pornografiya ehtimolini baholash
    const pornScore = nudity.raw ?? nudity.sexual_activity ?? 0;
    const safeScore = nudity.safe ?? 0;
    const label = pornScore > 0.5 ? 'nsfw' : 'safe';

    return {
      label,
      score: pornScore || safeScore,
      raw: data,
      provider: 'sightengine'
    };
  }
}
