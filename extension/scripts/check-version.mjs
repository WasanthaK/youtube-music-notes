import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

console.log(`manifest.json version: ${manifest.version}`);
console.log(`package.json version:  ${pkg.version}`);

if (manifest.version !== pkg.version) {
  console.error(
    `Version mismatch: manifest.json has ${manifest.version} but package.json has ${pkg.version}. ` +
    'Set both to the same version.'
  );
  process.exit(1);
}

console.log('Versions match.');
process.exit(0);
