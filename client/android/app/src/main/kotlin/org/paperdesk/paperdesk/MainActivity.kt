package org.paperdesk.paperdesk

import android.app.Activity
import android.content.Intent
import android.provider.OpenableColumns
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream

class MainActivity : FlutterActivity() {
    private var pendingImport: MethodChannel.Result? = null
    private val importCode = 7601
    private val maximumBytes = 64 * 1024 * 1024

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.paperdesk/memory_import")
            .setMethodCallHandler { call, result ->
                if (call.method != "pickPdf") {
                    result.notImplemented()
                } else if (pendingImport != null) {
                    result.error("busy", "已有文件选择正在进行", null)
                } else {
                    pendingImport = result
                    try {
                        // No persisted URI permission and no cacheDir/filesDir copy.
                        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "application/pdf"
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }, importCode)
                    } catch (_: Exception) {
                        pendingImport = null
                        result.error("unavailable", "无法打开系统PDF选择器", null)
                    }
                }
            }
    }

    @Deprecated("Android activity result bridge")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != importCode) return
        val response = pendingImport ?: return
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            pendingImport = null
            response.success(null)
            return
        }
        val uri = data.data!!
        Thread {
            try {
                var name = "document.pdf"
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex) && cursor.getLong(sizeIndex) > maximumBytes) {
                            throw IllegalArgumentException("large")
                        }
                    }
                }
                val bytes = ByteArrayOutputStream().use { output ->
                    contentResolver.openInputStream(uri)?.use { input ->
                        val buffer = ByteArray(64 * 1024)
                        var total = 0
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            if (total > maximumBytes) throw IllegalArgumentException("large")
                            output.write(buffer, 0, count)
                        }
                    } ?: throw IllegalArgumentException("unreadable")
                    output.toByteArray()
                }
                runOnUiThread {
                    if (pendingImport === response) {
                        pendingImport = null
                        response.success(mapOf("name" to name, "bytes" to bytes))
                    }
                }
            } catch (_: Exception) {
                runOnUiThread {
                    if (pendingImport === response) {
                        pendingImport = null
                        response.error("read_failed", "无法读取PDF；Android内存导入上限64MB", null)
                    }
                }
            }
        }.start()
    }

    override fun onDestroy() {
        pendingImport?.error("closed", "文件导入已结束", null)
        pendingImport = null
        super.onDestroy()
    }
}
