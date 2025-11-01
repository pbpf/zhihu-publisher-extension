import * as vscode from 'vscode';
// 延迟加载 publisher，减少激活时的依赖体积与失败风险
import { initStatusBarOnEvents, updateStatus } from './status';

export function activate(context: vscode.ExtensionContext) {
  initStatusBarOnEvents(context);
  const disposable = vscode.commands.registerCommand('zhihu.publishMarkdown', async () => {
    try {
      updateStatus('launching');
      const mod = await import('./zhihu/publisher');
      await mod.publishToZhihu(context);
      updateStatus('done');
    } catch (e: any) {
      updateStatus('error');
      vscode.window.showErrorMessage('知乎发布失败: ' + (e?.message || e));
    }
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {
  // noop
}
