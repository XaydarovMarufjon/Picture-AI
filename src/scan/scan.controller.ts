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
  latest(@Query('limit') limit?: string) {
    return this.service.latest(limit ? +limit : 500);
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