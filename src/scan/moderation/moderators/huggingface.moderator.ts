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
    } catch (e: unknown) {
      return [
        {
          provider: 'huggingface',
          label: 'error',
          score: null,
          raw: {
            error: e instanceof Error ? e.message : 'HF moderation failed',
          },
        },
      ];
    }
  }

  // 🔹 URL METHOD
  private async tryUrl(imageUrl: string): Promise<ModerationResult[] | null> {
    try {
      const { data } = await axios.post<unknown>(
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
  private async tryBuffer(
    imageUrl: string,
  ): Promise<ModerationResult[] | null> {
    try {
      const img = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
      });

      const { data } = await axios.post<unknown>(
        `https://api-inference.huggingface.co/models/${this.model}`,
        img.data,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type':
              typeof img.headers['content-type'] === 'string'
                ? img.headers['content-type']
                : 'image/jpeg',
          },
          timeout: 15000,
        },
      );

      return this.parse(data);
    } catch {
      return null;
    }
  }

  // Only classify validated predictions for the single requested image.
  private parse(data: unknown): ModerationResult[] {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid HF prediction response');
    }

    const predictions: unknown[] = Array.isArray(data[0]) ? data[0] : data;
    if (
      (Array.isArray(data[0]) && data.length !== 1) ||
      predictions.length === 0
    ) {
      throw new Error('Expected predictions for one image');
    }

    const nsfwLabels = ['porn', 'hentai', 'sexy', 'nsfw', 'erotica'];
    // Falconsai/nsfw_image_detection uses "normal" for its safe class.
    const safeLabels = ['normal'];
    let top: { label: string; score: number } | undefined;

    for (const prediction of predictions) {
      if (
        typeof prediction !== 'object' ||
        prediction === null ||
        Array.isArray(prediction) ||
        !('label' in prediction) ||
        !('score' in prediction)
      ) {
        throw new Error('Invalid HF prediction');
      }

      const { label, score } = prediction;
      if (
        typeof label !== 'string' ||
        (!nsfwLabels.includes(label) && !safeLabels.includes(label)) ||
        typeof score !== 'number' ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1
      ) {
        throw new Error('Invalid HF prediction label or probability');
      }

      if (!top || score > top.score) {
        top = { label, score };
      }
    }

    if (!top || top.score === 0) {
      throw new Error('HF response has no positive prediction');
    }

    return [
      {
        provider: 'huggingface',
        label: nsfwLabels.includes(top.label) ? 'nsfw' : 'safe',
        score: top.score,
        raw: data,
      },
    ];
  }
}
