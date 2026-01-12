// import { Injectable, Logger } from '@nestjs/common';
// import { CrawlerService } from './crawler.service';
// import { ModerationService } from './moderation/moderation.service';
// import pLimit from 'p-limit';
// import { PrismaService } from 'src/prisma/prisma.service';

// @Injectable()
// export class ScanService {
//   private readonly logger = new Logger(ScanService.name);

//   constructor(
//     private crawler: CrawlerService,
//     private mod: ModerationService,
//     private prisma: PrismaService,
//   ) {}

//   private isUzDomain(url: string) {
//     try {
//       const u = new URL(url);
//       return u.hostname.endsWith('.com');
//     } catch {
//       return false;
//     }
//   }

//   async scan(url: string) {
//     if (!this.isUzDomain(url)) {
//       throw new Error('Faqat .uz domenlarni skan qilishga ruxsat berilgan');
//     }

//     const images = await this.crawler.extractImageUrls(url);

//     const scan = await this.prisma.scan.create({
//       data: { siteUrl: url, status: 'running' },
//     });

//     const limit = pLimit(5);
//     const results = await Promise.all(
//       images.map((img) =>
//         limit(async () => {
//           try {
//             const checks = await this.mod.checkAll(img); // ikkala provider birga
//             const savedItems = await Promise.all(
//               checks.map((r) =>
//                 this.prisma.scanItem.create({
//                   data: {
//                     scanId: scan.id,
//                     imageUrl: img,
//                     provider: r.provider,   // qaysi provider
//                     label: r.label,
//                     score: r.score ?? null,
//                     raw: r.raw ?? {},
//                   },
//                 }),
//               ),
//             );
//             return savedItems;
//           } catch (e: any) {
//             this.logger.warn(`Moderation error for ${img}: ${e?.message || e}`);
//             return [
//               await this.prisma.scanItem.create({
//                 data: {
//                   scanId: scan.id,
//                   imageUrl: img,
//                   provider: 'error',
//                   label: 'error',
//                   score: null,
//                   raw: { error: e?.message || 'unknown' },
//                 },
//               }),
//             ];
//           }
//         }),
//       ),
//     );

//     await this.prisma.scan.update({
//       where: { id: scan.id },
//       data: { status: 'finished' },
//     });

//     return { scanId: scan.id, total: images.length, saved: results.flat().length };
//   }

//   async getScan(scanId: number) {
//     return this.prisma.scan.findUnique({
//       where: { id: scanId },
//       include: { items: { orderBy: { createdAt: 'desc' } } },
//     });
//   }

//   async latest(limit = 50) {
//     return this.prisma.scan.findMany({
//       orderBy: { createdAt: 'desc' },
//       take: limit,
//     });
//   }

//   async searchBySite(siteUrl: string) {
//     return this.prisma.scan.findMany({
//       where: { siteUrl },
//       orderBy: { createdAt: 'desc' },
//       take: 5,
//       include: { items: true },
//     });
//   }
// }
////// ====================== har turdagi rasmni yuklab olib jonatish

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

  private isUzDomain(url: string) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('.uz');
    } catch {
      return false;
    }
  }

  async scan(url: string) {
    if (!this.isUzDomain(url)) {
      throw new Error('Faqat .uz domenlarni skan qilishga ruxsat berilgan');
    }

    // 1. Barcha rasmlarni yig‘ish
    const images = await this.crawler.extractImageUrls(url);
    this.logger.log(`${images.length} ta rasm topildi: ${url}`);

    // 2. Scan yozuvini yaratish
    const scan = await this.prisma.scan.create({
      data: { siteUrl: url, status: 'running' },
    });

    // 3. Parallel moderatsiya (chegaralangan)
    const limit = pLimit(5);
    const results = await Promise.all(
      images.map((img) =>
        limit(async () => {
          try {
            const checks = await this.mod.checkAll(img); // sightengine + huggingface
            const savedItems = await Promise.all(
              checks.map((r) =>
                this.prisma.scanItem.create({
                  data: {
                    scanId: scan.id,
                    imageUrl: img,
                    provider: r.provider,   // qaysi provider
                    label: r.label,
                    score: r.score ?? null,
                    raw: r.raw ?? {},
                  },
                }),
              ),
            );
            return savedItems;
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
      totalImages: images.length,
      savedItems: results.flat().length,
    };
  }

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
}
