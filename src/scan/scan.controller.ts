import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import { ScanService } from './scan.service';
import { StartScanDto } from './dto/start-scan.dto';

@Controller('scan')
export class ScanController {
  constructor(private service: ScanService) {}

  @Post()
  async start(@Body() dto: StartScanDto) {
    if (!dto?.url || !dto.url.startsWith('http')) {
      throw new BadRequestException('Invalid URL');
    }

    return this.service.scan(dto.url);
  }

  @Get('latest')
  latest(@Query('limit') limit?: unknown) {
    // Preserve the default and Prisma's zero/negative pagination semantics.
    if (limit === undefined || limit === '') return this.service.latest(500);

    if (typeof limit !== 'string') {
      throw new BadRequestException('limit must be a safe integer');
    }

    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed)) {
      throw new BadRequestException('limit must be a safe integer');
    }

    return this.service.latest(parsed);
  }

  @Get()
  bySite(@Query('url') url: string) {
    if (!url) throw new BadRequestException('url required');
    return this.service.searchBySite(url);
  }

  @Get('detail')
  detail(@Query('id', ParseIntPipe) id: number) {
    return this.service.getScan(id);
  }

  @Get(':id/progress')
  progress(@Param('id', ParseIntPipe) id: number) {
    return this.service.getProgress(id);
  }
}
