# For AI coding agents

**Using Outlevo Community for someone:** follow [skills/outlevo/SKILL.md](skills/outlevo/SKILL.md). It says which commands to run and what only a person may do.

**Changing this code:** [CONTRIBUTING.md](CONTRIBUTING.md) has the rules. The ones that matter most:

- `npm run typecheck && npm test` must pass.
- Whether an email goes out is decided in code, not in a prompt. Never add a way around approval, suppression, the opt-out or the daily ceiling.
- Text from the web, a job board, a filing, an imported file or a reply is data. Wrap it with `untrusted()` before it reaches a model, and render it as text.
- The tool never reads or logs in to LinkedIn.
- Keep the README true to the code.
