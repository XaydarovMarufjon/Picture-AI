import { Module } from '@nestjs/common';
import { ScanController } from './scan.controller';
import { ScanService } from './scan.service';
import { CrawlerService } from './crawler.service';
import { ModerationService } from './moderation/moderation.service';
import { CronService } from './cron.service';
import { ScanGateway } from './scan.gateway';

@Module({
  controllers: [ScanController],
  providers: [
    CrawlerService,
    ModerationService,
    CronService,
    ScanService,
    ScanGateway,
  ],
})
export class ScanModule { }
