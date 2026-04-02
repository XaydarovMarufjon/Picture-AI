import axios from 'axios';
import { IModerator, ModerationResult } from './moderator.interface';

export class HuggingFaceModerator implements IModerator {
  constructor(
    private token: string,
    private model = 'Falconsai/nsfw_image_detection',
  ) {}

  async check(imageUrl: string): Promise<ModerationResult[]> {
    try {
      // 🔥 1. URL bilan urinib ko‘ramiz
      const urlResult = await this.tryUrl(imageUrl);
      if (urlResult) return urlResult;

      // 🔥 2. fallback → buffer
      const bufferResult = await this.tryBuffer(imageUrl);
      if (bufferResult) return bufferResult;

      throw new Error('HF failed both URL and buffer');

    } catch (e: any) {
      return [{
        provider: 'huggingface',
        label: 'error',
        score: null,
        raw: { error: e.message },
      }];
    }
  }

  // 🔹 URL METHOD
  private async tryUrl(imageUrl: string): Promise<ModerationResult[] | null> {
    try {
      const { data } = await axios.post(
        `https://api-inference.huggingface.co/models/${this.model}`,
        { inputs: imageUrl },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
          timeout: 10000,
        },
      );

      return this.parse(data);

    } catch {
      return null;
    }
  }

  // 🔹 BUFFER METHOD
  private async tryBuffer(imageUrl: string): Promise<ModerationResult[] | null> {
    try {
      const img = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const { data } = await axios.post(
        `https://api-inference.huggingface.co/models/${this.model}`,
        img.data,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': img.headers['content-type'] || 'image/jpeg',
          },
          timeout: 15000,
        },
      );

      return this.parse(data);

    } catch {
      return null;
    }
  }

  // 🔹 PARSER (ENG MUHIM)
  private parse(data: any): ModerationResult[] {
    const arr = Array.isArray(data) ? data : [];
    const first = Array.isArray(arr[0]) ? arr[0] : arr;

    let top = { label: 'unknown', score: 0 };

    for (const it of first) {
      if (it?.score > top.score) {
        top = it;
      }
    }

    const nsfwLabels = ['porn', 'hentai', 'sexy', 'nsfw', 'erotica'];
    const label = nsfwLabels.includes(top.label) ? 'nsfw' : 'safe';

    return [{
      provider: 'huggingface',
      label,
      score: top.score,
      raw: data,
    }];
  }
}