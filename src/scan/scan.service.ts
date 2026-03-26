import { Injectable, Logger } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { ModerationService } from './moderation/moderation.service';
import { PrismaService } from 'src/prisma/prisma.service';
import pLimit from 'p-limit';
import axios from 'axios';
import crypto from 'crypto';

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private crawler: CrawlerService,
    private mod: ModerationService,
    private prisma: PrismaService,
  ) {}

  async scan(url: string) {
    // 1. crawl
    const raw = await this.crawler.extractImageUrls(url);
    this.logger.log(`RAW: ${raw.length}`);

    // 2. filter
    const filtered = await this.filter(raw);
    this.logger.log(`FILTERED: ${filtered.length}`);

    // 3. dedup
    const unique = await this.dedup(filtered);
    this.logger.log(`UNIQUE: ${unique.length}`);

    // 4. top 500
    const top = this.rank(raw).slice(0, 500);

    // 5. create scan
    const scan = await this.prisma.scan.create({
      data: {
        siteUrl: url,
        status: 'running',
        progress: top.length,
      },
    });

    // 6. moderation
    const results = await this.moderate(top);

    // 7. batch save
    await this.prisma.scanItem.createMany({
      data: results.map(r => ({
        scanId: scan.id,
        imageUrl: r.url,
        provider: r.provider,
        label: r.label,
        score: r.score ?? null,
        raw: r.raw ?? {},
      })),
    });

    // 8. finish
    await this.prisma.scan.update({
      where: { id: scan.id },
      data: { status: 'finished' },
    });

    return {
      scanId: scan.id,
      total: raw.length,
      processed: top.length,
      saved: results.length,
    };
  }

  // ---------------- FILTER ----------------
private async filter(urls: string[]) {
  const limit = pLimit(5);

  const results = await Promise.all(
    urls.map(url =>
      limit(async () => {
        if (!url.startsWith('http')) return null;

        if (
          url.includes('logo') ||
          url.includes('icon') ||
          url.includes('avatar') ||
          url.includes('sprite') ||
          url.endsWith('.svg')
        ) return null;

        try {
          const head = await axios.head(url, { timeout: 5000 });
          const size = Number(head.headers['content-length'] || 0);

          if (size < 5 * 1024) return null;

          return url;
        } catch {
          return null;
        }
      }),
    ),
  );

  return results.filter(Boolean) as string[];
}

  // ---------------- DEDUP ----------------

  private async dedup(urls: string[]) {
    const map = new Map<string, string>();

    for (const url of urls) {
      try {
        const res = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 8000,
        });

        const hash = crypto
          .createHash('md5')
          .update(res.data)
          .digest('hex');

        if (!map.has(hash)) {
          map.set(hash, url);
        }
      } catch {}
    }

    return Array.from(map.values());
  }

  // ---------------- RANK ----------------

  private rank(urls: string[]) {
    return urls
      .map(u => ({
        url: u,
        score: this.score(u),
      }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.url);
  }

  private score(url: string) {
    let s = 0;

    if (url.includes('product')) s += 3;
    if (url.includes('news')) s += 2;
    if (url.includes('banner')) s += 1;

    if (url.includes('logo')) s -= 5;

    return s;
  }

  // ---------------- MODERATION ----------------

//   private async moderate(urls: string[]) {
//   const limit = pLimit(3);

//   const results = await Promise.all(
//     urls.map(url =>
//       limit(async () => {
//         try {
//           const checks = await this.mod.checkSmart(url);

//           return checks
//             .filter(r => (r.score ?? 0) > 0)
//             .map(r => ({
//               url,
//               provider: r.provider,
//               label: r.label,
//               score: r.score,
//               raw: r.raw,

              
//             } 
//           ));
            

//         } catch {
//           return [];
//         }
//       }),
//     ),
//   );

//   return results.flat();
// }


private async moderate(urls: string[]) {
  const limit = pLimit(3);

  const results = await Promise.all(
    urls.map(url =>
      limit(async () => {
        try {
          const checks = await this.mod.checkSmart(url);

          return checks.map(r => ({
            url,
            provider: r.provider,
            label: r.label,
            score: r.score,
            raw: r.raw,
          }));

        } catch {
          return [];
        }
      }),
    ),
  );

  return results.flat();
}


  // ---------------- QUERIES ----------------

  latest(limit = 500) {
    return this.prisma.scan.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  searchBySite(siteUrl: string) {
    return this.prisma.scan.findMany({
      where: { siteUrl },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
  }

  getScan(id: number) {
    return this.prisma.scan.findUnique({
      where: { id },
      include: { items: true },
    });
  }

  async getProgress(id: number) {
    const scan = await this.prisma.scan.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!scan) return null;

    return {
      status: scan.status,
      total: scan.progress,
      done: scan.items.length,
    };
  }
}