import { Page, ElementHandle } from 'puppeteer';

async function findOrCreateFileInput(page: Page): Promise<ElementHandle<Element>> {
  // 尝试找到现有的 file input
  let input = await page.$('input[type=file]');
  if (input) return input;

  // 若找不到，则在页面上动态创建一个并返回其 handle
  const handle = await page.evaluateHandle(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'block';
    input.className = '__zhihu_publisher_upload__';
    document.body.appendChild(input);
    return input;
  });
  return handle.asElement() as ElementHandle<Element>;
}

export async function uploadLocalImage(page: Page, localPath: string, opts?: { timeoutMs?: number, maxRetries?: number }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const maxRetries = opts?.maxRetries ?? 2;

  let lastErr: any = null;
  for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
    try {
      const input = await findOrCreateFileInput(page);

      // Puppeteer 新 API: setInputFiles
      // @ts-ignore - 兼容不同版本的 puppeteer
      if (typeof (input as any).setInputFiles === 'function') {
        // @ts-ignore
        await (input as any).setInputFiles([localPath]);
      } else if (typeof (input as any).uploadFile === 'function') {
        // 老版 API
        // @ts-ignore
        await (input as any).uploadFile(localPath);
      } else {
        throw new Error('浏览器环境不支持 setInputFiles/uploadFile');
      }

      // 等待页面中最后一个 img 的 src 变为远端 URL（非 blob/data）
      await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        if (!imgs.length) return false;
        const last = imgs[imgs.length - 1];
        const src = last?.src || last?.getAttribute('src') || '';
        return !!src && /^https?:\/\//.test(src) && !src.startsWith('blob:') && !src.startsWith('data:');
      }, { timeout: timeoutMs });

      const remoteUrl = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        if (!imgs.length) return '';
        const last = imgs[imgs.length - 1];
        return last?.src || last?.getAttribute('src') || '';
      });

      if (remoteUrl && /^https?:\/\//.test(remoteUrl)) {
        return remoteUrl;
      }
      lastErr = new Error('上传后未检测到有效远端图片 URL');
    } catch (e: any) {
      lastErr = e;
      // 等待一小段再重试
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr || new Error('uploadLocalImage failed');
}

export default uploadLocalImage;
