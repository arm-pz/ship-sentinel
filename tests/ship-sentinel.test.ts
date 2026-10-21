import { expect, test } from 'claude-code/testing'

const SHIP = 'git push origin main'

// Stands in for Claude Code beneath the mod: every tool "runs" and answers ok,
// and a question to the user (AskUserQuestion) is answered from `answer`.
function engine(on: any, answer: { value: string } = { value: 'Run checks first' }) {
  on('tool.call', ($: any, e: any) =>
    e.tool === 'AskUserQuestion'
      ? { result: { answers: { [e.questions[0].question]: answer.value } } }
      : { result: 'ok' },
  )
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('block: a ship command is refused until the check skill has run', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  const held = await $.tool.call({ tool: 'Bash', command: SHIP })
  expect(held.deny).toMatch(/release-gate/)

  await $.skill.prompt({ skill: 'release-gate', text: 'checks' })
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
})

test('block: commands that do not ship are never held', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  expect(await $.tool.call({ tool: 'Bash', command: 'git status && ls' })).toEqual({ result: 'ok' })
  expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toEqual({ result: 'ok' })
})

// One test for each command: the two-holds safety valve is session-wide, so a
// shared session would correctly let the third one through.
for (const command of [
  'gh pr create --fill',
  'gh release create v1.2.0',
  'npm publish --access public',
  'wrangler pages deploy dist',
  'docker push registry.example.com/app:1',
  'terraform apply -auto-approve',
  'cd app && git push',
]) {
  test('block: holds "' + command + '"', { options: { mode: 'block' } }, async ($: any, on: any) => {
    engine(on)
    const held = await $.tool.call({ tool: 'Bash', command })
    expect(held.deny).toBeDefined()
  })
}

test('a plugin skill name counts as the check', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  await $.skill.prompt({ skill: 'caffeinity:release-gate', text: 'checks' })
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
})

test('all required skills must have run', { options: { mode: 'block', required: 'release-gate, pre-ship-security-red-team' } }, async ($: any, on: any) => {
  engine(on)
  await $.skill.prompt({ skill: 'release-gate', text: 'checks' })
  const held = await $.tool.call({ tool: 'Bash', command: SHIP })
  expect(held.deny).toMatch(/pre-ship-security-red-team/)

  await $.skill.prompt({ skill: 'pre-ship-security-red-team', text: 'checks' })
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
})

test('an edit after the checks makes them stale', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  await $.skill.prompt({ skill: 'release-gate', text: 'checks' })
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })

  await $.tool.call({ tool: 'Edit', file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })
  const held = await $.tool.call({ tool: 'Bash', command: SHIP })
  expect(held.deny).toMatch(/release-gate/)
})

test('after two holds the command is let through, so a missing skill cannot trap the session', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: SHIP })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Bash', command: SHIP })).deny).toBeDefined()
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
})

test('ask: "Ship anyway" lets it through, and stays acknowledged until the next edit', async ($: any, on: any) => {
  const answer = { value: 'Ship anyway' }
  engine(on, answer)
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
  answer.value = 'Run checks first'
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })

  await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' })
  expect((await $.tool.call({ tool: 'Bash', command: SHIP })).deny).toBeDefined()
})

test('ask: "Run checks first" refuses with an instruction Claude can act on', async ($: any, on: any) => {
  engine(on, { value: 'Run checks first' })
  const held = await $.tool.call({ tool: 'Bash', command: SHIP })
  expect(held.deny).toMatch(/Run that skill/)
})

test('nudge: the command runs and Claude is reminded afterwards', { options: { mode: 'nudge' } }, async ($: any, on: any) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: SHIP })
  expect(ran.result).toBe('ok')
  expect(ran.context[0]).toMatch(/release-gate/)
})

test('off: nothing is ever held', { options: { mode: 'off' } }, async ($: any, on: any) => {
  engine(on)
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })
})

test('/ship-sentinel off snoozes it and on resumes it', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  const off = await $.command.run({ command: 'ship-sentinel', args: 'off' })
  expect(off.text).toMatch(/snoozed/)
  expect(await $.tool.call({ tool: 'Bash', command: SHIP })).toEqual({ result: 'ok' })

  await $.command.run({ command: 'ship-sentinel', args: 'on' })
  expect((await $.tool.call({ tool: 'Bash', command: SHIP })).deny).toBeDefined()
})

test('/ship-sentinel reports what is still to run', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  const before = await $.command.run({ command: 'ship-sentinel', args: '' })
  expect(before.text).toMatch(/0 of 1 checks/)
  await $.skill.prompt({ skill: 'release-gate', text: 'checks' })
  const after = await $.command.run({ command: 'ship-sentinel', args: '' })
  expect(after.text).toMatch(/1 of 1 checks/)
})

test('a prompt that says "ship it" tells Claude which checks are outstanding', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  let seen: any
  on('prompt.submit', ($: any, e: any) => {
    seen = e
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'looks good, ship it' })
  expect(seen.context[0]).toMatch(/release-gate/)
})

test('an ordinary prompt is left alone', { options: { mode: 'block' } }, async ($: any, on: any) => {
  engine(on)
  let seen: any
  on('prompt.submit', ($: any, e: any) => {
    seen = e
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'rename the release notes heading' })
  expect(seen.context).toBeUndefined()
})
