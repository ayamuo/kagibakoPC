// Windows asset pipeline; preserves the approved master without AI regeneration.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./make-icons.ps1', import.meta.url));
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit', windowsHide: true });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
