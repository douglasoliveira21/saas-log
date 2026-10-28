// Ajusta o projeto Android gerado por `cap add android`: permissões de localização (incluindo segundo plano), tráfego só criptografado,
// número da versão e o plugin nativo "PowerSettings" (pede ao Android para NÃO restringir a bateria do app, o que mantém o GPS enviando
// com a tela bloqueada ou com outro aplicativo aberto). Pode ser executado várias vezes sem duplicar nada.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const gradlePath = join(root, 'android', 'app', 'build.gradle');
const javaRoot = join(root, 'android', 'app', 'src', 'main', 'java');
if (!existsSync(manifestPath)) { console.error('Projeto Android não encontrado. Rode antes: npx cap add android'); process.exit(1); }

const PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION', // continuar enviando com a tela apagada
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS', // aviso fixo exigido pelo Android enquanto a localização é usada
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', // pedir "sem restrições de bateria" para o app
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

// ── plugin nativo PowerSettings ──
function findFile(dir, name) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e === name) return p;
  }
  return null;
}
const mainPath = existsSync(javaRoot) ? findFile(javaRoot, 'MainActivity.java') : null;
if (!mainPath) { console.error('MainActivity.java não encontrada: o plugin PowerSettings não foi instalado.'); process.exit(1); }
let main = readFileSync(mainPath, 'utf8');
const pkg = /package\s+([\w.]+);/.exec(main)[1];
const dir = mainPath.replace(/[\\/]MainActivity\.java$/, '');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'PowerSettingsPlugin.java'), `package ${pkg};

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Permite ao sistema perguntar se o app está livre das restrições de bateria e abrir a tela do Android que as remove. */
@CapacitorPlugin(name = "PowerSettings")
public class PowerSettingsPlugin extends Plugin {
    @PluginMethod
    public void status(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject r = new JSObject();
        r.put("ignoring", ignoring);
        call.resolve(r);
    }

    @PluginMethod
    public void request(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Não foi possível abrir os ajustes de bateria.");
            }
        }
    }
}
`);
if (!main.includes('PowerSettingsPlugin')) {
  main = main.replace(/public class MainActivity extends BridgeActivity\s*\{\s*\}/, `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(PowerSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}`);
  if (!main.includes('PowerSettingsPlugin')) { console.error('Formato inesperado da MainActivity: registre o PowerSettingsPlugin manualmente.'); process.exit(1); }
  writeFileSync(mainPath, main);
}
console.log('AndroidManifest, versão e plugin PowerSettings ajustados.');
