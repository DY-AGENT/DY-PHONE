package com.dyagent.mobile

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Model file downloader backed by the Android system DownloadManager.
 *
 * Why DownloadManager instead of an in-app HTTP fetch: the system service owns
 * the transfer, so it keeps running with the screen off, survives the app being
 * backgrounded or killed, retries/resumes on flaky networks, and shows progress
 * in the notification shade — exactly what a ~3 GB model file needs.
 *
 * The file lands in the app-specific external files dir (no storage permission
 * required). Pass the returned absolute `path` to `GemmaLlm.load({ modelPath })`,
 * which accepts absolute paths.
 *
 * JS contract (see www/app.js):
 *   start({ url, fileName }) -> { id, path }
 *   status({ id })           -> { state, bytes, total, reason }
 *                                state: pending|running|paused|success|failed|gone
 *   cancel({ id })           -> { ok }
 */
@CapacitorPlugin(name = "ModelDownloader")
class ModelDownloaderPlugin : Plugin() {

    private val dm: DownloadManager
        get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    /** Look for an already-downloaded model in the app folder, newest first. */
    @PluginMethod
    fun findModel(call: PluginCall) {
        val dir = context.getExternalFilesDir(null)
        val model = dir?.listFiles()
            ?.filter { it.isFile && (it.name.endsWith(".litertlm") || it.name.endsWith(".task")) && it.length() > 100_000_000L }
            ?.maxByOrNull { it.lastModified() }
        val out = JSObject()
        if (model != null) {
            out.put("found", true).put("path", model.absolutePath)
                .put("name", model.name).put("size", model.length())
        } else {
            out.put("found", false)
        }
        call.resolve(out)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val url = call.getString("url") ?: run { call.reject("url is required"); return }
        val fileName = call.getString("fileName") ?: run { call.reject("fileName is required"); return }

        val dir = context.getExternalFilesDir(null) ?: run {
            call.reject("External files dir unavailable"); return
        }
        // A model file is the only thing we keep here, and only one is ever
        // used — clear out previous (possibly wrong-format) downloads so a
        // ~2-3 GB stale file doesn't eat the space the new one needs.
        dir.listFiles()?.forEach { f ->
            if (f.isFile && (f.name.endsWith(".task") || f.name.endsWith(".litertlm"))) f.delete()
        }
        val dest = File(dir, fileName)

        try {
            val req = DownloadManager.Request(Uri.parse(url))
                .setTitle("DY PHONE 모델")
                .setDescription(fileName)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationUri(Uri.fromFile(dest))
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
            val id = dm.enqueue(req)
            call.resolve(JSObject().put("id", id.toString()).put("path", dest.absolutePath))
        } catch (e: Throwable) {
            call.reject("Failed to enqueue download: ${e.message}", Exception(e))
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val id = call.getString("id")?.toLongOrNull() ?: run {
            call.reject("id is required"); return
        }
        dm.query(DownloadManager.Query().setFilterById(id)).use { c ->
            if (!c.moveToFirst()) {
                // Unknown to DownloadManager: cancelled from the shade, or cleared.
                call.resolve(JSObject().put("state", "gone"))
                return
            }
            val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val bytes = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            val state = when (status) {
                DownloadManager.STATUS_PENDING -> "pending"
                DownloadManager.STATUS_RUNNING -> "running"
                DownloadManager.STATUS_PAUSED -> "paused"
                DownloadManager.STATUS_SUCCESSFUL -> "success"
                DownloadManager.STATUS_FAILED -> "failed"
                else -> "unknown"
            }
            call.resolve(
                JSObject()
                    .put("state", state)
                    .put("bytes", bytes)
                    .put("total", total)
                    .put("reason", reason)
            )
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id")?.toLongOrNull() ?: run {
            call.reject("id is required"); return
        }
        dm.remove(id)
        call.resolve(JSObject().put("ok", true))
    }
}
