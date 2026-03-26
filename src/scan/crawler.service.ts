import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import pLimit from 'p-limit';

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  // ---------------- MAIN ----------------

  async extractImageUrls(siteUrl: string) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      // 1. crawl pages
      const pages = await this.crawlPages(siteUrl, browser, 20);

      // 2. extract images (parallel with limit)
      const limit = pLimit(5);

      const results = await Promise.all(
        pages.map(p =>
          limit(() => this.extractImagesFromPage(p, browser)),
        ),
      );

      const all = results.flat();

      // 3. unique (URL level)
      return [...new Set(all)];

    } finally {
      await browser.close();
    }
  }

  // ---------------- CRAWL ----------------

  private async crawlPages(
    startUrl: string,
    browser: puppeteer.Browser,
    limit = 20,
  ) {
    const visited = new Set<string>();
    const queue = [startUrl];
    const origin = new URL(startUrl).origin;

    while (queue.length && visited.size < limit) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;

      visited.add(url);

      const page = await browser.newPage();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded', // ⚡ tezroq
          timeout: 30000,
        });

        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a'))
            .map(a => a.href)
            .filter(h => h.startsWith(location.origin)),
        );

        for (const l of links) {
          if (!visited.has(l)) queue.push(l);
        }

      } catch {
        this.logger.warn(`Skip: ${url}`);
      } finally {
        await page.close();
      }
    }

    return Array.from(visited);
  }

  // ---------------- IMAGE EXTRACT ----------------

  private async extractImagesFromPage(
    pageUrl: string,
    browser: puppeteer.Browser,
  ) {
    const page = await browser.newPage();

    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const urls = await page.evaluate(() => {
        const set = new Set<string>();

        document.querySelectorAll('img').forEach(img => {
          if (img.src) set.add(img.src);

          if (img.srcset) {
            img.srcset.split(',').forEach(x => {
              const u = x.trim().split(' ')[0];
              if (u) set.add(u);
            });
          }
        });

        document.querySelectorAll('source').forEach(s => {
          const ss = s.getAttribute('srcset');
          if (ss) {
            ss.split(',').forEach(x => {
              const u = x.trim().split(' ')[0];
              if (u) set.add(u);
            });
          }
        });

        document.querySelectorAll('meta[property="og:image"]').forEach(m => {
          const c = m.getAttribute('content');
          if (c) set.add(c);
        });

        return Array.from(set);
      });

      return urls.map(u => new URL(u, pageUrl).href);

    } catch {
      return [];
    } finally {
      await page.close();
    }
  }
}