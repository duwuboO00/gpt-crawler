// For more information, see https://crawlee.dev/
import { Configuration, PlaywrightCrawler, downloadListOfUrls } from "crawlee";
import { readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import { Config, configSchema } from "./config.js";
import { Page } from "playwright";
import { isWithinTokenLimit } from "gpt-tokenizer";
import { PathLike } from "fs";
// 匯入 turndown
import TurndownService from "turndown";

let pageCounter = 0;
let crawler: PlaywrightCrawler;

// 修改 getPageHtml 以回傳 innerHTML
export function getPageHtml(page: Page, selector = "body") {
  return page.evaluate((selector) => {
    // 檢查選擇器是否為 XPath
    if (selector.startsWith("/")) {
      const elements = document.evaluate(
        selector,
        document,
        null,
        // 取得單一節點以便取得 innerHTML
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = elements.singleNodeValue;
      // 確保是 HTMLElement 以取得 innerHTML，否則回退到 textContent
      return node instanceof HTMLElement ? node.innerHTML || "" : node?.textContent || "";
    } else {
      // 處理 CSS 選擇器
      const el = document.querySelector(selector) as HTMLElement | null;
      // 回傳 innerHTML 而不是 innerText
      return el?.innerHTML || "";
    }
  }, selector);
}

export async function waitForXPath(page: Page, xpath: string, timeout: number) {
  await page.waitForFunction(
    (xpath) => {
      const elements = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ANY_TYPE,
        null,
      );
      return elements.iterateNext() !== null;
    },
    xpath,
    { timeout },
  );
}

export async function crawl(config: Config) {
  configSchema.parse(config);

  // 建立 TurndownService 實例
  const turndownService = new TurndownService();

  if (process.env.NO_CRAWL !== "true") {
    // PlaywrightCrawler 使用由 Playwright 函式庫控制的無頭瀏覽器來爬取網頁。
    crawler = new PlaywrightCrawler(
      {
        // 使用 requestHandler 來處理每個爬取的頁面。
        async requestHandler({ request, page, enqueueLinks, log, pushData }) {
          const title = await page.title();
          pageCounter++;
          log.info(
            `Crawling: Page ${pageCounter} / ${config.maxPagesToCrawl} - URL: ${request.loadedUrl}...`,
          );

          // ... (waitForSelector 邏輯保持不變) ...
           if (config.selector) {
            if (config.selector.startsWith("/")) {
              await waitForXPath(
                page,
                config.selector,
                config.waitForSelectorTimeout ?? 1000,
              );
            } else {
              await page.waitForSelector(config.selector, {
                timeout: config.waitForSelectorTimeout ?? 1000,
              });
            }
          }

          // 取得原始 HTML 內容
          const rawHtml = await getPageHtml(page, config.selector);

          // 將原始 HTML 轉換為 Markdown
          const markdown = turndownService.turndown(rawHtml);

          // 將結果（包含 Markdown）儲存為 JSON
          // 注意：欄位名稱仍為 'html'，但現在包含 Markdown 內容
          await pushData({ title, url: request.loadedUrl, html: markdown });

          if (config.onVisitPage) {
            await config.onVisitPage({ page, pushData });
          }

          // 從目前頁面提取連結並加入爬取佇列。
          await enqueueLinks({
            globs:
              typeof config.match === "string" ? [config.match] : config.match,
            exclude:
              typeof config.exclude === "string"
                ? [config.exclude]
                : config.exclude ?? [],
          });
        },
        // Comment this option to scrape the full website.
        maxRequestsPerCrawl: config.maxPagesToCrawl,
        // Uncomment this option to see the browser window.
        // headless: false,
        preNavigationHooks: [
          // Abort requests for certain resource types and add cookies
          async (crawlingContext, _gotoOptions) => {
            const { request, page, log } = crawlingContext;
            // Add cookies to the page
            // Because the crawler has not yet navigated to the page, so the loadedUrl is always undefined. Use the request url instead.
            if (config.cookie) {
              const cookies = (
                Array.isArray(config.cookie) ? config.cookie : [config.cookie]
              ).map((cookie) => {
                return {
                  name: cookie.name,
                  value: cookie.value,
                  url: request.url,
                };
              });
              await page.context().addCookies(cookies);
            }
            const RESOURCE_EXCLUSTIONS = config.resourceExclusions ?? [];
            // If there are no resource exclusions, return
            if (RESOURCE_EXCLUSTIONS.length === 0) {
              return;
            }
            await page.route(
              `**\/*.{${RESOURCE_EXCLUSTIONS.join()}}`,
              (route) => route.abort("aborted"),
            );
            log.info(
              `Aborting requests for as this is a resource excluded route`,
            );
          },
        ],
      },
      new Configuration({
        purgeOnStart: true,
      }),
    );

    const isUrlASitemap = /sitemap.*\.xml$/.test(config.url);

    if (isUrlASitemap) {
      const listOfUrls = await downloadListOfUrls({ url: config.url });

      // Add the initial URL to the crawling queue.
      await crawler.addRequests(listOfUrls);

      // Run the crawler
      await crawler.run();
    } else {
      // Add first URL to the queue and start the crawl.
      await crawler.run([config.url]);
    }
  }
}

export async function write(config: Config) {
  let nextFileNameString: PathLike = "";
  const jsonFiles = await glob("storage/datasets/default/*.json", {
    absolute: true,
  });

  console.log(`Found ${jsonFiles.length} files to combine...`);

  let currentResults: Record<string, any>[] = [];
  let currentSize: number = 0;
  let fileCounter: number = 1;
  const maxBytes: number = config.maxFileSize
    ? config.maxFileSize * 1024 * 1024
    : Infinity;

  const getStringByteSize = (str: string): number =>
    Buffer.byteLength(str, "utf-8");

  const nextFileName = (): string =>
    `${config.outputFileName.replace(/\.json$/, "")}-${fileCounter}.json`;

  const writeBatchToFile = async (): Promise<void> => {
    nextFileNameString = nextFileName();
    await writeFile(
      nextFileNameString,
      JSON.stringify(currentResults, null, 2),
    );
    console.log(
      `Wrote ${currentResults.length} items to ${nextFileNameString}`,
    );
    currentResults = [];
    currentSize = 0;
    fileCounter++;
  };

  let estimatedTokens: number = 0;

  const addContentOrSplit = async (
    data: Record<string, any>,
  ): Promise<void> => {
    const contentString: string = JSON.stringify(data);
    const tokenCount: number | false = isWithinTokenLimit(
      contentString,
      config.maxTokens || Infinity,
    );

    if (typeof tokenCount === "number") {
      if (estimatedTokens + tokenCount > config.maxTokens!) {
        // Only write the batch if it's not empty (something to write)
        if (currentResults.length > 0) {
          await writeBatchToFile();
        }
        // Since the addition of a single item exceeded the token limit, halve it.
        estimatedTokens = Math.floor(tokenCount / 2);
        currentResults.push(data);
      } else {
        currentResults.push(data);
        estimatedTokens += tokenCount;
      }
    }

    currentSize += getStringByteSize(contentString);
    if (currentSize > maxBytes) {
      await writeBatchToFile();
    }
  };

  // Iterate over each JSON file and process its contents.
  for (const file of jsonFiles) {
    const fileContent = await readFile(file, "utf-8");
    const data: Record<string, any> = JSON.parse(fileContent);
    await addContentOrSplit(data);
  }

  // Check if any remaining data needs to be written to a file.
  if (currentResults.length > 0) {
    await writeBatchToFile();
  }

  return nextFileNameString;
}

class GPTCrawlerCore {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async crawl() {
    await crawl(this.config);
  }

  async write(): Promise<PathLike> {
    // we need to wait for the file path as the path can change
    return new Promise((resolve, reject) => {
      write(this.config)
        .then((outputFilePath) => {
          resolve(outputFilePath);
        })
        .catch(reject);
    });
  }
}

export default GPTCrawlerCore;
