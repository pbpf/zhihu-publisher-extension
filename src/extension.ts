import * as vscode from 'vscode';
import { publishToZhihu } from './zhihu/publisher';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('zhihu.publishMarkdown', async () => {
    try {
      await publishToZhihu(context);
    } catch (e: any) {
      vscode.window.showErrorMessage('知乎发布失败: ' + (e?.message || e));
    }
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {
  // noop
}
