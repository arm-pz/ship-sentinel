# ship-sentinel

A Claude Code mod that holds `git push`, PR, publish and deploy commands until your pre-ship check skills have run since your last edit. Use it when your checks are written as skills (a security pass, a performance audit, a preflight) and Claude sometimes skips them before shipping. The checks stay skills; the mod is only the trigger. It asks, blocks or nudges, fails open, and touches no files, network or processes.

Install: `/plugin install ship-sentinel --marketplace arm-pz/ship-sentinel`

Then tell it which skills count as your checks: `/plugin configure ship-sentinel@ship-sentinel`, for example `pre-ship-security-red-team,pre-ship-performance-audit`. The default is `release-gate`, which only does something if you have a skill with that name.

Needs Claude Code 2.1.287 or later (mods). Tested on 2.1.306.

It reacts to things like:

- Claude running `git push origin main`, `gh pr create`, `npm publish`, `wrangler deploy`, `terraform apply`
- You writing "ship it", "go live" or "deploy to prod"
- Claude editing a file after the checks have run (the checks are then stale)

Ship Sentinel contains no checks of its own. Skills such as `pre-ship-security-red-team`, `pre-ship-performance-audit` and `web-preflight` from [skills.caffeinity.com](https://skills.caffeinity.com) are the kind of check it is built to trigger; any skill name works. To turn a skill of your own into a mod like this one, see [skill-to-mod](https://github.com/arm-pz/skill-to-mod).

## What it does

| Moment | What happens |
| --- | --- |
| Claude runs a ship command (`git push`, `gh pr create`/`merge`, `gh release create`, `npm`/`pnpm`/`yarn`/`bun publish`, `wrangler deploy`, `vercel --prod`, `netlify deploy --prod`, `docker push`, `dotnet nuget push`, `cdk`/`sam deploy`, `terraform apply`) and a required skill has not run since the last edit | Depends on the mode below |
| A required skill is expanded (typed as `/name`, run by the Skill tool, or preloaded by a subagent) | It counts as run |
| Claude edits a file after checks have run | Checks go stale and must run again |
| You write "ship it", "go live", "deploy to prod" and so on | One line tells Claude which checks are outstanding |

Modes, set with `/plugin configure ship-sentinel@ship-sentinel`:

- `ask` (default): the command is held and you pick **Run checks first** or **Ship anyway**.
  Not answering counts as "Run checks first".
- `block`: the command is refused with an instruction to run the checks, then retry.
- `nudge`: the command runs; Claude is reminded afterwards.
- `off`: does nothing.

`/ship-sentinel` shows the state. `/ship-sentinel off` snoozes it for the session and
`/ship-sentinel on` brings it back. **All** the required skills must have run since the last edit.

## Install

```
/plugin install ship-sentinel --marketplace arm-pz/ship-sentinel
```

The same from a shell (Claude Code 2.1.292 or later):

```
claude plugin install ship-sentinel --marketplace arm-pz/ship-sentinel
```

Or in two steps: `claude plugin marketplace add arm-pz/ship-sentinel`, then `claude plugin install ship-sentinel@ship-sentinel`.

To try it for one session from a clone: `claude --plugin-dir ./ship-sentinel`, then `/plugin` should show the mod as active.

## It is a reminder, not a security boundary

- It reads the text of a Bash command. `echo "git push"` also matches, and a rewritten or indirect
  command can slip past. For enforcement, use permission rules or managed settings.
- It fails open. If a hook breaks, the command runs as it would without the mod.
- It can never trap a session: after two holds it lets the command through and shows a toast.
- "Run" means the skill was *loaded*, not that it passed. See `DESIGN.md` for the receipts idea.
- It watches Bash commands only. A ship done through an MCP tool is not seen.
- Panes and toasts draw only where mods draw (terminal, Desktop Code tab, VS Code). `claude -p`
  runs the hooks but nothing is shown, so use `block` there. An organisation can switch user mods
  off.

## What it can reach

Mods run inside Claude Code with your permissions and are not sandboxed, so this is spelled out.
This block is written by `verify_mod.py` from the validator's output.

<!-- trust:start -->
```text
hooks: ./register.js session.start, skill.prompt, tool.call{tool=Edit|Write|MultiEdit|NotebookEdit}, tool.call{tool=Bash}, prompt.submit, command.run{command=ship-sentinel}
calls: ./register.js $.command.register, $.ui.ask, $.ui.status, $.ui.toast
```
<!-- trust:end -->

## Tests

```
claude plugin test ./ship-sentinel
```

21 tests use Claude Code's test kit, which stands in for Claude Code. They show the hooks do what they should; they do not replace trying the mod in a live session.

## Licence

See `LICENSE`.
