

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HuggingFaceModerator } from './moderators/huggingface.moderator';
import { SightengineModerator } from './moderators/sightengine.moderator';
import { IModerator, ModerationResult } from './moderators/moderator.interface';

@Injectable()
export class ModerationService {
  private moderators: IModerator[] = [];

  constructor(private config: ConfigService) {
    // HuggingFace
    const hfToken = this.config.get<string>('HF_TOKEN');
    const hfModel = this.config.get<string>('HF_MODEL') || 'Falconsai/nsfw_image_detection';
    if (hfToken) {
      this.moderators.push(new HuggingFaceModerator(hfToken, hfModel));
    }

    // Sightengine
    const seUser = this.config.get<string>('SIGHTENGINE_USER');
    const seSecret = this.config.get<string>('SIGHTENGINE_SECRET');
    if (seUser && seSecret) {
      this.moderators.push(new SightengineModerator(seUser, seSecret));
    }

    if (this.moderators.length === 0) {
      throw new Error('Hech qanday moderation provider sozlanmagan!');
    }
  }

  async checkAll(imageUrl: string): Promise<ModerationResult[]> {
    return Promise.all(this.moderators.map(m => m.check(imageUrl)));
  }
}
