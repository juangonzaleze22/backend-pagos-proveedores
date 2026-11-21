const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
process.chdir(root);

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

const hasSrc = fs.existsSync(path.join(root, 'src'));
const hasDist = fs.existsSync(path.join(root, 'dist'));

if (!hasSrc && hasDist) {
  console.log('Deploy precompilado: no hay src/, se conserva dist/ y se omite el build.');
  process.exit(0);
}

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
run('prisma generate');
run('tsc');
run('node scripts/copy-assets.js');
