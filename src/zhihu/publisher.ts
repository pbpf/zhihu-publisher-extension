import * as vscode from 'vscode';
// @ts-ignore - puppeteer types may not be installed; treat as any if missing
import puppeteer, { Page } from 'puppeteer';
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

export async function publishToZhihu(context: vscode.ExtensionContext) {
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

  vscode.window.showInformationMessage('启动浏览器准备发布知乎文章...');
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(ZHIHU.ENTRY, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });

  const loggedIn = await ensureLogin(page);
  if (!loggedIn) {
    vscode.window.showErrorMessage('登录失败或超时');
    await browser.close();
    return;
  }

  try {
    await page.goto(ZHIHU.EDITOR, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    vscode.window.showInformationMessage('进入写作页面，准备导入 Markdown');
    await openImportModal(page);
    vscode.window.showInformationMessage('导入模态已打开，开始上传文件');
    await uploadMarkdownFile(page, tempUri.fsPath);
    vscode.window.showInformationMessage('文件上传完成，填写标题中…');
    await fillTitle(page, title);
    vscode.window.showInformationMessage('知乎文章内容已导入，确认后可手动发布。');
  } catch (e: any) {
    vscode.window.showErrorMessage('导入流程失败: ' + (e?.message || e));
    try { await browser.close(); } catch {}
    return;
  }
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
      vscode.window.showInformationMessage('请在弹出页面使用微信扫码完成登录');
      await page.waitForSelector(ZHIHU.LOGIN_AVATAR, { timeout: 300000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function openImportModal(page: Page) {
  // 新 UI：点击 “导入” -> “导入文档”
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
}

async function uploadMarkdownFile(page: Page, filePath: string) {
  // 直接定位 file input，避免点击 placeholder 触发系统文件选择对话框
  const input = await page.$('.Modal-inner .react-aria-TabPanel input[type=file][accept*=".md"], .Modal-inner .react-aria-TabPanel input[type=file]');
  if (!input) throw new Error('未找到文件上传 input');
  // 确保可见性（某些内联 style: display:none）
  await page.evaluate((el: HTMLElement) => el.removeAttribute('style'), input as any);
  // 使用 uploadFile (旧版 puppeteer) 或 setInputFiles (新版) 兼容
  if ((input as any).setInputFiles) {
    await (input as any).setInputFiles([filePath]);
  } else {
    await (input as any).uploadFile(filePath);
  }
  // 等待后台处理，或标题/内容区域出现变化
  await delay(page, 2000);
  await finalizeImport(page);
}

async function fillTitle(page: Page, title: string) {
  const input = await page.$(ZHIHU.TITLE_INPUT);
  if (!input) throw new Error('未找到标题输入框');
  await input.type(title);
}

// 检测内容导入完成并尝试关闭模态框（若知乎编辑器允许）
async function finalizeImport(page: Page) {
  try {
    // 条件 1：编辑区出现内容节点或富文本容器有子元素
    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      return !!el && el.childElementCount > 0;
    }, { timeout: 8000 }, ZHIHU.CONTENT_SELECTOR);
  } catch {
    // 内容检测失败继续尝试关闭
  }
  // 查找关闭按钮（可能是模态右上角或“完成”按钮文字）
  const closeBtn = await page.$('.Modal-inner button[aria-label="关闭"], .Modal-closeButton, button[aria-label=关闭]');
  if (closeBtn) {
    await closeBtn.click();
    await delay(page, 300);
    return;
  }
  // 尝试点击“完成”或“确认”文本按钮
  await clickByText(page, '完成');
  await delay(page, 300);
  await clickByText(page, '确认');
  await delay(page, 300);
  // 若仍存在模态，可发送 ESC
  const modalStill = await page.$('.Modal-inner');
  if (modalStill) {
    await page.keyboard.press('Escape');
    await delay(page, 300);
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
