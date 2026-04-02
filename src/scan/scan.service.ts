import { Injectable, Logger } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { ModerationService } from './moderation/moderation.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ScanGateway } from './scan.gateway';

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
    private gateway: ScanGateway,
  ) { }

  // ================= MAIN =================
  async scan(url: string) {
    this.gateway.sendProgress({ stage: 'start', url });

    // 1️⃣ crawl
    const raw = await this.crawler.extractImageUrls(url);
    this.logger.log(`RAW: ${raw.length}`);

    this.gateway.sendProgress({
      stage: 'crawl',
      count: raw.length,
    });
    this.logger.log(`RAW: ${raw.length}`);

    // 2️⃣ filter
    const filtered = await this.filter(raw);

    this.gateway.sendProgress({
      stage: 'filter',
      count: filtered.length,
    });
    this.logger.log(`FILTERED: ${filtered.length}`);

    // 3️⃣ dedup (hash)
    const deduped = await this.dedupWithHash(filtered);

    this.gateway.sendProgress({
      stage: 'dedup',
      count: deduped.length,
    });
    this.logger.log(`DEDUPED: ${deduped.length}`);

    // 4️⃣ rank
    const top = this.rank(deduped).slice(0, 200);

    // 5️⃣ create scan
    const scan = await this.prisma.scan.create({
      data: {
        siteUrl: url,
        status: 'running',
        progress: top.length,
      },
    });

    // 6️⃣ moderation
    const results = await this.moderate(top);

    // 7️⃣ save
    await this.saveResults(results, scan.id);

    // 8️⃣ finish
    await this.prisma.scan.update({
      where: { id: scan.id },
      data: { status: 'finished' },
    });

    this.gateway.sendProgress({
      stage: 'finished',
      scanId: scan.id,
    });

    return {
      scanId: scan.id,
      total: raw.length,
      processed: top.length,
      saved: results.length,
    };
  }

  // ================= FILTER =================
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

  // ================= DEDUP + HASH =================
  private async dedupWithHash(urls: string[]) {
    const map = new Map<string, string>();
    const limit = pLimit(5);

    await Promise.all(
      urls.map(url =>
        limit(async () => {
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
          } catch { }
        }),
      ),
    );

    return Array.from(map.values());
  }

  // ================= RANK =================
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

  // ================= MODERATION =================
  private async moderate(urls: string[]) {
    const limit = pLimit(3);

    let done = 0;
    const total = urls.length;

    const results = await Promise.all(
      urls.map(url =>
        limit(async () => {
          try {
            const checks = await this.mod.checkSmart(url);

            done++;

            if (done % 5 === 0) {
              this.gateway.sendProgress({
                stage: 'moderation',
                done,
                total,
                progress: Math.round((done / total) * 100),
              });
            }

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

  // ================= SAVE =================
  private async saveResults(results: any[], scanId: number) {
    const limit = pLimit(5);

    await Promise.all(
      results.map(r =>
        limit(async () => {
          const hash = await this.getHash(r.url);
          if (!hash) return;

          await this.prisma.scanItem.upsert({
            where: { hash },
            update: {
              createdAt: new Date(),
              label: r.label,
              score: r.score ?? null,
              raw: r.raw ?? {},
            },
            create: {
              scanId,
              imageUrl: r.url,
              hash,
              provider: r.provider,
              label: r.label,
              score: r.score ?? null,
              raw: r.raw ?? {},
              createdAt: new Date(),
            },
          });
        }),
      ),
    );
  }

  private async getHash(url: string): Promise<string | null> {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 8000,
      });

      return crypto
        .createHash('md5')
        .update(res.data)
        .digest('hex');
    } catch {
      return null;
    }
  }

  // ================= EXTRA =================

  latest(limit = 100) {
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

  getScan(id: number) {
    return this.prisma.scan.findUnique({
      where: { id },
      include: { items: true },
    });
  }
}

