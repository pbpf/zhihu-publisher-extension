"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSync = void 0;
const vscode = require("vscode");
const browser_1 = require("../../core/browser");
const sleep_1 = require("../../core/sleep");
const log_1 = require("../../core/log");
const md_process_1 = require("../../core/md-process");
const md_editor_1 = require("../../core/md-editor");
const fs_1 = require("fs");
let console = (0, log_1.useConsoleLog)();
const CONSTANTS = {
    /**
     * 入口路径
     */
    ENTRY_URL: 'https://www.zhihu.com/',
    /**
     * 编辑器界面地址
     */
    EDITOR_URL: 'https://zhuanlan.zhihu.com/write',
    /**
     * 登录地址，必须包含二维码
     */
    LOGIN_URL: 'https://open.weixin.qq.com/connect/qrconnect?appid=wx268fcfe924dcb171&redirect_uri=https%3A%2F%2Fwww.zhihu.com%2Foauth%2Fcallback%2Fwechat%3Faction%3Dlogin%26from%3D&response_type=code&scope=snsapi_login#wechat',
    /**
     * 上传图片后的等待地址，根据此路径获取图片的url
     */
    UPLOAD_IMAGE_WAIT_URL: 'https://picx.zhimg.com',
    /**
     * 选择器，标题的input输入框
     */
    SELECTOR_TITLE: '.WriteIndex-titleInput .Input',
    /**
     * 选择器，内容区域的文本框
     */
    SELECTOR_CONTENT: '.Dropzone.Editable-content.RichText',
    /**
     * 选择器，登录二维码
     */
    SELECTOR_LOGIN_QRCODE: 'img.web_qrcode_img',
    /**
     * 选择器，未登录时的标志
     */
    SELECTOR_NO_LOGIN: '.Button.SignFlow-submitButton',
    /**
     * 选择器，登录后的头像
     */
    SELECTOR_LOGIN_AVATAR: '.Avatar.AppHeader-profileAvatar',
    /**
     * 选择器，新建文章按钮
     */
    SELECTOR_BTN_NEW_ARTICLE: '.fa-plus-circle',
    /**
     * 选择器，保存文章按钮
     */
    SELECTOR_BTN_SAVE_ARTICLE: '.fa-floppy-o',
    /**
     * 选择器，上传图片的按钮
     */
    SELECTOR_BTN_UPLOAD_IMG: '.Button.ToolbarButton[aria-label=图片]',
    /**
     * 选择器，上传图片的input输入框
     */
    SELECTOR_BTN_UPLOAD_INPUT: '.Modal input[type=file]',
};
/**
 * 当前任务所在的page
 */
let page;
let context;
/**
 * 发布文章的入口函数
 */
async function startSync(_context) {
    context = _context;
    // 初始化
    await pageInit();
    // 登录
    await loginAndRedirect();
    // 构造数据
    const mdTextToEditor = await contentCreator();
    // 输入
    await inputResult(mdTextToEditor);
    // 保存
    const url = await saveArticle();
    // 结束
    await pageExit();
}
exports.startSync = startSync;
/**
 * 校验登录，方法：同时寻找登录的扫码图片和头像，谁先找到就用谁返回
 * 若未登录，还将返回扫码二维码url
 * @param page
 * @returns {Promise<{success: boolean;imgurl: string;}>}
 */
async function checkLogin(page) {
    await (0, sleep_1.sleep)(3);
    if (page.url().indexOf('account/unhuman') !== -1) {
        console.userLog('由于频繁访问，触发了知乎的人机检测，请打开浏览器手动处理一次');
        return { 'success': false, imgurl: '' };
    }
    // 校验未登录
    const noLoginTask = page.waitForSelector(CONSTANTS.SELECTOR_NO_LOGIN);
    // 校验已登录
    const avatarTask = page.waitForSelector(CONSTANTS.SELECTOR_LOGIN_AVATAR, { timeout: 120000 });
    // 登录结果
    const result = {
        // 成功 or 失败
        success: false,
        // 扫码登录的二维码地址
        imgurl: ''
    };
    const raceResult = await Promise.race([
        noLoginTask, avatarTask
    ]);
    if (!raceResult) {
        result.success = true;
        return result;
    }
    // 获取元素的className
    const buttonClassName = await (await raceResult.getProperty('className')).jsonValue();
    // 比对是哪个先找到
    if (buttonClassName.toString().indexOf('Button') !== -1) {
        //////// 登录按钮先找到时 
        // 跳转至二维码登录地址
        await page.goto(CONSTANTS.LOGIN_URL, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
        // 寻找登录二维码
        const imgurl = (await page.$eval(CONSTANTS.SELECTOR_LOGIN_QRCODE, (ele) => ele.src));
        result.success = false;
        result.imgurl = imgurl;
    }
    else {
        result.success = true;
    }
    return result;
    // return new Promise(resolve => {
    //   noLoginTask.then(async loginElement => {
    //     // 跳转至二维码登录地址
    //     await page.goto(CONSTANTS.LOGIN_URL,{ waitUntil: ['domcontentloaded', 'load', 'networkidle0'] })
    //     // 寻找登录二维码
    //     const imgurl = (await page.$eval(CONSTANTS.SELECTOR_LOGIN_QRCODE, (ele) => (ele as HTMLImageElement).src))!;
    //     result.success = false;
    //     result.imgurl = imgurl;
    //     resolve(result);
    //   }).catch(e => {
    //     resolve(result)
    //   })
    //   avatarTask.then(ele => {
    //     result.success = true;
    //     resolve(result)
    //   }).catch(e => {
    //     resolve(result)
    //   })
    // })
}
/**
 * 上传图片
 * @param imgSeg
 */
async function uploadImage(page, imgSeg) {
    console.userLog(`开始上传本地图片：${imgSeg.segImage?.local}`);
    // 点击上传图片按钮
    await page.click(CONSTANTS.SELECTOR_BTN_UPLOAD_IMG);
    await (0, sleep_1.sleep)(1);
    // 获取上传的file元素
    const upfile = await page.$(CONSTANTS.SELECTOR_BTN_UPLOAD_INPUT);
    await (0, sleep_1.sleep)(1);
    // 开始上传
    await upfile.uploadFile(imgSeg.segImage.local);
    await (0, sleep_1.sleep)(3);
    // 点击插入图片
    await page.click(".css-owamhi");
    await (0, sleep_1.sleep)(2);
    // 获取最后一个插入的图片链接
    const url = await page.evaluate(() => {
        return document.querySelectorAll(".Image").item(document.querySelectorAll(".Image").length - 1).getAttribute('src');
    });
    console.log(url);
    // 拼装返回结果
    const response = {
        url: url || ''
    };
    if (!response)
        imgSeg.segImage.remoteUrl = '';
    imgSeg.segImage.remoteUrl = response?.url || '';
    imgSeg.mdTxt = `![${imgSeg.segImage.remoteUrl ? '文章配图' : '自动上传出错'}](${imgSeg.segImage.remoteUrl})`;
    // 等待1秒钟
    await (0, sleep_1.sleep)(1);
    console.userLog(`本地图片上传成功! 远端访问地址：${imgSeg.segImage?.remoteUrl}`);
    return imgSeg;
}
/**
 * 监听界面的弹窗事件，默认立即接受
 * @param page
 */
function pageDialogAccept(page) {
    page.on('dialog', async (dialog) => {
        switch (dialog.type()) {
            case 'alert':
                await dialog.dismiss();
                break;
            case 'confirm':
                await dialog.accept();
                break;
            case 'prompt':
                await dialog.accept("type things");
                break;
            case 'beforeunload':
                await dialog.accept();
                break;
            default:
                // eslint-disable-next-line no-throw-literal
                throw "can't get dialog type";
        }
    });
}
/**
 * 清空编辑器内容和标题内容
 * @param page
 */
async function clearEditor(page) {
    const script = `
  let input = document.querySelector("${CONSTANTS.SELECTOR_TITLE}");
  if (input) input.value = '';
  let editor = document.querySelector("${CONSTANTS.SELECTOR_CONTENT}");
  if (editor) {editor.value = '';editor.innerHTML=''}
  `;
    await page.evaluate(script);
    await (0, sleep_1.sleep)(1);
}
/**
 * 生成内容
 * @param params
 */
async function contentCreator() {
    // 清空当前存在的标题和内容
    // await clearEditor(page);
    // 获取配置
    const config = vscode.workspace.getConfiguration('MarkdownPublisher');
    const uploadImageTogether = config.get('uploadImageTogether');
    if (!uploadImageTogether)
        console.userLog('上传图片的配置已关闭，请确保图片的URL可远程访问!');
    const mdEditor = (0, md_editor_1.useMdEditor)().get();
    const content = mdEditor.document.getText() + '';
    const segments = (0, md_process_1.mdProccess)(content);
    let mdTextToEditor = '';
    for (let index = 0; index < segments.length; index++) {
        const element = segments[index];
        console.log('处理片段', element);
        if (element.type === 'text')
            mdTextToEditor += element.mdTxt;
        if (element.type === 'image') {
            if (uploadImageTogether) {
                const imgSeg = await uploadImage(page, element);
                mdTextToEditor += imgSeg.mdTxt;
                console.log('处理后的图片', imgSeg);
            }
            else {
                mdTextToEditor += element.mdTxt;
            }
        }
    }
    await (0, sleep_1.sleep)(1);
    console.userLog('Markdown文本转换成功!');
    return mdTextToEditor;
}
/**
 * 将最终结果输入到编辑器、输入框
 * @param mdTextToEditor
 */
async function inputResult(mdTextToEditor) {
    console.userLog('正在输入内容，请稍后...');
    // 先清空
    // await page.reload()
    await (0, sleep_1.sleep)(1);
    // await clearEditor(page);
    const uri = vscode.Uri.file(context.globalStorageUri.fsPath + '/temp.md');
    console.userLog('生成一个临时文件：', uri.fsPath);
    if ((0, fs_1.existsSync)(uri.fsPath))
        vscode.workspace.fs.delete(uri);
    vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(mdTextToEditor));
    // 重新打开一个编辑窗
    await page.goto(CONSTANTS.EDITOR_URL, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    await (0, sleep_1.sleep)(3);
    // 打开上传文件的弹窗
    await page.click('.Button.ToolbarButton[aria-label=文档]');
    await (0, sleep_1.sleep)(1);
    await page.click('.Popover-content .Button[aria-label=文档]');
    await (0, sleep_1.sleep)(1);
    // 上传文件
    const upfile = await page.$(".Editable-docModal input[type=file]");
    await Promise.all([
        page.waitForResponse('https://www.zhihu.com/api/v4/document_convert'),
        upfile.uploadFile(uri.fsPath)
    ]);
    await (0, sleep_1.sleep)(3);
    // 输入标题
    const input = await page.$(CONSTANTS.SELECTOR_TITLE);
    await input?.type((0, md_editor_1.useMdEditor)().get().document.fileName.split('/').pop() + '');
    await (0, sleep_1.sleep)(1);
    console.userLog('内容输入成功!');
}
/**
 * 保存文章草稿
 * @param page
 */
async function saveArticle() {
    await (0, sleep_1.sleep)(1);
    // 点击保存后，有一次重定向，监听此次重定向来判断是否成功
    // await page.waitForNavigation();
    const url = await page.url();
    console.userLog(`文章保存成功！点击查看 → <a href="${url}">${url}</a>`);
    return url;
}
/**
 * 初始化：保存markdown编辑器、browser初始化、page初始化、监听弹窗时间
 * @returns {{page:Page}} 返回初始化好的page
 */
async function pageInit() {
    // 存储当前激活的窗口
    // 必须在console.log之前，否则激活的窗口会被log窗口占用
    (0, md_editor_1.useMdEditor)().set(vscode.window.activeTextEditor);
    // 清空用户日志
    console.userLogClear();
    console.userLog('Markdown Publisher 一键发布任务开始！');
    // browser初始化、page初始化
    page = (await (await (0, browser_1.useBrowser)()).newPageWithSpecial(CONSTANTS.ENTRY_URL, 'PLATFORM_CSDN'));
    // 监听弹窗时间
    pageDialogAccept(page);
    console.userLog('模拟器初始化完成!');
}
/**
 * 校验登录、跳页至编辑器界面、打开md编辑器
 */
async function loginAndRedirect() {
    const { success, imgurl } = await checkLogin(page);
    if (!success)
        await loginByQrCode(imgurl);
    console.log('2.完成登录校验', '很好，系统检测到您已登录');
    await page.goto(CONSTANTS.EDITOR_URL, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    console.log('3.成功跳转至md编辑器界面', CONSTANTS.EDITOR_URL);
    console.userLog("登录成功!");
}
/**
 * 登录逻辑
 * @param qrCodeUrl 登录的二维码
 * @returns
 */
async function loginByQrCode(qrCodeUrl) {
    // console.userLog('未登录时的逻辑处理，需扫码登录')
    console.userLog(`
    <div style="text-align:center;">
     <img src="${qrCodeUrl}" width=200 /><div>请使用微信扫码登录</div>
    </div>
    `);
    // 等待头像加载出来
    await page.waitForSelector(CONSTANTS.SELECTOR_LOGIN_AVATAR, { timeout: 300000 });
    await (0, sleep_1.sleep)(1);
    return true;
}
async function pageExit() {
    // 关闭界面
    await page.close();
    // 关闭浏览器
    await page.browser().close();
    (await (0, browser_1.useBrowser)()).release();
    console.userLog(`Markdown Publisher 一键发布任务结束！`);
}
//# sourceMappingURL=index.js.map