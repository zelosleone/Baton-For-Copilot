import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk/core';
import type * as vscode from 'vscode';
import type { CatalogModel } from './claude.js';

interface EffortSchema {
  properties: { reasoningEffort: { enum: string[]; default: string } & Record<string, unknown> };
}

export type ClaudeModel = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
  readonly configurationSchema?: EffortSchema;
};

const LABELS: Record<string, string> = { xhigh: 'Extra High' };

export function toClaudeModels(models: CatalogModel[]): ClaudeModel[] {
  return models.map(toClaudeModel);
}

function toClaudeModel({ info, contextWindow, compactAt }: CatalogModel): ClaudeModel {
  const resolved = info.resolvedModel ?? info.value;
  // Copilot's BYOK convention is window minus output reservation; Claude Code keeps the
  // same headroom before it compacts, so its threshold is the prompt budget.
  const budget = compactAt !== undefined && compactAt > 0 ? compactAt : Math.round(contextWindow * 0.9);
  const maxInputTokens = Math.min(contextWindow, budget);
  return {
    id: info.value,
    name: `Claude ${info.displayName || info.value}`,
    // A claude-* family gets Copilot's Claude-tuned prompts and edit tools.
    family: resolved,
    version: resolved,
    detail: 'via Claude Code',
    tooltip: info.description,
    maxInputTokens,
    maxOutputTokens: contextWindow - maxInputTokens,
    capabilities: { toolCalling: true, imageInput: true },
    isBYOK: true,
    configurationSchema: effortSchema(info.supportedEffortLevels ?? []),
  };
}

// Effort as an in-picker option. 'auto' sends nothing and keeps Claude Code's default for the model.
function effortSchema(levels: string[]): EffortSchema | undefined {
  if (levels.length === 0) return undefined;
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        enum: ['auto', ...levels],
        enumItemLabels: ['Auto', ...levels.map((level) => LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1))],
        default: 'auto',
        group: 'navigation',
      },
    },
  };
}

/** The picked effort if the model still offers it, else its default; 'auto' sends nothing. */
export function pickEffort(model: ClaudeModel, configured: string | undefined): EffortLevel | undefined {
  const schema = model.configurationSchema?.properties.reasoningEffort;
  if (!schema) return undefined;
  const value = configured !== undefined && schema.enum.includes(configured) ? configured : schema.default;
  return value === 'auto' ? undefined : (value as EffortLevel);
}
