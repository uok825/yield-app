/** Loads ./.env (if present) before anything reads process.env. Existing environment variables win. */
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')
