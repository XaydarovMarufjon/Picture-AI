import { Controller, Post, Body } from '@nestjs/common';
import { ModerationService } from './moderation.service';

@Controller('moderation')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Post('analyze')
  async analyzeImage(@Body('imageUrl') imageUrl: string) {
    return await this.moderationService.moderateImage(imageUrl);
  }
}
