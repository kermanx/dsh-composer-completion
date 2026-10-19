#!/usr/bin/env node
import { CompletionRequestLog, requestForReplay } from '../lib/types/request-log.js'

const args = process.argv.slice(2)
let directory
const directoryFlag = args.indexOf('--dir')
if (directoryFlag !== -1) {
  directory = args[directoryFlag + 1]
  args.splice(directoryFlag, 2)
  if (!directory || directory.startsWith('--')) {
    console.error('--dir requires a directory')
    process.exit(1)
  }
}
const [command = 'list', id] = args
const usage = 'Usage: composer-completion-log [list | usage | export <id> | options <id>] [--dir <directory>]'
if (command === '--help' || command === '-h') {
  console.log(usage)
} else {
  try {
    if (args.length > (command === 'list' || command === 'usage' ? 1 : 2)) throw new Error(usage)
    const log = new CompletionRequestLog({ directory })
    let value
    if (command === 'list') {
      const sessions = await log.listSessions()
      const entries = sessions.flatMap(session => session.entries)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      value = { directory: log.directory, maxBytes: log.maxBytes,
        bytes: sessions.reduce((total, session) => total + session.bytes, 0),
        sessions: sessions.map(({ entries, ...session }) => ({ ...session, requests: entries.length })), entries }
    } else if (command === 'usage') {
      value = await log.usage()
    } else if ((command === 'export' || command === 'options') && id) {
      const record = await log.read(id)
      value = command === 'options' ? requestForReplay(record) : record
    } else {
      throw new Error(usage)
    }
    console.log(JSON.stringify(value, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
