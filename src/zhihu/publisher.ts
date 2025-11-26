import * as vscode from 'vscode';
// @ts-ignore - puppeteer types可能未安装，直接静态导入
import puppeteer, { Page, Browser } from 'puppeteer';
// 全局持有当前浏览器实例，进入新的发布流程前关闭旧实例
let activeBrowser: Browser | undefined;
import { updateStatus } from '../status';
import uploadLocalImage from './upload';
import * as path from 'path';
// TextEncoder fallback：Node18+ 已内置；若不存在则使用 Buffer 转换替代
const encodeUtf8 = (content: string): Uint8Array => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(content);
  }
  // 兼容旧 Node：Buffer.from 返回 Uint8Array 的子类
  // @ts-ignore
  return Buffer.from(content, 'utf8');
};

const ZHIHU = {
  ENTRY: 'https://www.zhihu.com/',
  EDITOR: 'https://zhuanlan.zhihu.com/write',
  LOGIN_AVATAR: '.Avatar.AppHeader-profileAvatar',
  LOGIN_BUTTON: '.Button.SignFlow-submitButton',
  QR_LOGIN_URL: 'https://open.weixin.qq.com/connect/qrconnect?appid=wx268fcfe924dcb171&redirect_uri=https%3A%2F%2Fwww.zhihu.com%2Foauth%2Fcallback%2Fwechat%3Faction%3Dlogin%26from%3D&response_type=code&scope=snsapi_login#wechat',
  TITLE_INPUT: '.WriteIndex-titleInput .Input',
  CONTENT_SELECTOR: '.Dropzone.Editable-content.RichText'
};

// 单例输出通道，用于显示调试/进度信息（非用户关键提示）
let channel: vscode.OutputChannel | undefined;
function log(msg: string) {
  if (!channel) channel = vscode.window.createOutputChannel('Zhihu Publisher');
  const time = new Date().toISOString().substring(11, 19); // HH:MM:SS
  channel.appendLine(`[${time}] ${msg}`);
}

export async function publishToZhihu(context: vscode.ExtensionContext) {
  // 若已有浏览器实例，则尝试优雅关闭，避免冲突或多占资源
  if (activeBrowser) {
    try {
      log('Closing previous Puppeteer browser instance before starting new publish flow');
      await activeBrowser.close();
    } catch (e: any) {
      log('Previous browser close failed: ' + (e?.message || e));
    } finally {
      activeBrowser = undefined;
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('没有打开的 Markdown 编辑器');
    return;
  }
  const raw = editor.document.getText();
  const fileName = editor.document.fileName.split('/').pop() || '未命名';
  const title = fileName.replace(/\.(md|markdown|mdown|mkdn)$/i, '');

  const tempUri = vscode.Uri.file(context.globalStorageUri.fsPath + '/temp.md');
  await vscode.workspace.fs.writeFile(tempUri, encodeUtf8(raw));
  log("write "+tempUri)

  // vscode.window.showInformationMessage('后台启动浏览器准备发布知乎文章...');
  updateStatus('launching');
  const profileDir = context.globalStorageUri.fsPath + '/chrome-profile';
  log('Launching headless browser with persistent profile at: ' + profileDir + ' (删除该目录可重置登录状态)');
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage'
  ];
  let isHeadless = true;
  let browser = await puppeteer.launch({ headless: isHeadless, userDataDir: profileDir, args: launchArgs });
  activeBrowser = browser;
  let page = await browser.newPage();
  await applyUserAgent(page);
  await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
  log('Opened Zhihu entry page (headless)');

  let loggedIn = await checkLoggedInQuick(page);
  if (!loggedIn) {
    // 需要登录：切换到可视模式
    log('Not logged in (headless). Restarting visible browser for login.');
    try { await browser.close(); } catch { }
    // vscode.window.showInformationMessage('需要扫码登录，正在打开浏览器窗口...');
    updateStatus('loggingIn');
    isHeadless = false;
    browser = await puppeteer.launch({ headless: isHeadless, userDataDir: profileDir, args: launchArgs });
    activeBrowser = browser;
    page = await browser.newPage();
    await applyUserAgent(page);
    await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    loggedIn = await ensureLogin(page);
    if (!loggedIn) {
      vscode.window.showErrorMessage('登录失败或超时，已清理缓存，下次将重新登录');
      updateStatus('error');
      try { await browser.close(); } catch { }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(profileDir), { recursive: true, useTrash: false });
        log('Deleted profile directory after failed login: ' + profileDir);
      } catch (e: any) {
        log('Failed to delete profile directory: ' + (e?.message || e));
      }
      return;
    }
    // 登录成功后切回 headless 减少打扰
    try {
      log('Login succeeded in visible mode, switching back to headless for import flow');
      try { await browser.close(); } catch { }
      isHeadless = true;
      browser = await puppeteer.launch({ headless: isHeadless, userDataDir: profileDir, args: launchArgs });
      activeBrowser = browser;
      page = await browser.newPage();
      await applyUserAgent(page);
      await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
      log('Headless session restored after login');
    } catch (e: any) {
      log('Failed to switch back to headless: ' + (e?.message || e));
    }
  } else {
    log('Detected existing logged-in session (headless)');
    // 额外检查风控（如风险验证）
    if (await detectRiskVerification(page)) {
      log('Risk verification detected in headless mode; switching to visible');
      updateStatus('risk');
      try { await browser.close(); } catch { }
      isHeadless = false;
      browser = await puppeteer.launch({ headless: isHeadless, userDataDir: profileDir, args: launchArgs });
      activeBrowser = browser;
      page = await browser.newPage();
      await applyUserAgent(page);
      await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
      const ensured = await ensureLogin(page);
      if (!ensured) {
        vscode.window.showErrorMessage('风控验证未通过');
        updateStatus('error');
        try { await browser.close(); } catch { }
        return;
      }
      loggedIn = true;
      // 风控验证通过后同样切回 headless
      try {
        log('Risk verification passed in visible mode, switching back to headless');
        try { await browser.close(); } catch { }
        isHeadless = true;
        browser = await puppeteer.launch({ headless: isHeadless, userDataDir: profileDir, args: launchArgs });
        activeBrowser = browser;
        page = await browser.newPage();
        await applyUserAgent(page);
        await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
        log('Headless session restored after risk verification');
      } catch (e: any) {
        log('Failed to revert to headless after risk verification: ' + (e?.message || e));
      }
    }
  }

  try {
    await page.goto(ZHIHU.EDITOR, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    log('Entered editor page');
    updateStatus('importing');
    // 先扫描并上传本地图片，替换临时文件中的本地路径为远端 URL
    try {
      let modified = raw;
      const imgRegex = /!\[[^\]]*\]\((?!https?:)([^)]+)\)/g;
      let m: RegExpExecArray | null;
      const rels: string[] = [];
      while ((m = imgRegex.exec(raw)) !== null) rels.push(m[1]);
      for (const rel of rels) {
        try {
          const localFull = path.resolve(path.dirname(editor.document.fileName), rel);
          log('Uploading local image: ' + localFull);
          const remote = await uploadLocalImage(page, localFull);
          log('Image uploaded: ' + remote);
            // 仅替换 Markdown 图片语法中的 URL：!
            // 构造安全的正则，匹配像 `![alt](  rel  )` 并替换括号内的 rel 为 remote
            const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const relEsc = escapeForRegex(rel);
            const mdImgUrlRegex = new RegExp("(!\\[[^\\]]*\\]\\(\\s*)" + relEsc + "(\\s*\\))", 'g');
            modified = modified.replace(mdImgUrlRegex, (match: string, p1: string, p2: string) => {
              return p1 + remote + p2;
            });
        } catch (e: any) {
          log('Upload local image failed for ' + rel + ': ' + (e?.message || e));
        }
      }
      // 覆写临时文件为替换后的内容
      await vscode.workspace.fs.writeFile(tempUri, encodeUtf8(modified));
    } catch (e: any) {
      log('Local image pre-upload failed: ' + (e?.message || e));
    }

    // 清空页面编辑器内容，避免导入时把图片插入到顶部导致重复
    try {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) {
          el.innerHTML = '';
          // 触发输入事件以通知编辑器状态变化（部分富文本依赖事件）
          try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
        } else {
          // 回退：清空任何 textarea
          const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
          if (ta) ta.value = '';
        }
      }, ZHIHU.CONTENT_SELECTOR);
      await delay(page, 300);
    } catch (e: any) {
      log('Clear editor content failed: ' + (e?.message || e));
    }

    // 在打开导入模态前自动删除编辑器中所有 <figure> 节点（防止重复图片）
    // try {
    //   const removed = await removeFigureNodes(page);
    //   log('Removed <figure> count: ' + removed);
    // } catch (e: any) {
    //   log('removeFigureNodes failed: ' + (e?.message || e));
    // }

    await openImportModal(page);
    log('Import modal opened');
    await uploadMarkdownFile(page, tempUri.fsPath);
    log('File uploaded, filling title');
    await fillTitle(page, title);
    updateStatus('done');
    log('Import flow finished (current mode: ' + (isHeadless ? 'visible' : 'headless?') + ')');
    await delay(page, 3000);
    const editorUrl = await page.evaluate(() => location.href);
    log('Url: ' + editorUrl);
    showEditorLinkMessage(editorUrl, isHeadless)
  } catch (e: any) {
    vscode.window.showErrorMessage('导入流程失败: ' + (e?.message || e));
    updateStatus('error');
    log('Error in import flow: ' + (e?.stack || e));
    try { await browser.close(); } catch { }
    return;
  }
}

// 快速检测是否已登录（不触发扫码）：寻找头像元素
async function checkLoggedInQuick(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(ZHIHU.LOGIN_AVATAR, { timeout: 4000 });
    return true;
  } catch { return false; }
}

async function ensureLogin(page: Page): Promise<boolean> {
  // 通过 race 等待登录状态或登录按钮
  try {
    const avatarPromise = page.waitForSelector(ZHIHU.LOGIN_AVATAR, { timeout: 60000 });
    const loginBtnPromise = page.waitForSelector(ZHIHU.LOGIN_BUTTON, { timeout: 30000 });
    const result = await Promise.race([avatarPromise, loginBtnPromise]);
    if (!result) return false;
    const className = await (await result.getProperty('className')).jsonValue() as string;
    if (className.includes('Button')) {
      await page.goto(ZHIHU.QR_LOGIN_URL, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
      // 显示二维码提示
      vscode.window.showInformationMessage('请在弹出页面使用微信扫码完成登录'); // 登录提示保留通知
      log('Waiting for avatar after QR login');
      await page.waitForSelector(ZHIHU.LOGIN_AVATAR, { timeout: 300000 });
    }
    // 登录后检查是否存在风险验证页面
    if (await detectRiskVerification(page)) {
      log('Risk verification page detected after login. Escalating handling.');
      const handled = await handleRiskVerification(page);
      if (!handled) return false;
    }
    return true;
  } catch {
    log('Login detection failed or timed out');
    return false;
  }
}

// 检测“系统监测到您的网络环境存在异常...” 风控提示
async function detectRiskVerification(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('系统监测到您的网络环境存在异常') && text.includes('开始验证');
    });
  } catch {
    return false;
  }
}

// 处理风控验证加载失败或按钮不可见的情况
async function handleRiskVerification(page: Page): Promise<boolean> {
  try {
    // 若当前是 headless，调用方需已切换为可视浏览器；这里再做一次兜底提醒
    vscode.window.showWarningMessage('检测到知乎风控验证，如果“开始验证”按钮未出现，将尝试自动刷新');
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`Risk verification handling attempt ${attempt}`);
      const buttonFound = await findAndHighlightVerifyButton(page);
      if (buttonFound) {
        vscode.window.showInformationMessage('请点击浏览器中的“开始验证”并完成验证');
        const solved = await waitForManualVerification(page, 180000);
        if (solved) {
          log('Risk verification solved within attempts');
          return true;
        } else {
          log('Waiting for manual verification timed out in this attempt');
        }
      } else {
        log('Verify button not found, reloading risk page');
      }
      try { await page.reload({ waitUntil: ['domcontentloaded', 'load'] }); } catch { }
      await new Promise(r => setTimeout(r, 1500));
      if (!(await detectRiskVerification(page))) {
        // 可能已经跳转走了，检查头像
        const avatar = await page.$(ZHIHU.LOGIN_AVATAR);
        if (avatar) return true;
      }
    }
    vscode.window.showErrorMessage('风控验证未成功加载或未在限定时间内完成');
    return false;
  } catch (e: any) {
    log('handleRiskVerification error: ' + (e?.message || e));
    return false;
  }
}

async function findAndHighlightVerifyButton(page: Page): Promise<boolean> {
  try {
    const found = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div')) as HTMLElement[];
      const target = candidates.find(el => /开始验证|验证/.test(el.innerText || ''));
      if (target) {
        target.style.outline = '2px solid #ff4d4f';
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      }
      return false;
    });
    return !!found;
  } catch { return false; }
}

// 等待用户手动完成风控验证：轮询头像出现或提示消失
async function waitForManualVerification(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const hasAvatar = await page.$(ZHIHU.LOGIN_AVATAR);
      if (hasAvatar) return true;
      const stillRisk = await detectRiskVerification(page);
      if (!stillRisk) {
        // 提示消失后再确认一次头像（给页面跳转时间）
        try { await page.waitForSelector(ZHIHU.LOGIN_AVATAR, { timeout: 5000 }); return true; } catch { }
      }
    } catch { }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// 已改为静态导入 puppeteer，无需 lazyLoadPuppeteer

async function openImportModal(page: Page) {
  // 新 UI：点击 “导入” -> “导入文档”
  log('Trying to open import modal');
  const importBtn = await page.$('button[aria-label="导入"], .Button[aria-label=导入]');
  if (importBtn) {
    await importBtn.click();
  } else {
    await clickByText(page, '导入');
  }
  await delay(page, 800);
  const importDocBtn = await page.$('button[aria-label="导入文档"], .Button[aria-label=导入文档]');
  if (importDocBtn) {
    await importDocBtn.click();
  } else {
    await clickByText(page, '导入文档');
  }
  await delay(page, 800);
  await page.waitForSelector('.Modal-inner .react-aria-TabPanel', { timeout: 15000 });
  log('Import modal content panel detected');
}

async function uploadMarkdownFile(page: Page, filePath: string) {
  // 直接定位 file input，避免点击 placeholder 触发系统文件选择对话框
  log('Locating file input for upload');
  const input = await page.$('.Modal-inner .react-aria-TabPanel input[type=file][accept*=".md"], .Modal-inner .react-aria-TabPanel input[type=file]');
  if (!input) throw new Error('未找到文件上传 input');
  // 确保可见性（某些内联 style: display:none）
  await page.evaluate((el: HTMLElement) => el.removeAttribute('style'), input as any);
  // 使用 uploadFile (旧版 puppeteer) 或 setInputFiles (新版) 兼容
  if ((input as any).setInputFiles) {
    await (input as any).setInputFiles([filePath]);
    log('Used legacy setInputFiles API');
  } else {
    await (input as any).uploadFile(filePath);
    log('Used uploadFile API');
  }
  // 等待后台处理，或标题/内容区域出现变化
  await delay(page, 2000);
  await finalizeImport(page);
}

async function fillTitle(page: Page, title: string) {
  const input = await page.$(ZHIHU.TITLE_INPUT);
  if (!input) throw new Error('未找到标题输入框');
  await input.type(title);
  log('Title filled: ' + title);
}

// 检测内容导入完成并尝试关闭模态框（若知乎编辑器允许）
async function finalizeImport(page: Page) {
  try {
    // 条件 1：编辑区出现内容节点或富文本容器有子元素
    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      return !!el && el.childElementCount > 0;
    }, { timeout: 8000 }, ZHIHU.CONTENT_SELECTOR);
    log('Content area has children, import likely completed');
  } catch {
    // 内容检测失败继续尝试关闭
    log('Content detection failed within timeout, proceeding to close modal anyway');
  }
  // 查找关闭按钮（可能是模态右上角或“完成”按钮文字）
  const closeBtn = await page.$('.Modal-inner button[aria-label="关闭"], .Modal-closeButton, button[aria-label=关闭]');
  if (closeBtn) {
    await closeBtn.click();
    await delay(page, 300);
    log('Clicked explicit close button');
    return;
  }
  // 尝试点击“完成”或“确认”文本按钮
  await clickByText(page, '完成');
  await delay(page, 300);
  log('Clicked 完成 button (if existed)');
  await clickByText(page, '确认');
  await delay(page, 300);
  log('Clicked 确认 button (if existed)');
  // 若仍存在模态，可发送 ESC
  const modalStill = await page.$('.Modal-inner');
  if (modalStill) {
    await page.keyboard.press('Escape');
    await delay(page, 300);
    log('Sent Escape to close remaining modal');
  }
}

async function clickByText(page: Page, text: string) {
  await page.evaluate((t: string) => {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const target = btns.find(b => (b.textContent || '').includes(t));
    if (target) target.click();
  }, text);
}

// 通用延迟：避免依赖未初始化的 window.__start__；使用 evaluate+Promise
function delay(page: Page, ms: number) {
  return page.waitForFunction((timeout) => {
    return new Promise(resolve => setTimeout(resolve, timeout)).then(() => true);
  }, {}, ms);
}

// 展示可点击编辑页链接的消息
async function showEditorLinkMessage(url: string, headless: boolean) {
  const actions: string[] = [];
  actions.push('打开浏览器');
  const selection = await vscode.window.showInformationMessage('知乎文章内容已导入：' + url, ...actions);
  if (selection === '打开浏览器') {
    // 使用系统默认浏览器直接打开编辑页
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      log('已在系统默认浏览器中打开知乎编辑页面');
    } catch (e: any) {
      await vscode.env.clipboard.writeText(url);
      log('打开系统浏览器失败,已复制知乎编辑链接');
    }
  }
}

// 统一设置 User-Agent（兼容未来 setUserAgent 弃用）
async function applyUserAgent(page: Page) {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  try {
    // 优先使用 CDP 覆盖 UA
    const client = await (page as any).createCDPSession?.();
    if (client) {
      await client.send('Network.setUserAgentOverride', { userAgent: ua });
      return;
    }
  } catch (e: any) {
    log('CDP UA override failed: ' + (e?.message || e));
  }
  try {
    // 回退旧 API（若仍可用）
    // @ts-ignore
    if (page.setUserAgent) await (page as any).setUserAgent(ua);
  } catch (e: any) {
    log('Fallback setUserAgent failed: ' + (e?.message || e));
  }
}

// 删除编辑区内所有 <figure> 节点：优先模拟选中并发送 Delete 键，失败时直接从 DOM 删除并触发 input 事件
async function removeFigureNodes(page: Page) {
  try {
    const diag = await page.evaluate((sel) => {
      const out: any = { found: false, beforeCount: 0, removedCount: 0, sampleSrcs: [] };
      const container = document.querySelector(sel);
      if (!container) return out;
      out.found = true;
      const figs = Array.from(container.querySelectorAll('figure'));
      out.beforeCount = figs.length;
      for (const f of figs) {
        const img = f.querySelector('img') as HTMLImageElement | null;
        if (img && out.sampleSrcs.length < 10) out.sampleSrcs.push(img.src || img.getAttribute('src'));
        f.remove();
        out.removedCount += 1;
      }
      try { container.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { container.dispatchEvent(new Event('compositionend', { bubbles: true })); } catch {}
      return out;
    }, ZHIHU.CONTENT_SELECTOR);
    await delay(page, 80);
    log('removeFigureNodes completed (bulk remove)');
    log('removeFigureNodes diag: ' + JSON.stringify(diag));
    return diag.removedCount || 0;
  } catch (e: any) {
    log('removeFigureNodes error: ' + (e?.message || e));
    return 0;
  }
}
