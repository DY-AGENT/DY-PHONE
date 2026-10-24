package com.dyagent.mobile

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.InputData
import com.google.ai.edge.litertlm.ResponseCallback
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.Session
import com.google.ai.edge.litertlm.SessionConfig
import java.io.File

/**
 * On-device Gemma 4 E2B (multimodal) inference for DY PHONE.
 *
 * Runs the `.litertlm` model bundle through Google's LiteRT-LM runtime
 * (com.google.ai.edge.litertlm:litertlm-android) fully on-device, GPU-first
 * with CPU fallback. Note: the runtime ships native libs for arm64-v8a and
 * x86_64 only — no 32-bit support.
 *
 * JS contract (see www/engine/llm.js):
 *   isReady() -> { ready }
 *   load({ modelPath }) -> { ok }
 *   generate({ messages, images }) -> streams 'token' events, resolves { text }
 */
@CapacitorPlugin(name = "GemmaLlm")
class GemmaLlmPlugin : Plugin() {

    private var engine: Engine? = null
    private var modelFile: File? = null
    @Volatile private var usingGpu = true
    @Volatile private var loading = false
    /** The session currently streaming, so cancel() can interrupt it. */
    @Volatile private var currentSession: Session? = null
    /** Set when the user presses stop; onNext re-requests cancel and mutes tokens. */
    @Volatile private var cancelRequested = false

    private val prefs
        get() = context.getSharedPreferences("dyagent", android.content.Context.MODE_PRIVATE)

    /** Set once GPU generation has failed on this device (e.g. no OpenCL). */
    private var forceCpu: Boolean
        get() = prefs.getBoolean("force_cpu", false)
        set(v) { prefs.edit().putBoolean("force_cpu", v).apply() }

    @PluginMethod
    fun isReady(call: PluginCall) {
        call.resolve(JSObject().put("ready", engine?.isInitialized() == true))
    }

    /** Stop the in-flight generation (user pressed the stop button). */
    @PluginMethod
    fun cancel(call: PluginCall) {
        cancelRequested = true
        try { currentSession?.cancelProcess() } catch (_: Throwable) {}
        GenerationService.stop(context)
        call.resolve()
    }

    /**
     * Load the model. `modelPath` may be an absolute path or a bare filename;
     * a bare filename is resolved against the app's files dir. Initialization
     * maps multi-GB weights, so it runs off the main thread. GPU (OpenCL) is
     * tried first, then CPU.
     */
    @PluginMethod
    fun load(call: PluginCall) {
        if (engine?.isInitialized() == true) { call.resolve(JSObject().put("ok", true)); return }
        if (loading) { call.reject("A model load is already in progress"); return }
        val nameOrPath = call.getString("modelPath") ?: run {
            call.reject("modelPath is required"); return
        }
        // Resolve a bare filename against the SAME place the downloader saves to
        // (getExternalFilesDir), falling back to internal filesDir. An absolute
        // path is used as-is.
        val file = if (nameOrPath.startsWith("/")) {
            File(nameOrPath)
        } else {
            val ext = File(context.getExternalFilesDir(null), nameOrPath)
            if (ext.exists()) ext else File(context.filesDir, nameOrPath)
        }
        if (!file.exists()) {
            call.reject("Model file not found at ${file.absolutePath}. Download it first.")
            return
        }

        loading = true
        Thread {
            try {
                modelFile = file
                if (forceCpu) {
                    engine = createEngine(file, Backend.CPU())
                    usingGpu = false
                } else {
                    engine = createEngine(file, Backend.GPU())
                    usingGpu = true
                }
                call.resolve(JSObject().put("ok", true))
            } catch (gpuErr: Throwable) {
                try {
                    engine = createEngine(file, Backend.CPU())
                    usingGpu = false
                    call.resolve(JSObject().put("ok", true))
                } catch (cpuErr: Throwable) {
                    call.reject("Failed to load model: ${cpuErr.message}", Exception(cpuErr))
                }
            } finally {
                loading = false
            }
        }.start()
    }

    private fun createEngine(file: File, backend: Backend): Engine {
        val e = Engine(
            EngineConfig(
                modelPath = file.absolutePath,
                backend = backend,
                maxNumTokens = 2048,
                maxNumImages = 4,
                cacheDir = context.cacheDir.absolutePath,
            )
        )
        e.initialize()
        return e
    }

    /**
     * Run one generation over the full message history the JS agent sends. We
     * flatten roles into a single prompt (the agent carries its own history and
     * calls statelessly), attach any images for the vision encoder, and stream
     * partial tokens back as 'token' events.
     */
    @PluginMethod
    fun generate(call: PluginCall) {
        val eng = engine ?: run { call.reject("Model not loaded"); return }
        if (!eng.isInitialized()) { call.reject("Model not loaded"); return }

        val messages = call.getArray("messages")
        val images = call.getArray("images")
        val prompt = flattenMessages(messages)

        val inputs = mutableListOf<InputData>()
        if (images != null) {
            for (i in 0 until images.length()) {
                decodeBase64(images.getString(i))?.let { inputs.add(InputData.Image(it)) }
            }
        }
        inputs.add(InputData.Text(prompt))

        // Keep the CPU running (foreground service + wakelock) so generation
        // finishes even if the screen turns off or the app is backgrounded.
        GenerationService.start(context)

        Thread {
            runGeneration(eng, inputs, call) { gpuErr ->
                // Some devices expose no OpenCL even though engine init succeeds
                // (the GPU delegate is set up lazily). Rebuild on CPU and retry
                // once, transparently; later generations reuse the CPU engine.
                val file = modelFile
                if (usingGpu && file != null) {
                    try {
                        forceCpu = true
                        val cpuEngine = createEngine(file, Backend.CPU())
                        try { engine?.close() } catch (ignored: Throwable) {}
                        engine = cpuEngine
                        usingGpu = false
                        runGeneration(cpuEngine, inputs, call) { cpuErr ->
                            GenerationService.stop(context)
                            call.reject("Generation failed: ${cpuErr.message}", Exception(cpuErr))
                        }
                    } catch (rebuildErr: Throwable) {
                        GenerationService.stop(context)
                        call.reject("Generation failed: ${rebuildErr.message}", Exception(rebuildErr))
                    }
                } else {
                    GenerationService.stop(context)
                    call.reject("Generation failed: ${gpuErr.message}", Exception(gpuErr))
                }
            }
        }.start()
    }

    /** Streams one generation; invokes onFail instead of rejecting so callers can retry. */
    private fun runGeneration(
        eng: Engine,
        inputs: List<InputData>,
        call: PluginCall,
        onFail: (Throwable) -> Unit,
    ) {
        try {
            // Low-temperature sampling: the default is too "creative" for an on-
            // device 2B model, which makes it emit stray tokens (even foreign
            // scripts) and broken code mid-generation. A low temperature with
            // top-k/top-p keeps long outputs like code coherent.
            val sampler = SamplerConfig(/*topK=*/40, /*topP=*/0.95, /*temperature=*/0.3, /*seed=*/0)
            val session = eng.createSession(SessionConfig(sampler))
            currentSession = session
            cancelRequested = false
            val full = StringBuilder()
            session.generateContentStream(inputs, object : ResponseCallback {
                override fun onNext(partial: String) {
                    if (cancelRequested) {
                        // Some runtimes ignore a cancel issued between tokens; keep
                        // re-requesting from the stream thread until it sticks, and
                        // stop forwarding tokens to the UI immediately.
                        try { session.cancelProcess() } catch (_: Throwable) {}
                        return
                    }
                    full.append(partial)
                    notifyListeners("token", JSObject().put("token", partial))
                }

                override fun onDone() {
                    currentSession = null
                    GenerationService.stop(context)
                    call.resolve(JSObject().put("text", full.toString()))
                    session.close()
                }

                override fun onError(t: Throwable) {
                    currentSession = null
                    session.close()
                    onFail(t)
                }
            })
        } catch (e: Throwable) {
            onFail(e)
        }
    }

    /**
     * Build the prompt using Gemma's real chat template so the model behaves as
     * trained. Gemma has no system role, so the system text is folded into the
     * first user turn. Using ad-hoc "User:/DY PHONE:" markers instead makes the
     * model echo the prompt and corrupt output — this fixes that.
     *
     *   <start_of_turn>user\n{system + content}<end_of_turn>
     *   <start_of_turn>model\n{content}<end_of_turn>
     *   … <start_of_turn>model\n   (open turn for the model to complete)
     */
    private fun flattenMessages(messages: com.getcapacitor.JSArray?): String {
        if (messages == null) return ""
        var system = ""
        val turns = ArrayList<Pair<String, String>>() // role(user|model) -> content
        for (i in 0 until messages.length()) {
            val m = messages.getJSONObject(i)
            val role = m.optString("role", "user")
            val content = m.optString("content", "")
            when (role) {
                "system" -> system += (if (system.isEmpty()) "" else "\n") + content
                "user" -> turns.add("user" to content)
                "assistant" -> turns.add("model" to content)
                else -> turns.add("user" to content)
            }
        }
        val sb = StringBuilder()
        var systemInjected = false
        for ((role, content) in turns) {
            val text = if (!systemInjected && role == "user" && system.isNotBlank()) {
                systemInjected = true
                "$system\n\n$content"
            } else content
            sb.append("<start_of_turn>").append(role).append("\n")
                .append(text).append("<end_of_turn>\n")
        }
        sb.append("<start_of_turn>model\n")
        return sb.toString()
    }

    /** Returns raw encoded image bytes (JPEG/PNG) from a data-URL or bare base64. */
    private fun decodeBase64(b64: String?): ByteArray? {
        if (b64.isNullOrEmpty()) return null
        return try {
            val clean = b64.substringAfter("base64,", b64)
            Base64.decode(clean, Base64.DEFAULT)
        } catch (e: Throwable) {
            null
        }
    }
}
