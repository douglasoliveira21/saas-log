package __PACKAGE__;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Serviço de localização do DistribuiHub. Roda em primeiro plano (notificação fixa), lê o GPS e ENVIA as posições ao servidor por conta
 * própria: não depende da página do sistema estar aberta, da tela estar ligada nem do aplicativo estar na frente. As posições ficam numa
 * fila em arquivo e só saem dela quando o servidor confirma o recebimento. Se o Android encerrar o serviço, ele é reiniciado (START_STICKY);
 * ao ligar o celular, o BootReceiver o inicia de novo.
 */
public class TrackerService extends Service {
    static final String PREFS = "dh_tracker";
    private static final String CHANNEL = "dh_tracker";
    private static final int NOTIFICATION_ID = 4711;
    private static final long TICK_MS = 15_000;
    private static final long KEEP_EVERY_MS = 5_000;
    private static final long NO_FIX_RESTART_MS = 120_000;
    private static final int BATCH = 60;

    // Estado lido pelo plugin (para a tela mostrar).
    static volatile boolean running = false;
    static volatile boolean gpsEnabled = true;
    static volatile String permission = "unknown";
    static volatile double lastLat = 0;
    static volatile double lastLng = 0;
    static volatile float lastAccuracy = 0;
    static volatile long lastFixAt = 0;
    static volatile int pending = 0;
    static volatile long lastSentAt = 0;
    static volatile String lastError = null;
    static volatile int routeActive = -1; // -1 ainda não sabe, 0 sem rota, 1 rota em andamento

    private LocationManager locationManager;
    private LocationListener gpsListener;
    private LocationListener networkListener;
    private HandlerThread thread;
    private Handler handler;
    private ExecutorService network;
    private PointQueue queue;
    private PowerManager.WakeLock wakeLock;
    private long lastKept = 0;
    private long lastGpsFix = 0;
    private long registeredAt = 0;
    private volatile boolean flushing = false;
    private final SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String base = p.getString("baseUrl", "");
        String token = p.getString("token", "");
        if (!p.getBoolean("enabled", false) || base.isEmpty() || token.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            promote("Iniciando o GPS…");
        } catch (Exception e) {
            lastError = "Não foi possível manter o serviço em primeiro plano: " + e.getMessage();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) begin();
        return START_STICKY;
    }

    private void begin() {
        running = true;
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        queue = new PointQueue(this);
        pending = queue.size();
        thread = new HandlerThread("dh-tracker");
        thread.start();
        handler = new Handler(thread.getLooper());
        network = Executors.newSingleThreadExecutor();
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DistribuiHub:tracker");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(); // mantém o processador acordado para ler o GPS e enviar com a tela bloqueada
        } catch (Exception ignored) {
        }
        registerLocation();
        handler.postDelayed(tick, 1_000);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            long now = System.currentTimeMillis();
            checkHealth(now);
            flushAsync();
            updateNotification();
            if (handler != null) handler.postDelayed(this, TICK_MS);
        }
    };

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Confere permissão e GPS; se o sistema parou de entregar posições, registra de novo. */
    private void checkHealth(long now) {
        permission = hasLocationPermission() ? "granted" : "denied";
        boolean providerOn;
        try {
            providerOn = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception e) {
            providerOn = false;
        }
        gpsEnabled = providerOn && "granted".equals(permission);
        if ("granted".equals(permission) && now - registeredAt > NO_FIX_RESTART_MS && now - Math.max(lastGpsFix, registeredAt) > NO_FIX_RESTART_MS) {
            registerLocation();
        }
    }

    private void registerLocation() {
        unregisterLocation();
        registeredAt = System.currentTimeMillis();
        if (!hasLocationPermission()) {
            permission = "denied";
            return;
        }
        permission = "granted";
        gpsListener = new LocationListener() {
            @Override public void onLocationChanged(Location l) { onLocation(l, true); }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onProviderDisabled(String provider) { gpsEnabled = false; }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
        };
        networkListener = new LocationListener() {
            @Override public void onLocationChanged(Location l) { onLocation(l, false); }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onProviderDisabled(String provider) { }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
        };
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5_000, 0f, gpsListener, thread.getLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15_000, 0f, networkListener, thread.getLooper());
            }
        } catch (SecurityException e) {
            permission = "denied";
        } catch (Exception e) {
            lastError = "GPS: " + e.getMessage();
        }
    }

    private void unregisterLocation() {
        try {
            if (locationManager != null) {
                if (gpsListener != null) locationManager.removeUpdates(gpsListener);
                if (networkListener != null) locationManager.removeUpdates(networkListener);
            }
        } catch (Exception ignored) {
        }
        gpsListener = null;
        networkListener = null;
    }

    private void onLocation(Location l, boolean gps) {
        long now = System.currentTimeMillis();
        if (l == null) return;
        // a localização por rede só vale quando o GPS ficou um tempo sem posição
        if (!gps && now - lastGpsFix < 30_000) return;
        if (!gps && l.getAccuracy() > 150f) return;
        if (gps) lastGpsFix = now;
        lastLat = l.getLatitude();
        lastLng = l.getLongitude();
        lastAccuracy = l.getAccuracy();
        lastFixAt = now;
        gpsEnabled = true;
        if (routeActive != 1) return; // fora de uma rota em andamento nada é guardado nem enviado
        if (now - lastKept < KEEP_EVERY_MS) return;
        lastKept = now;
        try {
            JSONObject o = new JSONObject();
            o.put("lat", l.getLatitude());
            o.put("lng", l.getLongitude());
            o.put("accuracyM", Math.round(l.getAccuracy()));
            if (l.hasSpeed() && l.getSpeed() >= 0) o.put("speedMps", l.getSpeed());
            if (l.hasBearing() && l.getBearing() >= 0) o.put("heading", l.getBearing());
            o.put("recordedAt", iso.format(new Date(l.getTime() > 0 ? l.getTime() : now)));
            queue.add(o.toString());
            pending = queue.size();
            if (pending >= 10) flushAsync();
        } catch (Exception ignored) {
        }
    }

    private void flushAsync() {
        if (flushing || network == null) return;
        flushing = true;
        network.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    // esvazia a fila em lotes, enquanto houver o que enviar e o envio der certo
                    for (int i = 0; i < 30; i++) {
                        if (!flushOnce()) break;
                        if (queue.size() == 0) break;
                    }
                } catch (Exception e) {
                    lastError = e.getMessage();
                } finally {
                    flushing = false;
                    pending = queue != null ? queue.size() : 0;
                }
            }
        });
    }

    /** Envia um lote (ou só o estado do GPS). Verdadeiro se o servidor aceitou. */
    private boolean flushOnce() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String base = p.getString("baseUrl", "");
        String token = p.getString("token", "");
        if (base.isEmpty() || token.isEmpty()) return false;
        List<String> lines = routeActive == 0 ? new java.util.ArrayList<String>() : queue.peek(BATCH);
        HttpURLConnection c = null;
        try {
            JSONArray points = new JSONArray();
            for (String s : lines) points.put(new JSONObject(s));
            JSONObject gps = new JSONObject();
            gps.put("enabled", gpsEnabled);
            gps.put("permission", "granted".equals(permission) ? "granted" : "denied");
            gps.put("source", "APP");
            JSONObject body = new JSONObject();
            body.put("points", points);
            body.put("gps", gps);
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);

            c = (HttpURLConnection) new URL(base + "/api/delivery/beacon").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(15_000);
            c.setReadTimeout(20_000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("x-dh-csrf", "1");
            c.setFixedLengthStreamingMode(data.length);
            try (OutputStream o = c.getOutputStream()) {
                o.write(data);
            }
            int code = c.getResponseCode();
            if (code == 200) {
                String text = read(c.getInputStream());
                JSONObject r = new JSONObject(text);
                routeActive = r.optBoolean("routeActive", false) ? 1 : 0;
                if (!lines.isEmpty()) queue.dropFirst(lines.size());
                if (routeActive == 0) queue.clear(); // sem rota, nada é guardado
                lastSentAt = System.currentTimeMillis();
                lastError = null;
                p.edit().putBoolean("authFailed", false).apply();
                return true;
            }
            if (code == 401) {
                lastError = "auth"; // credencial recusada: a tela pede para entrar de novo; as posições continuam na fila
                p.edit().putBoolean("authFailed", true).apply();
            } else {
                lastError = "HTTP " + code;
            }
            return false;
        } catch (Exception e) {
            lastError = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    // ───────────── notificação fixa ─────────────

    private Notification buildNotification(String text) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "GPS do DistribuiHub", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Mostra que o GPS está ativo enquanto você trabalha.");
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        b.setContentTitle("DistribuiHub em funcionamento")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setOnlyAlertOnce(true);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }

    private void promote(String text) {
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIFICATION_ID, n);
    }

    private void updateNotification() {
        String text;
        if (!"granted".equals(permission)) text = "Localização bloqueada: abra o app e libere";
        else if (!gpsEnabled) text = "GPS desligado no aparelho: ligue a localização";
        else if (routeActive == 1) text = "Rota em andamento · GPS ativo" + (pending > 0 ? " · " + pending + " pendente(s)" : "");
        else text = "GPS ativo · sem rota em andamento";
        try {
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildNotification(text));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        unregisterLocation();
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (network != null) network.shutdown();
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
