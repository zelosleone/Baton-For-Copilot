import * as vscode from 'vscode';
import { ClaudeChatProvider } from './provider.js';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Code for Copilot', { log: true });
  const provider = new ClaudeChatProvider(context.globalState, log);

  context.subscriptions.push(
    log,
    provider,
    vscode.lm.registerLanguageModelChatProvider('claude-code', provider),
    vscode.commands.registerCommand('claudeCode.signIn', () => provider.signIn()),
    vscode.commands.registerCommand('claudeCode.manage', () => manage(provider, log)),
  );
  void provider.refresh();
}

async function manage(provider: ClaudeChatProvider, log: vscode.LogOutputChannel): Promise<void> {
  const actions: Record<string, () => unknown> = {
    'Refresh Models': () => provider.refresh(),
    'Sign In': () => provider.signIn(),
    'Show Logs': () => log.show(),
  };
  const choice = await vscode.window.showQuickPick(Object.keys(actions), {
    title: provider.describe(),
    placeHolder: provider.usage(),
  });
  if (choice) await actions[choice]();
}
