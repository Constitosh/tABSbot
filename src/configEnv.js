// src/configEnv.js
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load ../.env relative to /src
dotenv.config({ path: join(__dirname, '..', '.env') });

// Nothing to export; just ensure process.env is populated.
