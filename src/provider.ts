import type { AccountInfo, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { findClaude, INSTALL_URL, isSignedIn, probe, type ModelWindow } from './claude.js';
import { charsOf, parseRequest } from './convert.js';
import { pickEffort, toClaudeModels, type ClaudeModel } from './models.js';
import { ClaudeError, Sessions, type Usage } from './session.js';

const MODELS_KEY = 'baton.models';
const WINDOWS_KEY = 'baton.windows';
const CHARS_PER_TOKEN_KEY = 'baton.charsPerToken';
const WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' };

type Options = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: { readonly reasoningEffort?: string };
  readonly configuration?: { readonly reasoningEffort?: string };
};

interface LimitWindow {
  utilization?: number;
  resetsAt?: number;
}

export class ClaudeChatProvider implements vscode.LanguageModelChatProvider<ClaudeModel>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly sessions = new Sessions();
  private models: ClaudeModel[];
  private charsPerToken: number;
  private account?: AccountInfo;
  private limits?: SDKRateLimitInfo;
  private refreshing?: Promise<void>;
  private prompting = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.models = state.get<ClaudeModel[]>(MODELS_KEY, []);
    this.charsPerToken = state.get(CHARS_PER_TOKEN_KEY, 4);
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<ClaudeModel[]> {
    if (this.models.length > 0 || options.silent) return this.models;
    await this.refresh();
    if (this.models.length === 0) void this.promptSetup();
    return this.models;
  }

  async provideLanguageModelChatResponse(
    model: ClaudeModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: Options,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const exe = findClaude();
    if (!exe) throw new Error(`Claude Code is not installed. Install it from ${INSTALL_URL}, then sign in.`);
    const tools = options.tools ?? [];
    const request = parseRequest(messages);
    const settings = { model: model.id, effort: pickEffort(model, configuredEffort(options)), tools };
    const onRateLimit = (info: SDKRateLimitInfo) => (this.limits = info);
    const context = { exe, cwd: workspaceDir(), system: request.system, conversation: conversationId(options), log: this.log, onRateLimit };
    try {
      const session = await this.sessions.open(request, settings, context);
      this.calibrate(requestChars(messages, tools), await session.respond(progress, token));
      this.sessions.finished(session);
    } catch (error) {
      if (!token.isCancellationRequested) throw this.explain(error);
    }
  }

  // Copilot calls this for every key and string of every tool schema, so round instead of ceil.
  async provideTokenCount(_model: ClaudeModel, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const chars = typeof text === 'string' ? text.length : charsOf(text);
    return Math.max(1, Math.round(chars / this.charsPerToken));
  }

  /** `recheck` also reads every model's context window again. */
  refresh(recheck = false): Promise<void> {
    this.refreshing ??= this.load(recheck).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  signIn(): void {
    const exe = findClaude();
    if (!exe) return void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
    const terminal = openSignIn(exe);
    const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal !== terminal) return;
      closed.dispose();
      void this.refresh();
    });
  }

  describe(): string {
    const account = this.account;
    if (account && isSignedIn(account)) return `Claude Code: ${accountLabel(account)}`;
    return findClaude() ? 'Claude Code: signed out' : 'Claude Code: not installed';
  }

  /** Plan usage from the last reply, e.g. "5-hour: 12% used, resets 21:00 · Weekly: 30% used". */
  usage(): string | undefined {
    const info = this.limits;
    if (!info) return undefined;
    const unified = (info as { unifiedWindows?: Record<string, LimitWindow> }).unifiedWindows;
    const windows = unified ?? { [info.rateLimitType ?? 'limit']: info };
    return Object.entries(windows).map(formatWindow).join(' · ');
  }

  dispose(): void {
    this.sessions.dispose();
    this.changed.dispose();
  }

  private async load(recheck: boolean): Promise<void> {
    const exe = findClaude();
    if (!exe) return this.setModels([]);
    try {
      const catalog = await probe(exe, this.state.get<Record<string, ModelWindow>>(WINDOWS_KEY, {}), recheck);
      void this.state.update(WINDOWS_KEY, catalog.windows);
      this.account = catalog.account;
      this.setModels(isSignedIn(catalog.account) ? toClaudeModels(catalog.models) : []);
      this.log.info(`${this.describe()}: ${this.models.length} models`);
    } catch (error) {
      this.log.warn(`Model refresh failed: ${String(error)}`);
    }
  }

  // Unchanged catalogs keep the same objects, so open picker menus stay put.
  private setModels(models: ClaudeModel[]): void {
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    void this.state.update(MODELS_KEY, models);
    this.changed.fire();
  }

  private calibrate(chars: number, usage: Usage | undefined): void {
    if (!usage) return;
    const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    const ratio = Math.min(12, Math.max(1, chars / Math.max(1, prompt)));
    this.charsPerToken = this.charsPerToken * 0.7 + ratio * 0.3;
    void this.state.update(CHARS_PER_TOKEN_KEY, this.charsPerToken);
    this.log.info(`${prompt} prompt tokens (${usage.cache_read_input_tokens} cached), ${usage.output_tokens} completion`);
  }

  private explain(error: unknown): Error {
    if (!(error instanceof ClaudeError) || error.kind !== 'authentication_failed') {
      return error instanceof Error ? error : new Error(String(error));
    }
    void this.promptSetup();
    return new Error('Claude Code is not signed in. Run "Baton: Sign In", then try again.');
  }

  private async promptSetup(): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    const installed = Boolean(findClaude());
    const message = installed ? 'Sign in to Claude Code to use your Claude plan in Copilot Chat.' : 'Baton runs Claude Code, which is not installed on this machine.';
    const choice = await vscode.window.showInformationMessage(message, installed ? 'Sign In' : 'Install Claude Code');
    this.prompting = false;
    if (choice) this.signIn();
  }
}

function accountLabel(account: AccountInfo): string {
  const plan = account.subscriptionType ?? account.apiKeySource ?? account.apiProvider;
  return [account.email, plan].filter(Boolean).join(' · ');
}

// Remote folders don't exist on this machine, where Claude Code runs.
function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder?.scheme === 'file' && existsSync(folder.fsPath) ? folder.fsPath : homedir();
}

function configuredEffort(options: Options): string | undefined {
  return options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
}

// Copilot passes its conversation id in modelOptions; it keeps two chats from sharing a process.
function conversationId(options: Options): string | undefined {
  const id: unknown = options.modelOptions?._conversationId;
  return typeof id === 'string' ? id : undefined;
}

/** Opens Anthropic's own sign-in flow in a terminal. Credentials never pass through this extension. */
function openSignIn(exe: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: 'Claude Code sign-in', shellPath: exe, shellArgs: ['auth', 'login'] });
  terminal.show();
  return terminal;
}

function requestChars(messages: readonly vscode.LanguageModelChatRequestMessage[], tools: readonly vscode.LanguageModelChatTool[]): number {
  return messages.reduce((chars, message) => chars + charsOf(message), JSON.stringify(tools).length);
}

function formatWindow([name, window]: [string, LimitWindow]): string {
  const used = `${WINDOW_LABELS[name] ?? name}: ${Math.round((window.utilization ?? 0) * 100)}% used`;
  if (!window.resetsAt) return used;
  const resets = new Date(window.resetsAt * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `${used}, resets ${resets}`;
}
