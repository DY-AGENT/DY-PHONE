package com.dyagent.mobile

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.view.Gravity
import android.webkit.URLUtil
import android.widget.Toast
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.math.roundToInt

/**
 * DY browser — a REAL native WebView overlay for DY OS.
 *
 * Why not an <iframe>: framing is blocked by X-Frame-Options / CSP on Google,
 * Naver, banks, etc., so an iframe just shows blank. A top-level native WebView
 * loads those pages normally (framing rules don't apply) and keeps its own
 * persistent cookie jar — log in once, stay logged in. It's a separate session
 * from the system Chrome (Android sandboxes each app), which is expected.
 *
 * The overlay has its own minimal chrome (back · address · reload · close) drawn
 * natively on top of the WebView, so it reads as "DY browser" inside the app.
 *
 * JS contract (see www/vos/vos.js):
 *   open({ url }) -> shows the overlay and loads url
 *   close()       -> hides the overlay
 */
@CapacitorPlugin(name = "DYBrowser")
class DYBrowserPlugin : Plugin() {

    private var overlay: FrameLayout? = null
    private var web: WebView? = null
    private var addressBar: EditText? = null

    private fun dp(v: Int) = (v * context.resources.displayMetrics.density).roundToInt()

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    fun open(call: PluginCall) {
        val url = call.getString("url")?.trim()
            ?: run { call.reject("url is required"); return }
        activity.runOnUiThread {
            try {
                if (overlay == null) build()
                overlay?.visibility = View.VISIBLE
                addressBar?.setText(url)
                web?.loadUrl(url)
                call.resolve(JSObject().put("ok", true))
            } catch (e: Throwable) {
                call.reject("브라우저를 열 수 없어요: ${e.message}", Exception(e))
            }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        activity.runOnUiThread {
            overlay?.visibility = View.GONE
            call.resolve()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build() {
        val root = activity.findViewById<ViewGroup>(android.R.id.content)

        val container = FrameLayout(context).apply {
            setBackgroundColor(Color.parseColor("#0b0d12"))
            fitsSystemWindows = true
        }

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // --- top control bar ---
        val bar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(10), dp(8), dp(10))
            setBackgroundColor(Color.parseColor("#141821"))
        }
        val back = navBtn("‹") { web?.let { if (it.canGoBack()) it.goBack() } }
        val reload = navBtn("⟳") { web?.reload() }
        val address = EditText(context).apply {
            setSingleLine(true)
            setTextColor(Color.parseColor("#e8ecf4"))
            setHintTextColor(Color.parseColor("#8a93a6"))
            hint = "검색어 또는 https:// 주소"
            textSize = 13f
            setBackgroundColor(Color.parseColor("#1c2230"))
            setPadding(dp(12), dp(9), dp(12), dp(9))
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, _, _ ->
                go(text.toString()); true
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { marginStart = dp(6); marginEnd = dp(6) }
        }
        addressBar = address
        val closeBtn = navBtn("✕") { overlay?.visibility = View.GONE }
        bar.addView(back)
        bar.addView(reload)
        bar.addView(address)
        bar.addView(closeBtn)
        column.addView(
            bar,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        )

        // --- the WebView ---
        val wv = WebView(context)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            javaScriptCanOpenWindowsAutomatically = true
            mediaPlaybackRequiresUserGesture = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(wv, true)
        }
        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(v: WebView?, u: String?, f: android.graphics.Bitmap?) {
                if (u != null && addressBar?.hasFocus() != true) addressBar?.setText(u)
            }
        }
        wv.webChromeClient = WebChromeClient()

        // Downloads → the shared DY OS folder (getExternalFilesDir/DYOS), via
        // the system DownloadManager so it survives screen-off and shows in the
        // notification shade. Carries the WebView's cookies for logged-in files.
        wv.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimetype)
                val req = DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setDescription("DY OS 폴더로 저장")
                    .setMimeType(mimetype)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                    .setDestinationInExternalFilesDir(context, null, "DYOS/$name")
                CookieManager.getInstance().getCookie(url)?.let {
                    req.addRequestHeader("cookie", it)
                }
                val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(req)
                Toast.makeText(context, "다운로드 시작: $name", Toast.LENGTH_SHORT).show()
            } catch (e: Throwable) {
                Toast.makeText(context, "다운로드 실패: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
        wv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        )
        column.addView(wv)
        web = wv

        container.addView(column)
        root.addView(
            container,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        overlay = container
    }

    private fun go(input: String) {
        val t = input.trim()
        val url = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) t
        else "https://www.google.com/search?q=" + android.net.Uri.encode(t)
        web?.loadUrl(url)
    }

    private fun navBtn(label: String, onClick: () -> Unit): Button =
        Button(context).apply {
            text = label
            textSize = 16f
            setTextColor(Color.parseColor("#e8ecf4"))
            setBackgroundColor(Color.TRANSPARENT)
            minWidth = dp(40)
            setPadding(dp(6), 0, dp(6), 0)
            setOnClickListener { onClick() }
        }
}
