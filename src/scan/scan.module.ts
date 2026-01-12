import { Module } from '@nestjs/common';
import { ScanController } from './scan.controller';
import { ScanService } from './scan.service';
import { CrawlerService } from './crawler.service';
import { ModerationService } from './moderation/moderation.service';

@Module({
  controllers: [ScanController],
  providers: [ScanService, CrawlerService, ModerationService],
})
export class ScanModule {}
