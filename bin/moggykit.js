#!/usr/bin/env node

/**
 * moggykit — real rescue cats in your terminal.
 *
 * A thin client for moggy.dev/api and nothing more: no caching, no cleverness,
 * no logic of its own. Every cat shown here is a real cat living with
 * Associação Ambiental da Via da Estrela in Portugal, and every one of them
 * can be sponsored.
 *
 * Zero dependencies on purpose — this runs through `npx`, so install weight is
 * felt by every user, every time.
 */

import { readFileSync } from 'node:fs'

const API = process.env.MOGGYKIT_API ?? 'https://moggy.dev/api'
const TIMEOUT_MS = 10_000

/** Colour, unless the terminal or the user says otherwise. */
const useColour =
  process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color')

const paint = (code) => (text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text)

const bold = paint('1')
const dim = paint('2')
const pink = paint('38;5;211')
const cyan = paint('38;5;80')

const HELP = `
  ${bold('moggykit')} — real rescue cats in your terminal

  ${bold('Usage')}
    npx moggykit                 a cat, chosen at random
    npx moggykit <slug>          a particular cat
    npx moggykit --json          the raw JSON, for piping

  ${bold('Options')}
    --json         print the API response instead of the pretty version
    --no-color     plain text, no ANSI colour
    -h, --help     this message
    -v, --version  the installed version

  ${bold('More')}
    Placeholder images, a practice REST API and README widgets, all free:
    ${cyan('https://moggy.dev')}

  Every cat is real and can be sponsored. That is the whole point.
`

/**
 * Fetch JSON, turning every failure into a message a human can act on.
 * A CLI that prints a raw stack trace has failed twice.
 */
async function getJson(path) {
  let response

  try {
    response = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      error.name === 'TimeoutError'
        ? `moggy.dev did not answer within ${TIMEOUT_MS / 1000}s`
        : 'could not reach moggy.dev — are you online?',
    )
  }

  if (response.status === 404) {
    throw new Error('no cat by that name — run `npx moggykit` for a random one')
  }

  if (!response.ok) {
    throw new Error(`moggy.dev returned ${response.status}`)
  }

  return response.json()
}

/** A named cat, or a random one from the list. */
async function fetchCat(slug) {
  if (slug) {
    return (await getJson(`/cats/${encodeURIComponent(slug)}`)).data
  }

  const { data } = await getJson('/cats')

  if (!data?.length) {
    throw new Error('moggy.dev has no cats to show right now')
  }

  return data[Math.floor(Math.random() * data.length)]
}

/** "female · active", skipping anything the feed did not supply. */
function describe(cat) {
  const sex = { f: 'female', m: 'male' }[cat.sex]

  return [sex, cat.approx_age, cat.status].filter(Boolean).join(' · ')
}

/**
 * Each line is padded to the same width so the ears sit centred over the face
 * and the text beside it lines up in one column. Trailing space is trimmed per
 * line — invisible in a terminal, but it shows up the moment anyone pipes the
 * output into a file or a diff.
 */
const ART = [' /\\_/\\ ', '( o.o )', ' > ^ < ']

function render(cat) {
  const details = describe(cat)
  const beside = [bold(cat.name), details ? dim(details) : '', '']

  const head = ART.map((line, index) => `  ${pink(line)}   ${beside[index]}`.trimEnd())

  return [
    '',
    ...head,
    '',
    `  ${cat.story ?? dim('No story written yet.')}`,
    '',
    `  ${dim('Sponsor')}  ${cyan(cat.sponsor_url)}`,
    `  ${dim('Photo')}    ${cyan(cat.photo_url)}`,
    '',
  ].join('\n')
}

function version() {
  const manifest = new URL('../package.json', import.meta.url)

  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP)

    return
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(version())

    return
  }

  const slug = args.find((arg) => !arg.startsWith('-'))
  const cat = await fetchCat(slug)

  console.log(args.includes('--json') ? JSON.stringify(cat, null, 2) : render(cat))
}

main().catch((error) => {
  console.error(`\n  moggykit: ${error.message}\n`)
  process.exit(1)
})
