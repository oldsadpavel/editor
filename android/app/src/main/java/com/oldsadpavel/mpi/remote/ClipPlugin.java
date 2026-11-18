package com.oldsadpavel.mpi.remote;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** «📋 Картинка»: картинка из буфера обмена (скриншот, «Копировать изображение») как data URL. */
@CapacitorPlugin(name = "Clip")
public class ClipPlugin extends Plugin {

    @PluginMethod
    public void readImage(PluginCall call) {
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                call.reject("Буфер обмена пуст");
                return;
            }
            ContentResolver cr = getContext().getContentResolver();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri == null) continue;
                String type = cr.getType(uri);
                if (type == null || !type.startsWith("image/")) continue;
                try (InputStream in = cr.openInputStream(uri)) {
                    if (in == null) continue;
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    JSObject r = new JSObject();
                    r.put("dataUrl", "data:" + type + ";base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                    call.resolve(r);
                    return;
                }
            }
            call.reject("В буфере обмена нет картинки");
        } catch (Exception e) {
            call.reject("Не удалось прочитать буфер обмена: " + e.getMessage(), e);
        }
    }
}
