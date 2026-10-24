package com.dyagent.mobile

import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Calls and SMS via standard Android intents — NOT accessibility.
 *
 * This is the safe, store-friendly way to "act on the user's behalf": we hand
 * off to the system dialer / messaging app with the number and text pre-filled,
 * and the user taps the final Call/Send button themselves. No CALL_PHONE or
 * SEND_SMS permission, nothing for Play Protect to flag. The in-app confirmation
 * ("○○에게 전화 걸까요?") happens in the JS layer before this is ever called.
 *
 * JS contract (see www/engine/tools.js):
 *   dial({ number })          -> opens the dialer with the number filled in
 *   sms({ number, body })     -> opens the SMS app with recipient + text filled in
 */
@CapacitorPlugin(name = "PhoneActions")
class PhoneActionsPlugin : Plugin() {

    @PluginMethod
    fun dial(call: PluginCall) {
        val number = call.getString("number")?.trim()
            ?: run { call.reject("number is required"); return }
        try {
            val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("ok", true))
        } catch (e: Throwable) {
            call.reject("전화 앱을 열 수 없어요: ${e.message}", Exception(e))
        }
    }

    @PluginMethod
    fun sms(call: PluginCall) {
        val number = call.getString("number")?.trim()
            ?: run { call.reject("number is required"); return }
        val body = call.getString("body", "") ?: ""
        try {
            // ACTION_SENDTO with an smsto: URI targets the messaging app directly.
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)))
                .putExtra("sms_body", body)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("ok", true))
        } catch (e: Throwable) {
            call.reject("문자 앱을 열 수 없어요: ${e.message}", Exception(e))
        }
    }
}
