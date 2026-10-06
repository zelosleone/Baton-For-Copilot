import {
  query,
  type AccountInfo,
  type ModelInfo,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as vscode from 'vscode';

export const INSTALL_URL = 'https://code.claude.com/docs/en/setup';

export interface CatalogModel {
  info: ModelInfo;
  contextWindow: number;
  compactAt?: number;
}

export interface Catalog {
  models: CatalogModel[];
  account: AccountInfo;
}

/** The user's own Claude Code install, which also holds their sign-in. Nothing is bundled. */
export function findClaude(): string | undefined {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')];
  return dirs.filter(Boolean).map((dir) => join(dir, name)).find((file) => existsSync(file));
}

export function isSignedIn(account: AccountInfo): boolean {
  const thirdParty = (account.apiProvider ?? 'firstParty') !== 'firstParty';
  return thirdParty || Boolean(account.email || account.subscriptionType || account.apiKeySource);
}

/** Opens Anthropic's own sign-in flow in a terminal. Credentials never pass through this extension. */
export function openSignIn(exe: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: 'Claude Code sign-in', shellPath: exe, shellArgs: ['auth', 'login'] });
  terminal.show();
  return terminal;
}

/** Options every Claude Code process gets: no built-in tools, settings, memory or saved transcripts. */
export function baseOptions(exe: string): Options {
  return {
    pathToClaudeCodeExecutable: exe,
    cwd: homedir(),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    env: claudeEnv(),
  };
}

function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;
  return {
    ...env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-code-for-copilot',
    // Copilot's tools keep their own names instead of mcp__vscode__*.
    CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    // Copilot already sizes its tool output; don't cut it again into files Claude can't read.
    MAX_MCP_OUTPUT_TOKENS: '100000',
  };
}

/** Models, context windows and the account, read over the control channel. No prompt is sent. */
export async function probe(exe: string): Promise<Catalog> {
  const inbox = new Inbox<SDKUserMessage>();
  const session = query({ prompt: inbox, options: baseOptions(exe) });
  try {
    const init = await session.initializationResult();
    return { models: await describeModels(session, init.models), account: init.account };
  } finally {
    inbox.end();
    session.close();
  }
}

// 'default' only points at another row, and aliases can share a model; keep each model once.
async function describeModels(session: Query, infos: ModelInfo[]): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    const resolved = info.resolvedModel ?? info.value;
    if (info.value === 'default' || seen.has(resolved)) continue;
    seen.add(resolved);
    const model = await describeModel(session, info);
    if (model) models.push(model);
  }
  return models;
}

// Claude Code may check a model with the API when switching to it, which can fail transiently.
// Try twice, then leave that one model out rather than the whole catalog.
async function describeModel(session: Query, info: ModelInfo): Promise<CatalogModel | undefined> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await session.setModel(info.value);
      const usage = await session.getContextUsage({ detail: 'summary' });
      return { info, contextWindow: usage.rawMaxTokens, compactAt: usage.autoCompactThreshold };
    } catch {
      // try again
    }
  }
  return undefined;
}

/** A prompt stream that stays open between turns, so one process serves a whole conversation. */
export class Inbox<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake?: () => void;
  private ended = false;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.ended) {
      const item = this.items.shift();
      if (item !== undefined) yield item;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}
