import * as vscode from 'vscode';

let item: vscode.StatusBarItem | undefined;
let currentState: string = 'idle';

function createIfNeeded(context: vscode.ExtensionContext) {
  if (!item) {
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    item.command = 'zhihu.publishMarkdown';
    context.subscriptions.push(item);
  }
}

export function ensureStatusBarForMarkdown(context: vscode.ExtensionContext, editor: vscode.TextEditor | undefined) {
  const isMd = !!editor && isMarkdownDocument(editor.document);
  if (isMd) {
    createIfNeeded(context);
    updateStatus(currentState); // 维持原状态文本
    item!.show();
  } else if (item) {
    item.hide();
  }
}

export function initStatusBarOnEvents(context: vscode.ExtensionContext) {
  // 初始根据当前活动编辑器决定是否显示
  ensureStatusBarForMarkdown(context, vscode.window.activeTextEditor);
  // 监听活动编辑器变化
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(ed => {
    ensureStatusBarForMarkdown(context, ed);
  }));
  // 监听打开文档（首次打开 markdown 时可能还没成为活动编辑器）
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
    if (isMarkdownDocument(doc)) ensureStatusBarForMarkdown(context, vscode.window.activeTextEditor);
  }));
}

export function updateStatus(state: string) {
  currentState = state;
  if (!item) return; // 若当前未显示（没有 markdown），延迟到显示时再使用 currentState 恢复
  const textMap: Record<string,string> = {
    idle: 'Zhihu: 就绪',
    launching: 'Zhihu: 启动浏览器…',
    loggingIn: 'Zhihu: 登录中…',
    risk: 'Zhihu: 风控验证…',
    importing: 'Zhihu: 导入中…',
    done: 'Zhihu: 导入完成',
    error: 'Zhihu: 失败'
  };
  item.text = textMap[state] || `Zhihu: ${state}`;
  item.tooltip = '点击重新发布当前 Markdown 到知乎';
}

export function hideStatusBar() { if (item) item.hide(); }
export function getCurrentState() { return currentState; }

function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  const langOk = doc.languageId === 'markdown';
  const fileOk = /\.(md|markdown|mdown|mkdn)$/i.test(doc.fileName);
  return langOk || fileOk;
}