import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import * as puppeteer from 'puppeteer';

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

 async crawlPages(startUrl: string, limit = 50) {
  const visited = new Set<string>();
  const queue = [startUrl];

  const origin = new URL(startUrl).origin;

  const browser = await puppeteer.launch({
    headless: true,
    // ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  });

  while (queue.length && visited.size < limit) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;

    visited.add(url);

    const page = await browser.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a'))
          .map(a => a.href)
          .filter(h => h.startsWith(location.origin))
      );

      for (const l of links) {
        if (!visited.has(l)) queue.push(l);
      }

    } catch (e) {
      this.logger.warn(`Sahifa ochilmadi: ${url}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  return Array.from(visited);
}


async extractImagesFromPage(pageUrl: string, browser: puppeteer.Browser) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );

    await page.goto(pageUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    // infinite scroll
    let prev = 0;
    while (true) {
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prev) break;
      prev = h;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 800));
    }

    const urls = await page.evaluate(() => {
      const set = new Set<string>();

      // img tags
      document.querySelectorAll('img').forEach(img => {
        if (img.src) set.add(img.src);

        Object.values(img.dataset || {}).forEach(v => {
          if (typeof v === 'string') set.add(v);
        });

        if (img.srcset) {
          img.srcset.split(',').forEach(x => {
            const u = x.trim().split(' ')[0];
            if (u) set.add(u);
          });
        }
      });

      // picture/source
      document.querySelectorAll('source').forEach(s => {
        const ss = s.getAttribute('srcset');
        if (ss) {
          ss.split(',').forEach(x => {
            const u = x.trim().split(' ')[0];
            if (u) set.add(u);
          });
        }
      });

      // noscript
      document.querySelectorAll('noscript').forEach(n => {
        const html = n.innerHTML;
        const m = html.match(/src=["'](.*?)["']/g);
        if (m) {
          m.forEach(x => {
            const u = x.split('=')[1].replace(/["']/g, '');
            set.add(u);
          });
        }
      });

      // preload
      document.querySelectorAll('link[rel="preload"]').forEach(l => {
        const h = l.getAttribute('href');
        if (h) set.add(h);
      });

      // css background
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.includes('url')) {
          const m = bg.match(/url\(["']?(.*?)["']?\)/);
          if (m) set.add(m[1]);
        }
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



  // async extractImageUrls(siteUrl: string): Promise<string[]> {
  //   let urls: string[] = [];

  //   try {
  //     urls = await this.extractWithCheerio(siteUrl);
  //     this.logger.log(`Cheerio orqali ${urls.length} ta rasm topildi`);
  //     const dynamicUrls = await this.extractWithPuppeteer(siteUrl);
  //     this.logger.log(`Puppeteer orqali ${dynamicUrls.length} ta rasm topildi`);
  //     urls = [...urls, ...dynamicUrls];

  //   } catch (e) {
  //     this.logger.warn(`Statik yuklashda xatolik: ${e.message}, puppeteer orqali urinib ko‘ramiz`);
  //     urls = await this.extractWithPuppeteer(siteUrl);
  //   }

  //   return [...new Set(urls)];
  // }

async extractImageUrls(siteUrl: string) {
  const pages = await this.crawlPages(siteUrl, 50);

  const browser = await puppeteer.launch({
    headless: true,
    // ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  });

  let all: string[] = [];

  for (const p of pages) {
    const imgs = await this.extractImagesFromPage(p, browser);
    all.push(...imgs);
  }

  try {
    const cheerioImgs = await this.extractWithCheerio(siteUrl);
    all.push(...cheerioImgs);
  } catch {}

  await browser.close();

  return [...new Set(all)];
}




  private async extractWithCheerio(siteUrl: string): Promise<string[]> {
    const { data } = await axios.get(siteUrl, { timeout: 20000 });
    const $ = cheerio.load(data);

    const urls: string[] = [];

    // <img>
    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src) urls.push(new URL(src, siteUrl).href);
    });

    // <source srcset>
    $('source').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (srcset) {
        const first = srcset.split(',')[0].trim().split(' ')[0];
        if (first) urls.push(new URL(first, siteUrl).href);
      }
    });

    // <picture>
    $('picture img').each((_, el) => {
      const src = $(el).attr('src');
      if (src) urls.push(new URL(src, siteUrl).href);
    });

    // <meta og:image>
    $('meta[property="og:image"]').each((_, el) => {
      const src = $(el).attr('content');
      if (src) urls.push(new URL(src, siteUrl).href);
    });

    // <link rel="image_src">
    $('link[rel="image_src"]').each((_, el) => {
      const src = $(el).attr('href');
      if (src) urls.push(new URL(src, siteUrl).href);
    });

    // <video poster>
    $('video').each((_, el) => {
      const poster = $(el).attr('poster');
      if (poster) urls.push(new URL(poster, siteUrl).href);
    });

    // inline CSS
    $('[style]').each((_, el) => {
      const style = $(el).attr('style');
      const match = /url\(['"]?(.*?)['"]?\)/.exec(style || '');
      if (match) urls.push(new URL(match[1], siteUrl).href);
    });

    // external CSS fayllarni ham tekshiramiz
    const cssLinks: string[] = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) cssLinks.push(new URL(href, siteUrl).href);
    });

    for (const cssUrl of cssLinks) {
      try {
        const { data: css } = await axios.get(cssUrl, { timeout: 10000 });
        const matches = [...css.matchAll(/url\(['"]?(.*?)['"]?\)/g)];
        for (const m of matches) {
          if (m[1]) urls.push(new URL(m[1], cssUrl).href);
        }
      } catch (e) {
        this.logger.warn(`CSS yuklanmadi: ${cssUrl} (${e.message})`);
      }
    }

    return urls;
  }

  // private async extractWithPuppeteer(siteUrl: string): Promise<string[]> {
  //   const browser = await puppeteer.launch({ headless: true });
  //   const page = await browser.newPage();
  //   await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  //   const urls = await page.evaluate(() => {
  //     const arr: string[] = [];

  //     document.querySelectorAll('img').forEach(img => {
  //       if ((img as HTMLImageElement).src) arr.push((img as HTMLImageElement).src);
  //     });

  //     document.querySelectorAll('source').forEach(src => {
  //       const srcset = (src as HTMLSourceElement).srcset;
  //       if (srcset) arr.push(srcset.split(',')[0].trim().split(' ')[0]);
  //     });

  //     document.querySelectorAll('picture img').forEach(img => {
  //       if ((img as HTMLImageElement).src) arr.push((img as HTMLImageElement).src);
  //     });

  //     document.querySelectorAll('meta[property="og:image"]').forEach(meta => {
  //       const content = (meta as HTMLMetaElement).content;
  //       if (content) arr.push(content);
  //     });

  //     document.querySelectorAll('link[rel="image_src"]').forEach(link => {
  //       const href = (link as HTMLLinkElement).href;
  //       if (href) arr.push(href);
  //     });

  //     document.querySelectorAll('video').forEach(video => {
  //       const poster = (video as HTMLVideoElement).poster;
  //       if (poster) arr.push(poster);
  //     });

  //     document.querySelectorAll<HTMLElement>('[style]').forEach(el => {
  //       const style = el.getAttribute('style') || '';
  //       const match = /url\(['"]?(.*?)['"]?\)/.exec(style);
  //       if (match) arr.push(match[1]);
  //     });

  //     return arr;
  //   });

  //   await browser.close();

  //   return urls.map(u => new URL(u, siteUrl).href);
  // }

  async extractWithPuppeteer(siteUrl: string) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    );

    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // 🔥 Lazy images uchun scroll
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          total += distance;
          if (total >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });

    const urls = await page.evaluate(() => {
      const set = new Set<string>();

      document.querySelectorAll('img').forEach(img => {
        if (img.src) set.add(img.src);
        if ((img as any).dataset?.src) set.add((img as any).dataset.src);
        if ((img as any).dataset?.lazy) set.add((img as any).dataset.lazy);
        if ((img as any).dataset?.original) set.add((img as any).dataset.original);

        if (img.srcset) {
          img.srcset.split(',').forEach(s => {
            const u = s.trim().split(' ')[0];
            if (u) set.add(u);
          });
        }
      });

      document.querySelectorAll('[style]').forEach(el => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.includes('url')) {
          const m = bg.match(/url\(["']?(.*?)["']?\)/);
          if (m) set.add(m[1]);
        }
      });

      document.querySelectorAll('video').forEach(v => {
        if (v.poster) set.add(v.poster);
      });

      document.querySelectorAll('meta[property="og:image"]').forEach(m => {
        const c = m.getAttribute('content');
        if (c) set.add(c);
      });

      return Array.from(set);
    });

    await browser.close();

    return urls.map(u => new URL(u, siteUrl).href);
  }

}
