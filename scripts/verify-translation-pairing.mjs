/**
 * Lightweight bilingual-pair consistency check for the standalone repo.
 *
 * Every in-scope Markdown document must have a `.zh.md` sibling and a
 * `.i18n.yaml` record pairing their git blob hashes, mirroring the
 * deepseek-harness translation-pairing contract. Run with `--write` to
 * re-record hashes after editing either side:
 *
 *   node scripts/verify-translation-pairing.mjs            # check only
 *   node scripts/verify-translation-pairing.mjs --write    # re-record
 *
 * In scope: README.md and every docs/**\/*.md (English side). The Chinese
 * side is the same path with `.zh.md`. Blob hash = sha1("blob <len>\0" + content),
 * exactly what git stores.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const write = process.argv.includes('--write')

function blobHash(file) {
  const content = readFileSync(file, 'utf8')
  return createHash('sha1').update(`blob ${Buffer.byteLength(content, 'utf8')}\0${content}`).digest('hex')
}

/** English-side in-scope Markdown files (docs/**\/*.md + README.md). */
function englishSides() {
  const files = []
  for (const name of readdirSync(root)) {
    if (name === 'README.md') files.push(join(root, name))
  }
  const docs = join(root, 'docs')
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) {
      if (name.endsWith('.md') && !name.endsWith('.zh.md')) files.push(join(docs, name))
    }
  }
  return files.sort()
}

let changed = 0
const summary = []
for (const side of englishSides()) {
  const zh = side.replace(/\.md$/, '.zh.md')
  const yaml = side.replace(/\.md$/, '.i18n.yaml')
  if (!existsSync(zh)) {
    console.error(`missing Chinese sibling: ${relative(root, zh)}`)
    process.exitCode = 1
    continue
  }
  const enHash = blobHash(side)
  const zhHash = blobHash(zh)
  const header = [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    `#   node scripts/verify-translation-pairing.mjs --write ${relative(root, side)}`,
    `${relative(root, side)}: ${enHash}`,
    `${relative(root, zh)}: ${zhHash}`,
    '',
  ].join('\n')
  const current = existsSync(yaml) ? readFileSync(yaml, 'utf8') : ''
  if (current !== header) {
    if (write) {
      writeFileSync(yaml, header)
      changed += 1
      summary.push(`recorded ${relative(root, yaml)}`)
    } else {
      console.error(`out of sync: ${relative(root, yaml)} — run with --write to re-record`)
      process.exitCode = 1
    }
  }
}

if (write) {
  console.log(`verify-translation-pairing: ${changed} record(s) written; run the check to validate the pairs.`)
} else if (process.exitCode === undefined) {
  console.log(`verify-translation-pairing: ${summary.length} pair(s) checked, all consistent.`)
}
