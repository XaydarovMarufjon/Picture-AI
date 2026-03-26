import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

export class HuggingFaceModerator implements IModerator {
  constructor(
    private token: string,
    private model = 'Falconsai/nsfw_image_detection',
  ) {}

  async check(imageUrl: string): Promise<ModerationResult[]> {
    return this.retry(async () => {
      const { data } = await axios.post(
        `https://api-inference.huggingface.co/models/${this.model}`,
        { inputs: imageUrl }, // 🔥 URL BASED
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
          timeout: 15000,
        },
      );

      const arr = Array.isArray(data) ? data : [];
      const first = Array.isArray(arr[0]) ? arr[0] : arr;

      let top = { label: 'unknown', score: 0 };

      for (const it of first) {
        if (it?.score > top.score) top = it;
      }

      const nsfwLabels = ['porn', 'hentai', 'sexy', 'nsfw', 'erotica'];
      const label = nsfwLabels.includes(top.label) ? 'porn' : 'safe';

      return [{
        provider: 'huggingface',
        label,
        score: top.score,
        raw: data,
      }];
    });
  }

  private async retry(fn: () => Promise<ModerationResult[]>, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 15000),
          ),
        ]);
      } catch (e) {
        if (i === retries) {
          return [{
            provider: 'huggingface',
            label: 'error',
            score: null,
            raw: { error: (e as any)?.message },
          }];
        }
      }
    }
    return [];
  }
}