# Ship Sentinel: design

## Problem

Pre-ship checks written as skills only help if Claude loads them at the right moment. Descriptions
trigger on a best-effort basis, so the check that matters most (the one before a push or a deploy)
is the one that gets skipped when the session is busy. A mod can see the moment; a skill cannot.

## Decision: mod, skill, or both

Ran the three tests from `skill-to-mod`:

- Moment: yes. A Bash `tool.call` whose command is a ship command.
- Reliability: yes. A skipped check costs a bad deploy.
- Face: not needed. A question and a status line are enough.

So: **HYBRID.** The checklist stays a skill (`release-gate` and friends). The mod does one thing,
it makes sure those skills ran. No check logic is copied into the hooks module, so the checks can
change without touching the mod.

## Hooks

| Event | Matcher | Job | Fails |
| --- | --- | --- | --- |
| `session.start` | none | register `/ship-sentinel` | skipped |
| `skill.prompt` | none | add the skill to the "has run" set, reset holds, update the status line | skipped |
| `tool.call` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | after a successful edit, clear the set (checks are stale) | open |
| `tool.call` | `Bash` | the gate | open |
| `prompt.submit` | none | one line of context when the prompt says "ship it" and checks are outstanding | open |
| `command.run` | `ship-sentinel` | state, `off`, `on` | n/a |

### State

Four module variables: `done` (set of skill names), `acknowledged` (user chose "Ship anyway"),
`holds` (count since the last skill or edit) and `snoozed`. They live and die with the module, so
a reload starts clean, which errs towards asking again. Nothing is persisted.

### The gate, in order

1. Mode off, snoozed, nothing required, or not a ship command: pass.
2. Nothing missing, or the user already chose "Ship anyway" since the last edit: pass.
3. `holds >= 2`: pass with a toast. This is the escape valve.
4. `nudge`: run it, then add a context line.
5. `ask`: `$.ui.ask` with two options. "Ship anyway" sets `acknowledged` and passes.
6. Otherwise `holds += 1` and `{ deny: instruction }`. The instruction is written for Claude: what is
   missing, what to do, and what to do if the skill does not exist (tell the user, do not loop).

### Skill names

`skill.prompt` reports `name`, or `plugin:name` for a plugin's skill. `sameSkill` accepts both, so
`release-gate` matches `my-plugin:release-gate`. A required entry written with a prefix must match
exactly.

## Why these choices

**Fail open.** A guard that can wedge a session gets uninstalled. Every hook has a `.catch` that
passes the event on, the holds valve caps the damage of a missing skill, and the snooze command
needs no restart.

**Smallest trust surface.** Mods are unsandboxed code. This one calls `$.command.register`,
`$.ui.ask`, `$.ui.status` and `$.ui.toast`, and nothing else: no files, processes, network,
environment variables or model calls. The validator prints the same list, and the README block is
generated from it.

**Never approve for the user.** It does not hook `tool.check` and cannot return `allow`. The worst
it does is ask a question or refuse a command with a reason.

**A reminder, not a control.** It matches command text with regular expressions. That is fine for
"remember to run the checks" and wrong for "prevent shipping". Say so wherever the mod is described.

## Overlap

Anthropic's `blast-radius` sample holds a risky command and shows what it would change. Ship
Sentinel holds a ship command and asks whether the checks ran. Different question, similar
mechanism. Running both together has not been tried. Ship Sentinel needs no process access, which
keeps it easy to read.

## Known limits

- "Loaded" is not "passed". A skill that was expanded and then ignored counts as run.
- Commands wrapped in scripts (`./deploy.sh`, `make release`) are not recognised. Add patterns for the
  ones you use.
- Only Bash is watched. A ship done through an MCP tool or a GitHub connector is not.
- Not tested with subagents. `skill.prompt` also fires for skills preloaded into a subagent, but
  whether a subagent's own shell calls reach this gate has not been checked.

## Ideas for v1

1. **Receipts instead of "loaded".** The check skill ends by writing a small file (commit hash plus
   result); the mod reads it. This costs a `$.fs.read` call, so it widens the trust surface by one
   line, and it makes "passed" checkable.
2. **A band above the prompt** showing outstanding checks (`ui.render` on `AbovePrompt`), so the state
   is visible before Claude tries to ship.
3. **Per-repository settings** via `$.store` or a project file, so a docs repo and a service repo can
   require different skills.
4. **More check skills** as defaults, for example pre-ship security, performance and preflight
   skills. The names in the original brief were not verified against real skills, so they are not
   defaults in v0.1.

## Verification

`claude plugin validate` passes with the hooks and calls listed in the README. `claude plugin test`
runs 21 tests: every ship command pattern, plugin-prefixed names, several required skills, stale
after edit, the holds valve, both `ask` answers, `nudge`, `off`, the command, and prompt priming.
