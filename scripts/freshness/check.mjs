#!/usr/bin/env node
import { main } from './sync.mjs';
try { main(true); } catch (error) { console.error(`freshness: ${error.message}`); process.exitCode = 1; }
