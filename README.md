# Claude Code for Copilot

Use your own Claude Pro or Max plan in GitHub Copilot Chat. Requests go through the Claude Code CLI on your machine, signed in with your own account. No API key, and this extension never sees your credentials.

1. Install [Claude Code](https://code.claude.com/docs/en/setup) and sign in: run `claude`, or **Claude Code: Sign In**.
2. Pick a Claude model in the Copilot Chat model picker.
3. Set its thinking effort right in the picker.

Copilot keeps its own agent, tools, approvals and diffs; Claude is the model behind them. Each conversation runs in one Claude Code process that stays alive between turns, so tool rounds don't resend the conversation and prompt caching works. If the history no longer lines up (an edited message, summarization, a reload), a new process picks up from a replayed transcript. A finished chat keeps its process for 10 minutes (two at most); a running agent keeps it until its chat, subagents included, has been silent for 30 minutes.

Models, context windows and effort levels come live from Claude Code. **Claude Code: Manage** shows the signed-in account and plan usage, and can refresh models or open the logs.

This is for running your own subscription for your own work. Anthropic doesn't allow third-party products to offer Claude.ai sign-in or plan limits to their users, so don't redistribute it as one.

## Development

```sh
npm install
npm run compile   # type check + esbuild bundle
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
npm run package   # builds the .vsix
```

Every push to `main` runs the same checks in GitHub Actions and attaches the `.vsix` to the release for the version in `package.json`. Bump the version to keep the previous build as its own release.

Unofficial, not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.
