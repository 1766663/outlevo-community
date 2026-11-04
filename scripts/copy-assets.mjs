import { chmodSync, cpSync } from 'node:fs';
cpSync('src/dashboard/public', 'dist/dashboard/public', { recursive: true });
chmodSync('dist/cli.js', 0o755);
