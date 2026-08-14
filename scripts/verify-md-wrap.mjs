/**
 * Lightweight prose-wrap check: every paragraph in in-scope Markdown files
 * must be one physical line (editor soft-wrap), mirroring the deepseek-harness
 * verify-md-wrap contract. List items, tables, code fences, and headings are
 * exempt: the check only flags hard-wrapped continuation lines that begin with
 * lowercase text following a non-empty previous line inside a prose run.
 *
 *   node scripts/verify-md-wrap.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function markdownFiles(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.md')) files.push(path)
  }
  return files
}

const files = [...markdownFiles(root), ...(existsSync(join(root, 'docs')) ? markdownFiles(join(root, 'docs')) : [])]
let failures = 0

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  let inFence = false
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1]
    const cur = lines[i]
    if (cur.trimStart().startsWith('```')) inFence = !inFence
    if (inFence) continue
    // A continuation line: non-empty, not a heading/list/table/fence/blank,
    // previous line is prose and non-empty, and the line is indented prose.
    if (cur.trim().length === 0) continue
    if (/^(#{1,6} |[-*] |\d+\. |\| |> |```)/.test(cur.trimStart())) continue
    if (prev.trim().length === 0) continue
    if (/^(#{1,6} |[-*] |\d+\. |\| |> |```)/.test(prev.trimStart())) continue
    // Prose continuation detected — flag it.
    console.error(`${relative(root, file)}:${i + 1}: hard-wrapped prose paragraph; use one physical line per paragraph`)
    failures += 1
  }
}

function relative(base, target) {
  return target.startsWith(base + '/') ? target.slice(base.length + 1) : target
}

if (failures > 0) {
  console.error(`verify-md-wrap: ${failures} hard-wrapped prose line(s) across ${files.length} file(s).`)
  process.exit(1)
}
console.log(`verify-md-wrap: ${files.length} file(s) checked, no hard-wrapped prose paragraphs.`)
