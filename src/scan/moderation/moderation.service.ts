import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HuggingFaceModerator } from './moderators/huggingface.moderator';
import { SightengineModerator } from './moderators/sightengine.moderator';
import { ModerationResult } from './moderators/moderator.interface';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  private hf?: HuggingFaceModerator;
  private se?: SightengineModerator;

  constructor(private config: ConfigService) {
    const hfToken = this.config.get<string>('HF_TOKEN');
    const hfModel =
      this.config.get<string>('HF_MODEL') ||
      'Falconsai/nsfw_image_detection';

    if (hfToken) {
      this.hf = new HuggingFaceModerator(hfToken, hfModel);
      this.logger.log('HuggingFace enabled');
    }

    const seUser = this.config.get<string>('SIGHTENGINE_USER');
    const seSecret = this.config.get<string>('SIGHTENGINE_SECRET');

    if (seUser && seSecret) {
      this.se = new SightengineModerator(seUser, seSecret);
      this.logger.log('Sightengine enabled');
    }

    if (!this.hf && !this.se) {
      throw new Error('Hech qanday moderation provider sozlanmagan!');
    }
  }

  // 🔥 MAIN LOGIC
  async checkSmart(imageUrl: string): Promise<ModerationResult[]> {
    this.logger.debug(`Checking: ${imageUrl}`);

    try {
      // 1️⃣ HF yo‘q → SE
      if (!this.hf && this.se) {
        return await this.safeCall(() => this.se!.check(imageUrl), 'SE');
      }

      // 2️⃣ HF ishlatamiz
      if (this.hf) {
        const hfRes = await this.safeCall(() => this.hf!.check(imageUrl), 'HF');
        const hf = hfRes?.[0];

        // ❌ HF error
        if (!hf || hf.label === 'error') {
          this.logger.warn(`HF error → fallback to SE`);

          if (this.se) {
            return await this.safeCall(() => this.se!.check(imageUrl), 'SE');
          }

          return hfRes;
        }

        // ✅ NSFW → to‘xtaymiz
        if (hf.label === 'nsfw') {
          return hfRes;
        }

        // 🤔 shubhali → SE bilan tekshir
        if ((hf.score ?? 0) > 0.2 && this.se) {
          this.logger.debug(`HF uncertain → using SE`);
          return await this.safeCall(() => this.se!.check(imageUrl), 'SE');
        }

        // ✅ aniq safe
        return hfRes;
      }

      // 3️⃣ fallback
      if (this.se) {
        return await this.safeCall(() => this.se!.check(imageUrl), 'SE');
      }

      return [];
    } catch (e: any) {
      this.logger.error(`Critical error: ${e.message}`);

      return [
        {
          provider: 'huggingface',
          label: 'error',
          score: null,
          raw: { error: e.message },
        },
      ];
    }
  }

  // 🔥 TIMEOUT + RETRY + LOG
  private async safeCall(
    fn: () => Promise<ModerationResult[]>,
    provider: string,
  ): Promise<ModerationResult[]> {
    const timeout = 15000;
    const retries = 2;

    for (let i = 0; i <= retries; i++) {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeout),
          ),
        ]);
      } catch (e: any) {
        this.logger.warn(
          `${provider} failed (try ${i + 1}): ${e.message}`,
        );

        if (i === retries) {
          return [
            {
              provider: provider.toLowerCase() as any,
              label: 'error',
              score: null,
              raw: { error: e.message },
            },
          ];
        }
      }
    }

    return [];
  }
}