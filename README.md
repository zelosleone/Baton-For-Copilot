# Baton

Use your own Claude Pro or Max plan in GitHub Copilot Chat. Baton runs Claude Code, Anthropic's CLI, on your machine and puts its models in Copilot's model picker.

1. Install [Claude Code](https://code.claude.com/docs/en/setup) and sign in: run `claude`, or **Baton: Sign In to Claude Code**.
2. Pick a Claude model in the Copilot Chat model picker, and its thinking effort next to it.

Copilot keeps its own agent, tools, approvals and diffs; Claude is the model behind them. Models, context windows and effort levels come from Claude Code. **Baton: Manage** shows your account and plan usage.

## Fast and light

- Each chat runs in one Claude Code process that stays alive between turns, so tool rounds don't resend the conversation and prompt caching works.
- A finished chat keeps its process for 10 minutes (two at most), and a running agent for as long as it needs. A subagent's process stops as soon as it has answered.
- Startup reads the model list in about a second. Each model's context window is checked once a week, not on every start (Refresh Models in **Baton: Manage** checks them all again).

## Your account

Baton runs the unmodified Claude Code you installed. You sign in through Claude Code's own flow, Baton never sees your credentials, and usage counts against your own plan under Anthropic's terms.

## Development

```sh
npm install
npm run compile   # type check + esbuild bundle
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
npm run package   # builds the .vsix
```

Unofficial, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
