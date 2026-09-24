import { start } from './app/start.js';

start().catch(() => { console.error('Startup failed. Check enabled modules, environment configuration, model price card, encryption key and database connectivity.'); process.exitCode = 1; });
