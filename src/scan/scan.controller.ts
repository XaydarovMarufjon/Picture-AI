import { Controller, Get, Post, Body, Query, ParseIntPipe } from '@nestjs/common';
import { ScanService } from './scan.service';
import { StartScanDto } from './dto/start-scan.dto';

@Controller('scan')
export class ScanController {
  constructor(private service: ScanService) {}

  @Post()
  async start(@Body() dto: StartScanDto) {
    return this.service.scan(dto.url);
  }

  @Get('latest')
  async latest(@Query('limit') limit?: string) {
    return this.service.latest(limit ? +limit : 50);
  }

  @Get()
  async bySite(@Query('url') url: string) {
    return this.service.searchBySite(url);
  }

  @Get('detail')
  async detail(@Query('id', ParseIntPipe) id: number) {
    return this.service.getScan(id);
  }
}
