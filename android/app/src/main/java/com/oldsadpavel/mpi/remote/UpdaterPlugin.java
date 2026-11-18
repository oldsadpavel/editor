package com.oldsadpavel.mpi.remote;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * «Обновить»: скачивает APK новой версии (релиз на GitHub) в кэш приложения и открывает системную установку.
 * Без разрешения «Установка неизвестных приложений» сначала открывает его настройку — после неё нажать ещё раз.
 * Обновление ставится поверх, если APK подписан тем же ключом (секреты CI).
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Нет адреса APK");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(s);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        new Thread(() -> {
            try {
                File out = new File(getContext().getCacheDir(), "mpi-update.apk");
                download(url, out, 0);
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject r = new JSObject();
                r.put("started", true);
                r.put("size", out.length());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Не удалось скачать обновление: " + e.getMessage(), e);
            }
        }).start();
    }

    /** GitHub отдаёт релизные файлы через редирект на другой хост — проходим до 5 переходов вручную. */
    private void download(String url, File out, int depth) throws Exception {
        if (depth > 5) throw new Exception("слишком много перенаправлений");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "MPI-Remote");
        int code = c.getResponseCode();
        if (code >= 300 && code < 400) {
            String next = c.getHeaderField("Location");
            c.disconnect();
            download(next, out, depth + 1);
            return;
        }
        if (code != 200) throw new Exception("HTTP " + code);
        try (InputStream in = c.getInputStream(); FileOutputStream fo = new FileOutputStream(out)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) fo.write(buf, 0, n);
        } finally {
            c.disconnect();
        }
    }
}
