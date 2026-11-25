package __PACKAGE__;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Ponte entre a página do sistema e o serviço nativo de localização (TrackerService): liga e desliga o serviço, pede as permissões do
 * Android (localização, "o tempo todo" e notificações) e informa o estado para a tela do motorista.
 */
@CapacitorPlugin(
    name = "NativeTracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "background", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class TrackerPlugin extends Plugin {
    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean locationGranted() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean backgroundGranted() {
        return Build.VERSION.SDK_INT < 29 || granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private boolean notificationsGranted() {
        return Build.VERSION.SDK_INT < 33 || granted("android.permission.POST_NOTIFICATIONS");
    }

    private boolean gpsOn() {
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void permissions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("location", locationGranted());
        r.put("background", backgroundGranted());
        r.put("notifications", notificationsGranted());
        r.put("gpsOn", gpsOn());
        call.resolve(r);
    }

    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (locationGranted()) { permissions(call); return; }
        requestPermissionForAlias("location", call, "afterPermission");
    }

    /** "Permitir o tempo todo": no Android 11 ou mais novo abre a tela de ajustes do app; antes disso, uma janela. */
    @PluginMethod
    public void requestBackground(PluginCall call) {
        if (backgroundGranted()) { permissions(call); return; }
        if (!locationGranted()) { call.reject("Libere a localização primeiro."); return; }
        requestPermissionForAlias("background", call, "afterPermission");
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (notificationsGranted()) { permissions(call); return; }
        requestPermissionForAlias("notifications", call, "afterPermission");
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        permissions(call);
    }

    @PluginMethod
    public void start(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        String base = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        // sem credencial nova (por exemplo, sem internet ao abrir o app), reaproveita a que já estava guardada
        if (token == null || token.isEmpty()) token = p.getString("token", "");
        if (base == null || base.isEmpty()) base = p.getString("baseUrl", "");
        if (base == null || !base.startsWith("https://") || token == null || token.length() < 20) {
            call.reject("Endereço (https) e credencial do aparelho são obrigatórios.");
            return;
        }
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        p.edit().putString("baseUrl", base).putString("token", token).putBoolean("enabled", true).putBoolean("authFailed", false).apply();
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), TrackerService.class));
        } catch (Exception e) {
            call.reject("Não foi possível iniciar o serviço de localização: " + e.getMessage());
            return;
        }
        state(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        p.edit().putBoolean("enabled", false).remove("token").apply();
        getContext().stopService(new Intent(getContext(), TrackerService.class));
        new PointQueue(getContext()).clear();
        TrackerService.routeActive = -1;
        TrackerService.pending = 0;
        TrackerService.lastFixAt = 0;
        TrackerService.running = false;
        JSObject r = new JSObject();
        r.put("running", false);
        call.resolve(r);
    }

    @PluginMethod
    public void state(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        JSObject r = new JSObject();
        r.put("running", TrackerService.running);
        r.put("location", locationGranted());
        r.put("background", backgroundGranted());
        r.put("notifications", notificationsGranted());
        r.put("gpsOn", gpsOn());
        r.put("hasToken", !p.getString("token", "").isEmpty());
        r.put("authFailed", p.getBoolean("authFailed", false));
        r.put("routeActive", TrackerService.routeActive);
        r.put("pending", TrackerService.running ? TrackerService.pending : new PointQueue(getContext()).size());
        r.put("fixAgeSec", TrackerService.lastFixAt > 0 ? (now - TrackerService.lastFixAt) / 1000 : -1);
        r.put("sentAgeSec", TrackerService.lastSentAt > 0 ? (now - TrackerService.lastSentAt) / 1000 : -1);
        if (TrackerService.lastFixAt > 0) {
            r.put("lat", TrackerService.lastLat);
            r.put("lng", TrackerService.lastLng);
            r.put("accuracyM", (double) TrackerService.lastAccuracy);
        }
        r.put("lastError", TrackerService.lastError == null ? "" : TrackerService.lastError);
        call.resolve(r);
    }
}
