package __PACKAGE__;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Fila de posições do GPS guardada em arquivo (uma por linha, em JSON). Sobrevive a falta de internet, ao app ser fechado e ao celular
 * reiniciar: uma posição só sai da fila depois que o servidor confirma que a recebeu.
 */
final class PointQueue {
    private static final int MAX = 20000; // ~ 27 horas de pontos a cada 5 s; passando disso, descarta os mais antigos
    private final File file;
    private final File tmp;
    private int count = -1;

    PointQueue(Context c) {
        file = new File(c.getFilesDir(), "dh_track_queue.jsonl");
        tmp = new File(c.getFilesDir(), "dh_track_queue.tmp");
    }

    private void ensure() {
        if (count >= 0) return;
        int n = 0;
        if (file.exists()) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                while (r.readLine() != null) n++;
            } catch (IOException e) {
                n = 0;
            }
        }
        count = n;
    }

    synchronized int size() {
        ensure();
        return count;
    }

    synchronized void add(String jsonLine) {
        ensure();
        try (FileOutputStream o = new FileOutputStream(file, true)) {
            o.write((jsonLine + "\n").getBytes(StandardCharsets.UTF_8));
            count++;
        } catch (IOException ignored) {
            return;
        }
        if (count > MAX) dropFirst(count - MAX);
    }

    synchronized List<String> peek(int max) {
        ensure();
        List<String> out = new ArrayList<>();
        if (!file.exists()) return out;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while (out.size() < max && (line = r.readLine()) != null) {
                if (!line.isEmpty()) out.add(line);
            }
        } catch (IOException ignored) {
        }
        return out;
    }

    synchronized void dropFirst(int n) {
        ensure();
        if (n <= 0 || !file.exists()) return;
        int kept = 0;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8));
             FileOutputStream o = new FileOutputStream(tmp, false)) {
            String line;
            int i = 0;
            while ((line = r.readLine()) != null) {
                if (i++ < n) continue;
                o.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                kept++;
            }
        } catch (IOException e) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(file);
        count = kept;
    }

    synchronized void clear() {
        //noinspection ResultOfMethodCallIgnored
        file.delete();
        count = 0;
    }
}
