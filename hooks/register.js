// Ship Sentinel: makes the right pre-ship checks happen at the moment Claude is
// about to ship. The checks themselves are skills; this mod is only the trigger.
//
//   skill.prompt          notes which check skills have been expanded (typed as
//                         /name, run by the Skill tool, or preloaded by a subagent)
//   tool.call (Edit...)   a successful edit makes earlier checks stale
//   tool.call (Bash)      a ship command with checks outstanding is held, refused
//                         or flagged, depending on `mode`
//   prompt.submit         a prompt like "ship it" gets one line of context for Claude
//   command.run           /ship-sentinel shows state; /ship-sentinel off|on snoozes it
//
// Reminder, not a security boundary: it reads the text of a command, so it fails
// open. It touches no files, processes, network or environment variables.

const NAME = 'ship-sentinel'
const MAX_HOLDS = 2

// Commands that put work in front of other people or into production.
const SHIP = [
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+(create|merge)\b/,
  /\bgh\s+release\s+create\b/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bwrangler\s+(pages\s+)?(deploy|publish)\b/,
  /\bvercel\b.*\s--prod\b/,
  /\bnetlify\s+deploy\b.*--prod\b/,
  /\bdocker\s+push\b/,
  /\bdotnet\s+nuget\s+push\b/,
  /\b(cdk|sam)\s+deploy\b/,
  /\bterraform\s+apply\b/,
]

// Prompts that say the person is about to ship.
const PRIME = /\b(ship it|ship this|deploy (it|this|to prod\w*)|go live|push to prod\w*|cut a release|publish (it|this))\b/i

// What has happened since the last edit. Module variables start over on a reload.
const done = new Set()
let acknowledged = false
let holds = 0
let snoozed = false

function isShip(command) {
  return SHIP.some((re) => re.test(command))
}

function listRequired(options) {
  const raw = typeof options.required === 'string' ? options.required : 'release-gate'
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

// A skill reaches skill.prompt as `name`, or `plugin:name` for a plugin's skill.
function sameSkill(seen, wanted) {
  return seen === wanted || seen.endsWith(':' + wanted)
}

export function register(on, options) {
  const mode = typeof options.mode === 'string' ? options.mode : 'ask'
  const required = listRequired(options)

  function outstanding() {
    return required.filter((name) => !done.has(name))
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship-sentinel',
      description: 'Show Ship Sentinel state, or snooze it with "off" and resume it with "on"',
      argumentHint: '[off|on]',
      immediate: true,
    })
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    for (const name of required) {
      if (sameSkill(e.skill, name)) {
        done.add(name)
        holds = 0
      }
    }
    $.ui.status(outstanding().length === 0 ? undefined : NAME + ': ' + outstanding().join(', ') + ' still to run')
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    const changed = ran.deny === undefined && ran.isError !== true
    if (changed && (done.size > 0 || acknowledged)) {
      done.clear()
      acknowledged = false
      holds = 0
      $.ui.status(NAME + ': checks are stale after edits (' + required.join(', ') + ')')
    }
    return ran
  }).catch(($, e, next) => next(e)) // fail open: a reminder must never block an edit

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    if (mode === 'off' || snoozed || required.length === 0 || !isShip(command)) {
      return next(e)
    }
    const missing = outstanding()
    if (missing.length === 0 || acknowledged) {
      return next(e)
    }
    // Never trap the session: after a couple of holds, let the command through.
    if (holds >= MAX_HOLDS) {
      $.ui.toast(NAME + ': let it through after ' + MAX_HOLDS + ' holds')
      return next(e)
    }
    const instruction =
      NAME + ' held this command: ' + missing.join(', ') + ' has not run since the last edit. ' +
      'Run ' + (missing.length === 1 ? 'that skill' : 'those skills') + ' on the current changes, fix what they find, then retry. ' +
      'If a skill is not available, tell the user instead of retrying.'

    if (mode === 'nudge') {
      const ran = await next(e)
      if (ran.deny !== undefined) {
        return ran
      }
      return { ...ran, context: [...(ran.context ?? []), NAME + ': that ran before ' + missing.join(', ') + ' had run since the last edit. Run ' + (missing.length === 1 ? 'it' : 'them') + ' now.'] }
    }

    if (mode === 'ask') {
      // A question nobody answers counts as "run the checks first".
      let answer = 'Run checks first'
      try {
        answer = await $.ui.ask(
          missing.join(', ') + ' has not run since the last edit. Run this anyway? ' + command.slice(0, 120),
          ['Run checks first', 'Ship anyway'],
        )
      } catch {
        // dismissed, or nobody is there to ask
      }
      if (answer === 'Ship anyway') {
        acknowledged = true
        return next(e)
      }
    }

    holds += 1
    return { deny: instruction }
  }).catch(($, e, next) => next(e)) // fail open: if the guard breaks, the command runs as it would without it

  on('prompt.submit', async ($, e, next) => {
    if (mode === 'off' || snoozed || required.length === 0 || outstanding().length === 0 || !PRIME.test(e.text)) {
      return next(e)
    }
    const line = NAME + ': before shipping, run ' + outstanding().join(', ') + ' on the current changes.'
    return next({ ...e, context: [...(e.context ?? []), line] })
  }).catch(($, e, next) => next(e)) // fail open

  on('command.run', { command: 'ship-sentinel' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'off') {
      snoozed = true
      $.ui.status(undefined)
      return { text: NAME + ': snoozed. Run /ship-sentinel on to resume.' }
    }
    if (arg === 'on') {
      snoozed = false
      return { text: NAME + ': back on.' }
    }
    const left = outstanding()
    return {
      text:
        NAME + ' (' + mode + (snoozed ? ', snoozed' : '') + '): ' +
        (required.length - left.length) + ' of ' + required.length + ' checks run since the last edit' +
        (left.length > 0 ? ', still to run: ' + left.join(', ') : '') +
        (acknowledged ? '. Shipping was acknowledged.' : '.'),
    }
  })
}
