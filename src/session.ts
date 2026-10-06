import {
  query,
  type EffortLevel,
  type Query,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import type Anthropic from '@anthropic-ai/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { baseOptions, Inbox } from './claude.js';
import { firstPrompt, nonEmpty, resultsWithPrompt, type Block, type ChatRequest } from './convert.js';

// Quiet time is measured per chat: a chat stays active while any of its sessions (its subagents and
// side requests included) is talking to Claude Code or Copilot.
// Finished sessions kept around for a follow-up, closed once their chat has been quiet for 10 minutes.
const MAX_IDLE_SESSIONS = 2;
const IDLE_MS = 10 * 60 * 1000;
// Nothing mid-turn is ever timed out: a reply can think for as long as it needs, and a tool call or
// subagent can take any time. Mid-turn sessions whose chat has gone silent for 30 minutes are most
// likely left over from a stopped turn, so only those are capped, keeping the two most recent.
const PARKED_MS = 30 * 60 * 1000;
const MAX_PARKED_SESSIONS = 2;
const RELIST_TIMEOUT_MS = 5000;
const DEFAULT_SYSTEM = 'You are Claude, a helpful assistant running inside VS Code.';
// Copilot's tool that runs a subagent: a nested conversation with the same chat id and its own system prompt.
const SUBAGENT_TOOL = 'runSubagent';

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];
type ContentBlock = Extract<StreamEvent, { type: 'content_block_start' }>['content_block'];
type Delta = Extract<StreamEvent, { type: 'content_block_delta' }>['delta'];
type Progress = vscode.Progress<vscode.LanguageModelResponsePart>;
type State = 'busy' | 'awaiting' | 'idle' | 'closed';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface SessionSettings {
  model: string;
  effort?: EffortLevel;
  tools: readonly vscode.LanguageModelChatTool[];
}

export interface SessionContext {
  exe: string;
  /** Claude Code tells the model this is its working directory, so it should match Copilot's workspace. */
  cwd: string;
  system: string;
  conversation?: string;
  log: vscode.LogOutputChannel;
  onRateLimit(info: SDKRateLimitInfo): void;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly kind?: SDKAssistantMessageError,
  ) {
    super(message);
  }
}

/**
 * One Claude Code process per Copilot conversation. Copilot's tools are served to it over an
 * in-process MCP server; when Claude calls one, the reply hands the call to Copilot and the
 * process waits until Copilot's next request brings the result.
 */
export class Session {
  state: State = 'busy';
  responses = 0;
  lastCalls: string[] = [];
  /** Copilot's tools behind lastCalls. */
  lastTools: string[] = [];
  lastText = '';
  lastActive = Date.now();
  private settings: SessionSettings;
  private readonly inbox = new Inbox<SDKUserMessage>();
  private readonly server = new McpServer({ name: 'vscode', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  private readonly query: Query;
  private readonly messages: AsyncIterator<SDKMessage>;
  private readonly waiting = new Map<string, (result: CallToolResult) => void>();
  private readonly ready = new Map<string, CallToolResult>();
  private relisted?: () => void;
  private oneShot = false;

  constructor(
    private readonly context: SessionContext,
    settings: SessionSettings,
  ) {
    this.settings = settings;
    this.server.server.setRequestHandler(ListToolsRequestSchema, () => this.listTools());
    this.server.server.setRequestHandler(CallToolRequestSchema, (request) => this.callTool(request));
    this.query = query({
      prompt: this.inbox,
      options: {
        ...baseOptions(context.exe),
        cwd: context.cwd,
        model: settings.model,
        effort: settings.effort,
        systemPrompt: context.system || DEFAULT_SYSTEM,
        mcpServers: { vscode: { type: 'sdk', name: 'vscode', instance: this.server } },
        includePartialMessages: true,
        // Copilot composed these prompts: no @file expansion, no slash commands.
        verbatimPrompts: true,
        // Copilot asks the user before running its tools; here they are only relayed.
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        title: 'GitHub Copilot Chat',
        stderr: (data) => context.log.debug(data.trim()),
      },
    });
    this.messages = this.query[Symbol.asyncIterator]();
  }

  get conversation(): string | undefined {
    return this.context.conversation;
  }

  get system(): string {
    return this.context.system;
  }

  /** Whether this session's turn is waiting on a subagent Copilot is running for it. */
  awaitsSubagent(): boolean {
    return this.state === 'awaiting' && this.lastTools.includes(SUBAGENT_TOOL);
  }

  /** Whether this process already holds everything in the request except its new tail. */
  continues(request: ChatRequest, conversation: string | undefined): boolean {
    if (request.fork || !this.sameChat(request, conversation)) return false;
    return request.results ? this.awaits(request) : this.idleAfter(request);
  }

  start(request: ChatRequest): void {
    // A replayed history already holds this many replies, so the next request counts on from here.
    this.responses = request.assistantCount;
    // Nothing ever follows up on a side request, so its process goes as soon as it has answered.
    this.oneShot = request.fork;
    this.send(firstPrompt(request));
  }

  async resume(request: ChatRequest, settings: SessionSettings): Promise<void> {
    this.state = 'busy';
    this.lastActive = Date.now();
    this.context.log.info(`${settings.model}: continuing with ${request.results ? 'tool results' : 'a new turn'}`);
    await this.apply(settings);
    if (request.results) this.deliver(resultsWithPrompt(request.results, request.prompt));
    else this.send(nonEmpty(request.prompt));
  }

  /** Streams one Copilot response: until Claude waits on Copilot's tools or its turn ends. */
  async respond(progress: Progress, token: vscode.CancellationToken): Promise<Usage | undefined> {
    const tools = new Set(this.settings.tools.map((tool) => tool.name));
    const reply = new Reply(progress, tools, this.context.onRateLimit);
    const cancel = token.onCancellationRequested(() => this.close());
    if (token.isCancellationRequested) this.close();
    try {
      while (!reply.done) reply.handle(await this.next());
    } catch (error) {
      this.close();
      throw error;
    } finally {
      cancel.dispose();
    }
    this.settle(reply);
    return reply.usage;
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const resolve of this.waiting.values()) resolve(errorResult('The session ended before this tool ran.'));
    this.waiting.clear();
    this.inbox.end();
    this.query.close();
  }

  private sameChat(request: ChatRequest, conversation: string | undefined): boolean {
    const sameConversation = !conversation || !this.conversation || conversation === this.conversation;
    return sameConversation && this.context.system === request.system && this.responses === request.assistantCount;
  }

  private awaits(request: ChatRequest): boolean {
    const answered = this.lastCalls.every((id) => request.results?.has(id));
    return this.state === 'awaiting' && answered && sameIds(this.lastCalls, request.lastCalls);
  }

  private idleAfter(request: ChatRequest): boolean {
    const sameReply = request.lastCalls.length === 0 && request.lastText.trim() === this.lastText.trim();
    return this.state === 'idle' && sameReply;
  }

  // Model, effort and tool changes apply to the live process instead of starting over.
  private async apply(settings: SessionSettings): Promise<void> {
    const previous = this.settings;
    this.settings = settings;
    if (settings.model !== previous.model) await this.query.setModel(settings.model);
    if (settings.effort !== previous.effort) await this.query.applyFlagSettings({ effortLevel: settings.effort ?? null });
    if (toolsKey(settings.tools) !== toolsKey(previous.tools)) await this.relist();
  }

  private async relist(): Promise<void> {
    const relisted = new Promise<void>((resolve) => (this.relisted = resolve));
    await this.server.server.sendToolListChanged();
    await Promise.race([relisted, new Promise((resolve) => setTimeout(resolve, RELIST_TIMEOUT_MS))]);
  }

  private listTools(): ListToolsResult {
    this.relisted?.();
    this.relisted = undefined;
    // alwaysLoad keeps every tool in the prompt instead of behind Claude Code's tool search.
    const tools = this.settings.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const, ...tool.inputSchema },
      _meta: { 'anthropic/alwaysLoad': true },
    }));
    return { tools };
  }

  // Claude Code waits here until Copilot has run the tool and sent its result.
  private callTool(request: CallToolRequest): Promise<CallToolResult> {
    const id = request.params._meta?.['claudecode/toolUseId'];
    if (typeof id !== 'string') return Promise.resolve(errorResult('This tool call has no id to match a result to.'));
    const ready = this.ready.get(id);
    this.ready.delete(id);
    return ready ? Promise.resolve(ready) : new Promise((resolve) => this.waiting.set(id, resolve));
  }

  // Claude Code runs tool calls one after another, so later results wait in `ready`.
  private deliver(results: Map<string, Block[]>): void {
    this.ready.clear();
    for (const [id, blocks] of results) {
      const result = toToolResult(blocks);
      const resolve = this.waiting.get(id);
      this.waiting.delete(id);
      if (resolve) resolve(result);
      else this.ready.set(id, result);
    }
  }

  private send(content: Block[]): void {
    this.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }

  private async next(): Promise<SDKMessage> {
    const result = await this.messages.next();
    if (result.done) throw new Error('Claude Code stopped before finishing the reply.');
    this.lastActive = Date.now();
    return result.value;
  }

  private settle(reply: Reply): void {
    this.responses++;
    this.lastCalls = reply.calls;
    this.lastTools = reply.tools;
    this.lastText = reply.text;
    this.lastActive = Date.now();
    this.state = reply.calls.length > 0 ? 'awaiting' : 'idle';
    if (this.oneShot) this.close();
  }
}

/** One Copilot response, built from Claude Code's stream. */
class Reply {
  text = '';
  readonly calls: string[] = [];
  readonly tools: string[] = [];
  done = false;
  usage?: Usage;
  private kind?: SDKAssistantMessageError;
  private stopReason?: string | null;
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();

  constructor(
    private readonly progress: Progress,
    private readonly copilotTools: ReadonlySet<string>,
    private readonly onRateLimit: (info: SDKRateLimitInfo) => void,
  ) {}

  handle(message: SDKMessage): void {
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) this.onEvent(message.event);
    else if (message.type === 'assistant') this.kind = message.error ?? this.kind;
    else if (message.type === 'rate_limit_event') this.onRateLimit(message.rate_limit_info);
    else if (message.type === 'result') this.onResult(message);
  }

  private onEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'message_start':
        return this.addUsage(event.message.usage);
      case 'message_delta':
        this.stopReason = event.delta.stop_reason;
        return this.addUsage(event.usage);
      case 'content_block_start':
        return this.startBlock(event.index, event.content_block);
      case 'content_block_delta':
        return this.onDelta(event.index, event.delta);
      case 'content_block_stop':
        return this.endBlock(event.index);
      case 'message_stop':
        return this.endMessage();
    }
  }

  private startBlock(index: number, block: ContentBlock): void {
    if (block.type === 'tool_use') this.blocks.set(index, { id: block.id, name: block.name, json: '' });
  }

  private onDelta(index: number, delta: Delta): void {
    if (delta.type === 'text_delta') {
      this.text += delta.text;
      this.progress.report(new vscode.LanguageModelTextPart(delta.text));
    } else if (delta.type === 'input_json_delta') {
      const block = this.blocks.get(index);
      if (block) block.json += delta.partial_json;
    }
  }

  // Only Copilot's tools go back to Copilot; Claude Code answers anything else itself.
  private endBlock(index: number): void {
    const block = this.blocks.get(index);
    if (!block) return;
    this.blocks.delete(index);
    const name = block.name.replace(/^mcp__vscode__/, '');
    if (!this.copilotTools.has(name)) return;
    this.calls.push(block.id);
    this.tools.push(name);
    this.progress.report(new vscode.LanguageModelToolCallPart(block.id, name, parseInput(block.json)));
  }

  private endMessage(): void {
    if (this.stopReason === 'tool_use' && this.calls.length > 0) this.finish();
  }

  private onResult(result: SDKResultMessage): void {
    if (result.is_error) throw new ClaudeError(resultText(result), this.kind);
    this.finish();
  }

  private addUsage(usage: { [K in keyof Usage]?: number | null }): void {
    const next: Usage = this.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const key of Object.keys(next) as (keyof Usage)[]) next[key] = usage[key] ?? next[key];
    this.usage = next;
  }

  private finish(): void {
    this.done = true;
    if (!this.usage) return;
    const { input_tokens, output_tokens, cache_read_input_tokens: cached, cache_creation_input_tokens } = this.usage;
    const prompt = input_tokens + cached + cache_creation_input_tokens;
    // Copilot reads this data part to drive its context window indicator.
    const usage = { prompt_tokens: prompt, completion_tokens: output_tokens, total_tokens: prompt + output_tokens, prompt_tokens_details: { cached_tokens: cached } };
    this.progress.report(vscode.LanguageModelDataPart.json(usage, 'usage'));
  }
}

/** Live conversations, most recent first. Each holds a Claude Code process (~180 MB), so keep few. */
export class Sessions implements vscode.Disposable {
  private sessions: Session[] = [];
  private readonly timer = setInterval(() => this.sweep(), 60_000);

  constructor() {
    this.timer.unref();
  }

  /** Continues the live session that holds this conversation, or starts one that replays it. */
  async open(request: ChatRequest, settings: SessionSettings, context: SessionContext): Promise<Session> {
    const live = this.sessions.find((session) => session.continues(request, context.conversation));
    const session = live ?? create(request, settings, context);
    // resume() marks the session busy before its first await, so the sweep below spares it.
    const resumed = live?.resume(request, settings);
    this.sessions = [session, ...this.sessions.filter((other) => other !== session)];
    this.sweep();
    try {
      await resumed;
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }

  /**
   * A subagent's process goes as soon as it has answered: nothing ever follows up on it, and its chat
   * is the one waiting on it. Without this it would hold its ~180 MB until it aged out.
   */
  finished(session: Session): void {
    if (session.state !== 'idle' || session.conversation === undefined) return;
    const parent = this.sessions.find((other) => other.conversation === session.conversation && other.system !== session.system && other.awaitsSubagent());
    if (parent) session.close();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const session of this.sessions) session.close();
    this.sessions = [];
  }

  private sweep(): void {
    const now = Date.now();
    const chats = chatActivity(this.sessions);
    let idle = 0;
    let parked = 0;
    for (const session of this.sessions) {
      const quietMs = now - (chats.get(session.conversation) ?? session.lastActive);
      if (session.state === 'idle') idle++;
      if (session.state === 'awaiting' && quietMs > PARKED_MS) parked++;
      if (expired(session.state, quietMs, idle, parked)) session.close();
    }
    this.sessions = this.sessions.filter((session) => session.state !== 'closed');
  }
}

// Each chat's latest activity across its sessions; sessions without a chat id stand alone.
function chatActivity(sessions: Session[]): Map<string | undefined, number> {
  const chats = new Map<string | undefined, number>();
  for (const { conversation, lastActive } of sessions) {
    if (conversation) chats.set(conversation, Math.max(chats.get(conversation) ?? 0, lastActive));
  }
  return chats;
}

// Ranks count finished and parked sessions, most recent first. Busy sessions are never closed here.
function expired(state: State, quietMs: number, idleRank: number, parkedRank: number): boolean {
  if (state === 'idle') return idleRank > MAX_IDLE_SESSIONS || quietMs > IDLE_MS;
  return state === 'awaiting' && quietMs > PARKED_MS && parkedRank > MAX_PARKED_SESSIONS;
}

// A conversation that no longer lines up with a live process (edited, retried, summarized,
// or after a reload) starts over in a new one; stale ones age out of the pool.
function create(request: ChatRequest, settings: SessionSettings, context: SessionContext): Session {
  const kind = request.fork ? 'one-off session for background compaction' : 'session';
  context.log.info(`${settings.model}: new ${kind}, replaying ${request.history.length} earlier messages`);
  const session = new Session(context, settings);
  session.start(request);
  return session;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function toolsKey(tools: readonly vscode.LanguageModelChatTool[]): string {
  return JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.inputSchema]));
}

function toToolResult(blocks: Block[]): CallToolResult {
  const content = blocks.map(toContent);
  return { content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }] };
}

function toContent(block: Block): CallToolResult['content'][number] {
  if (block.type === 'text') return { type: 'text', text: block.text };
  const source = block.source as Anthropic.Base64ImageSource;
  return { type: 'image', data: source.data, mimeType: source.media_type };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function parseInput(json: string): object {
  try {
    return JSON.parse(json || '{}') as object;
  } catch {
    return {};
  }
}

function resultText(result: SDKResultMessage): string {
  const text = result.subtype === 'success' ? result.result : result.errors.join('; ');
  return text || `Claude Code ended the turn with ${result.subtype}.`;
}
