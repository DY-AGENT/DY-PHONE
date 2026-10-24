package com.dyagent.mobile

import android.util.Base64
import android.webkit.MimeTypeMap
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * DY OS file storage — the virtual OS's "폴더".
 *
 * A single app-specific folder (getExternalFilesDir/DYOS) that is the shared
 * drop point for: files the DY browser downloads, files the agent writes, and
 * files the agent reads back. No storage permission needed (app-scoped).
 *
 * JS contract (see www/vos/vos.js):
 *   list()                       -> { files: [{ name, size }] }
 *   readText({ name })           -> { content }         (utf-8, truncated)
 *   writeText({ name, content }) -> { ok }
 *   remove({ name })             -> { ok }
 *   dirPath()                    -> { path }            (absolute folder path)
 */
@CapacitorPlugin(name = "DYFiles")
class DYFilesPlugin : Plugin() {

    companion object {
        const val MAX_READ = 200_000 // chars returned to the model
    }

    /** The shared DY OS folder; created on demand. */
    fun folder(): File =
        File(context.getExternalFilesDir(null), "DYOS").apply { mkdirs() }

    @PluginMethod
    fun dirPath(call: PluginCall) {
        call.resolve(JSObject().put("path", folder().absolutePath))
    }

    @PluginMethod
    fun list(call: PluginCall) {
        val arr = JSArray()
        folder().listFiles()?.sortedBy { it.name.lowercase() }?.forEach { f ->
            if (f.isFile) {
                arr.put(JSObject().put("name", f.name).put("size", f.length()))
            }
        }
        call.resolve(JSObject().put("files", arr))
    }

    @PluginMethod
    fun readText(call: PluginCall) {
        val name = call.getString("name") ?: run { call.reject("name is required"); return }
        val f = File(folder(), name)
        if (!f.exists() || !f.isFile) { call.reject("'$name' 파일이 없어요."); return }
        try {
            val bytes = f.readBytes()
            val text = String(bytes, Charsets.UTF_8)
            val out = if (text.length > MAX_READ) text.substring(0, MAX_READ) + "\n…(생략)" else text
            call.resolve(JSObject().put("content", out))
        } catch (e: Throwable) {
            call.reject("읽을 수 없어요(텍스트가 아닐 수 있어요): ${e.message}", Exception(e))
        }
    }

    /** Binary read for previews (images, 3D models, media). Capped to keep memory sane. */
    @PluginMethod
    fun readBase64(call: PluginCall) {
        val name = call.getString("name") ?: run { call.reject("name is required"); return }
        val f = File(folder(), name)
        if (!f.exists() || !f.isFile) { call.reject("'$name' 파일이 없어요."); return }
        if (f.length() > 40_000_000L) { call.reject("파일이 너무 커요 (40MB 초과)."); return }
        try {
            val b64 = Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
            call.resolve(JSObject().put("content", b64).put("mime", mimeOf(name)).put("size", f.length()))
        } catch (e: Throwable) {
            call.reject("읽을 수 없어요: ${e.message}", Exception(e))
        }
    }

    private fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
        return when (ext) {
            "glb" -> "model/gltf-binary"
            "gltf" -> "model/gltf+json"
            else -> "application/octet-stream"
        }
    }

    @PluginMethod
    fun writeText(call: PluginCall) {
        val name = call.getString("name") ?: run { call.reject("name is required"); return }
        val content = call.getString("content", "") ?: ""
        try {
            File(folder(), name).writeText(content, Charsets.UTF_8)
            call.resolve(JSObject().put("ok", true))
        } catch (e: Throwable) {
            call.reject("쓸 수 없어요: ${e.message}", Exception(e))
        }
    }

    /** Write a binary file from base64 (created docs: xlsx/docx/pptx/glb/etc). */
    @PluginMethod
    fun writeBase64(call: PluginCall) {
        val name = call.getString("name") ?: run { call.reject("name is required"); return }
        val content = call.getString("content", "") ?: ""
        try {
            File(folder(), name).writeBytes(Base64.decode(content, Base64.DEFAULT))
            call.resolve(JSObject().put("ok", true))
        } catch (e: Throwable) {
            call.reject("쓸 수 없어요: ${e.message}", Exception(e))
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val name = call.getString("name") ?: run { call.reject("name is required"); return }
        File(folder(), name).delete()
        call.resolve(JSObject().put("ok", true))
    }
}
