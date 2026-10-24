package com.dyagent.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps on-device model generation alive when the screen turns off or the app
 * is backgrounded.
 *
 * On Android, a plain background thread (like the one GemmaLlmPlugin uses for
 * inference) gets its CPU suspended once the screen is off / the app is idle, so
 * a long generation stalls and "화면을 끄면 답이 안 온다". This foreground service
 * (with an ongoing notification) plus a PARTIAL_WAKE_LOCK keeps the CPU running
 * so the answer finishes in the background; when the user returns, it's ready.
 *
 * GemmaLlmPlugin.start()s this at the beginning of a generate() and stop()s it
 * when the generation resolves or fails.
 */
class GenerationService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dyagent:generation").apply {
            setReferenceCounted(false)
            // Safety cap: released explicitly on stop; this just prevents a stuck
            // lock if the process is killed mid-generation.
            acquire(15 * 60 * 1000L)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
        wakeLock = null
        super.onDestroy()
    }

    private fun startInForeground() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "AI 응답 생성", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            mgr.createNotificationChannel(ch)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val notif = builder
            .setContentTitle("DY PHONE")
            .setContentText("응답을 생성하는 중… (화면을 꺼도 계속돼요)")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    companion object {
        private const val CHANNEL = "dyagent_generation"
        private const val NOTIF_ID = 4711

        fun start(ctx: Context) {
            try {
                val i = Intent(ctx, GenerationService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (_: Throwable) {
                // If the OS refuses (e.g. started from background on 14+), fall back
                // to running without the service — generation still works while the
                // app is foreground.
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, GenerationService::class.java)) } catch (_: Throwable) {}
        }
    }
}
