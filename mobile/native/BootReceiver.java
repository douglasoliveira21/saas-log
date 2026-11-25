package __PACKAGE__;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.content.ContextCompat;

/** Religa o GPS quando o celular reinicia ou o app é atualizado, se o motorista estava com o rastreio ligado. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferences p = context.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", false) || p.getString("token", "").isEmpty()) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, TrackerService.class));
        } catch (Exception ignored) {
            // alguns aparelhos/versões não deixam iniciar serviço em primeiro plano assim; o motorista abre o app e ele volta
        }
    }
}
