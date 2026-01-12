import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import puppeteer from 'puppeteer';

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  async extractImageUrls(siteUrl: string): Promise<string[]> {
    let urls: string[] = [];

    try {
      urls = await this.extractWithCheerio(siteUrl);
      this.logger.log(`Cheerio orqali ${urls.length} ta rasm topildi`);

      if (urls.length < 5) {
        const dynamicUrls = await this.extractWithPuppeteer(siteUrl);
        this.logger.log(`Puppeteer orqali ${dynamicUrls.length} ta rasm topildi`);
        urls = [...urls, ...dynamicUrls];
      }
    } catch (e) {
      this.logger.warn(`Statik yuklashda xatolik: ${e.message}, puppeteer orqali urinib ko‘ramiz`);
      urls = await this.extractWithPuppeteer(siteUrl);
    }

    return [...new Set(urls)];
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

  private async extractWithPuppeteer(siteUrl: string): Promise<string[]> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const urls = await page.evaluate(() => {
      const arr: string[] = [];

      document.querySelectorAll('img').forEach(img => {
        if ((img as HTMLImageElement).src) arr.push((img as HTMLImageElement).src);
      });

      document.querySelectorAll('source').forEach(src => {
        const srcset = (src as HTMLSourceElement).srcset;
        if (srcset) arr.push(srcset.split(',')[0].trim().split(' ')[0]);
      });

      document.querySelectorAll('picture img').forEach(img => {
        if ((img as HTMLImageElement).src) arr.push((img as HTMLImageElement).src);
      });

      document.querySelectorAll('meta[property="og:image"]').forEach(meta => {
        const content = (meta as HTMLMetaElement).content;
        if (content) arr.push(content);
      });

      document.querySelectorAll('link[rel="image_src"]').forEach(link => {
        const href = (link as HTMLLinkElement).href;
        if (href) arr.push(href);
      });

      document.querySelectorAll('video').forEach(video => {
        const poster = (video as HTMLVideoElement).poster;
        if (poster) arr.push(poster);
      });

      document.querySelectorAll<HTMLElement>('[style]').forEach(el => {
        const style = el.getAttribute('style') || '';
        const match = /url\(['"]?(.*?)['"]?\)/.exec(style);
        if (match) arr.push(match[1]);
      });

      return arr;
    });

    await browser.close();

    return urls.map(u => new URL(u, siteUrl).href);
  }
}
