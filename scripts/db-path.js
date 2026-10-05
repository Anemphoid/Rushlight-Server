// Prints the path of the database file the server will use, resolved exactly
// the way src/db.js resolves it. Used by the update and backup scripts.
import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const configured = process.env.DB_PATH
console.log(configured ? resolve(configured) : join(root, 'rushlight.db'))
