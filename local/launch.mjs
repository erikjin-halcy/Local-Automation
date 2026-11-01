// Startar run.sh från launchd via node: macOS ger /bin/zsh i launchd ingen åtkomst till skrivbordet
// (där repot och valven ligger), men node har den redan, och processerna node startar ärver den.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r = spawnSync('/bin/zsh', [fileURLToPath(new URL('./run.sh', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
