import { Injectable, Logger } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { ModerationService } from './moderation/moderation.service';
import pLimit from 'p-limit';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private crawler: CrawlerService,
    private mod: ModerationService,
    private prisma: PrismaService,
  ) {}

  // ------------------ HELPERS ------------------

  private isUzDomain(url: string) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('.uz');
    } catch {
      return false;
    }
  }

  private isFont(url: string) {
    return /\.(woff|woff2|ttf|otf)$/i.test(url);
  }

  private isSvg(url: string) {
    return url.toLowerCase().endsWith('.svg');
  }

  private isBitmap(url: string) {
    return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(url);
  }

private async svgToPng(svgUrl: string): Promise<Buffer> {
  const puppeteer = (await import('puppeteer')).default;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  } as any); // 👈 TYPE FIX

  const page = await browser.newPage();
  await page.goto(svgUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  const shot = await page.screenshot({ fullPage: true });

  await browser.close();

  // 👇 Uint8Array → Buffer
  return Buffer.from(shot as Uint8Array);
}


  // ------------------ MAIN SCAN ------------------

  async scan(url: string) {
    if (!this.isUzDomain(url)) {
      throw new Error('Faqat .uz domenlarni skan qilishga ruxsat berilgan');
    }

    // 1. Barcha rasmlarni yig‘ish
    const images = await this.crawler.extractImageUrls(url);
    this.logger.log(`${images.length} ta fayl topildi: ${url}`);

    // 2. Scan yozuvini yaratish
    const scan = await this.prisma.scan.create({
      data: { siteUrl: url, status: 'running',  progress: images.length,
 },
    });

    // 3. Parallel moderatsiya
    const limit = pLimit(3);

    const results = await Promise.all(
      images.map((img) =>
        limit(async () => {
          try {
            // ❌ FONT
            if (this.isFont(img)) return [];

            // 🟢 SVG
            if (this.isSvg(img)) {
              const png = await this.svgToPng(img);
              const checks = await this.mod.checkBuffer(png);

              return Promise.all(
                checks.map((r) =>
                  this.prisma.scanItem.create({
                    data: {
                      scanId: scan.id,
                      imageUrl: img,
                      provider: r.provider,
                      label: r.label,
                      score: r.score ?? null,
                      raw: r.raw ?? {},
                    },
                  }),
                ),
              );
            }

            // 🟢 BITMAP
            if (this.isBitmap(img)) {
              const checks = await this.mod.checkAll(img);

              return Promise.all(
                checks.map((r) =>
                  this.prisma.scanItem.create({
                    data: {
                      scanId: scan.id,
                      imageUrl: img,
                      provider: r.provider,
                      label: r.label,
                      score: r.score ?? null,
                      raw: r.raw ?? {},
                    },
                  }),
                ),
              );
            }

            // ❌ boshqa formatlar
            return [];
          } catch (e: any) {
            this.logger.warn(`Moderation error for ${img}: ${e?.message || e}`);

            return [
              await this.prisma.scanItem.create({
                data: {
                  scanId: scan.id,
                  imageUrl: img,
                  provider: 'error',
                  label: 'error',
                  score: null,
                  raw: { error: e?.message || 'unknown' },
                },
              }),
            ];
          }
        }),
      ),
    );

    // 4. Yakunlash
    await this.prisma.scan.update({
      where: { id: scan.id },
      data: { status: 'finished' },
    });

    return {
      scanId: scan.id,
      siteUrl: url,
      totalFiles: images.length,
      savedItems: results.flat().length,
    };
  }

  // ------------------ QUERIES ------------------

  async getScan(scanId: number) {
    return this.prisma.scan.findUnique({
      where: { id: scanId },
      include: { items: { orderBy: { createdAt: 'desc' } } },
    });
  }

  async latest(limit = 50) {
    return this.prisma.scan.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async searchBySite(siteUrl: string) {
    return this.prisma.scan.findMany({
      where: { siteUrl },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { items: true },
    });
  }

  async getProgress(scanId: number) {
  const scan = await this.prisma.scan.findUnique({
    where: { id: scanId },
    include: { items: true },
  });

  if (!scan) return null;

  return {
    status: scan.status,
    total: scan.progress,
    done: scan.items.length,
    items: scan.items
  };
}

}
