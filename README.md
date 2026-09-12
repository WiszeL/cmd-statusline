# cmd-statusline

A [Command Code](https://commandcode.ai/docs/mods) mod that paints a live status line under the input panel.

```
deepseek-v4.1-flash | high | [████████░░] 124K/1M 12% | In: 1.2M (Miss: 34K ; Hit: 90K) | Out: 1,840 | $0.014
```

- **model** — short name of the live model (from the session transcript, so it follows `/model` and mod-driven switches)
- **effort** — the effort level of the latest request
- **context** — 10-char bar, current / max, and percentage of the model's context window (current turn)
- **in** — cumulative input tokens for the session, with the current turn's miss/hit split
- **miss / hit** — prompt tokens not served from cache vs. served from cache (includes cache writes)
- **out** — cumulative output tokens for the session
- **cost** — cumulative cost (provider-reported, or estimated from built-in rates)

Token counts come straight from the provider's API response — they are exact, not estimates.

## Install

```bash
cmd mods add -g WiszeL/cmd-statusline
```

Then `/reload` in a running session, or start a new one. Pin a release with `@v1.0.0`; update with `cmd mods update`.

If you previously dropped `statusline.ts` into `~/.commandcode/mods/` by hand, delete that copy first — two mods with the same name collide.

## License

MIT
