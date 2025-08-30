// src/configEnv.js
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try ../.env (project root relative to src/)
let loaded = dotenv.config({ path: join(__dirname, '..', '.env') });
if (loaded.error) {
  // Fallback: look in CWD
  loaded = dotenv.config();
}