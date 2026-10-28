// Ajusta o projeto Android gerado por `cap add android`: permissões de localização (incluindo segundo plano), tráfego só criptografado
// e número da versão. Pode ser executado várias vezes sem duplicar nada.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const gradlePath = join(root, 'android', 'app', 'build.gradle');
if (!existsSync(manifestPath)) { console.error('Projeto Android não encontrado. Rode antes: npx cap add android'); process.exit(1); }

const PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION', // continuar enviando com a tela apagada
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS', // aviso fixo exigido pelo Android enquanto a localização é usada
];

let xml = readFileSync(manifestPath, 'utf8');
for (const p of PERMISSIONS) {
  if (!xml.includes(`"${p}"`)) xml = xml.replace('<application', `<uses-permission android:name="${p}" />\n    <application`);
}
if (!xml.includes('android:usesCleartextTraffic')) xml = xml.replace('<application', '<application android:usesCleartextTraffic="false"');
writeFileSync(manifestPath, xml);

if (existsSync(gradlePath)) {
  let g = readFileSync(gradlePath, 'utf8');
  const code = process.env.VERSION_CODE ?? '1';
  const name = process.env.VERSION_NAME ?? '1.0.0';
  g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${name}"`);
  writeFileSync(gradlePath, g);
}
console.log('AndroidManifest e versão ajustados.');
