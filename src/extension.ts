import * as vscode from 'vscode';
// 延迟加载 publisher，减少激活时的依赖体积与失败风险

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('zhihu.publishMarkdown', async () => {
    try {
      const mod = await import('./zhihu/publisher');
      await mod.publishToZhihu(context);
    } catch (e: any) {
      vscode.window.showErrorMessage('知乎发布失败: ' + (e?.message || e));
    }
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {
  // noop
}
