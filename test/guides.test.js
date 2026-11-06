// The beginner guides tell people to type commands. Every `./rushlight <command>` and every `--flag` shown with one must be real,
// and every link between the guides must lead somewhere, so a guide cannot drift away from the program.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const program = readFileSync(join(root, 'deploy/rushlight'), 'utf8')
const guidesDir = join(root, 'docs/guides')
const guides = readdirSync(guidesDir).filter((f) => f.endsWith('.md'))
const commands = new Set([...program.matchAll(/^  ([a-z-]+)\)/gm)].map((m) => m[1]))

test('every ./rushlight command in the guides exists', () => {
  assert.ok(commands.has('setup') && commands.has('check') && commands.has('rotate-secrets'), 'found the program commands')
  for (const f of guides) {
    const text = readFileSync(join(guidesDir, f), 'utf8')
    for (const m of text.matchAll(/\.\/rushlight ([a-z-]+)/g)) assert.ok(commands.has(m[1]), `${f}: ./rushlight ${m[1]} is not a command`)
  }
})

test('every --flag written next to ./rushlight in the guides is one the program reads', () => {
  for (const f of guides) {
    const text = readFileSync(join(guidesDir, f), 'utf8')
    for (const line of text.split('\n').filter((l) => l.includes('./rushlight '))) {
      for (const m of line.matchAll(/ (--[a-z-]+)/g)) assert.ok(program.includes(`${m[1]})`), `${f}: ${m[1]} is not a flag of the program (${line.trim()})`)
    }
  }
})

test('links between the guides and the docs lead somewhere', () => {
  for (const f of guides) {
    const text = readFileSync(join(guidesDir, f), 'utf8')
    for (const m of text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) assert.ok(existsSync(normalize(join(guidesDir, m[1]))), `${f}: broken link ${m[1]}`)
  }
})

test('the guides say they come from tests and not yet from a real run', () => {
  assert.match(readFileSync(join(guidesDir, 'README.md'), 'utf8'), /not yet from a real person/)
})
