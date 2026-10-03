package com.example.student_app

import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : FlutterActivity(), NfcAdapter.ReaderCallback {
    private val methodChannelName = "campus_wallet/nfc"
    private val eventChannelName = "campus_wallet/nfc_events"
    private val preferencesName = "campus_wallet_nfc"
    private val receiveTokenKey = "receive_token"
    private val mainHandler = Handler(Looper.getMainLooper())
    private val tagHandled = AtomicBoolean(false)
    private var eventSink: EventChannel.EventSink? = null
    private var nfcAdapter: NfcAdapter? = null
    private var readerActive = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        nfcAdapter = NfcAdapter.getDefaultAdapter(this)
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, eventChannelName)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            })
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, methodChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "capabilities" -> result.success(
                        mapOf(
                            "reader" to (nfcAdapter?.isEnabled == true),
                            "hostCardEmulation" to packageManager.hasSystemFeature(
                                PackageManager.FEATURE_NFC_HOST_CARD_EMULATION
                            ) && nfcAdapter?.isEnabled == true,
                        )
                    )
                    "startReader" -> startReader(result)
                    "stopReader" -> {
                        stopReader()
                        result.success(null)
                    }
                    "setReceiveToken" -> {
                        val token = call.arguments as? String
                        if (token.isNullOrBlank() || token.length > 100) {
                            result.error("invalid_token", "Invalid NFC receive token", null)
                        } else {
                            getSharedPreferences(preferencesName, MODE_PRIVATE)
                                .edit()
                                .putString(receiveTokenKey, token)
                                .apply()
                            result.success(null)
                        }
                    }
                    "clearReceiveToken" -> {
                        getSharedPreferences(preferencesName, MODE_PRIVATE)
                            .edit()
                            .remove(receiveTokenKey)
                            .apply()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun startReader(result: MethodChannel.Result) {
        val adapter = nfcAdapter
        if (adapter == null || !adapter.isEnabled) {
            result.error("nfc_unavailable", "Turn on NFC to scan a recipient phone", null)
            return
        }
        tagHandled.set(false)
        adapter.enableReaderMode(
            this,
            this,
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            Bundle(),
        )
        readerActive = true
        result.success(null)
    }

    private fun stopReader() {
        if (readerActive) {
            nfcAdapter?.disableReaderMode(this)
            readerActive = false
        }
    }

    override fun onTagDiscovered(tag: Tag) {
        if (!tagHandled.compareAndSet(false, true)) return
        try {
            val isoDep = IsoDep.get(tag)
                ?: throw IOException("The NFC device does not support ISO-DEP")
            isoDep.connect()
            isoDep.timeout = 5000
            val selectResponse = isoDep.transceive(SELECT_APDU)
            if (!hasSuccessStatus(selectResponse)) {
                throw IOException("The tapped phone did not provide a Campus Wallet receive session")
            }
            val tokenResponse = isoDep.transceive(GET_TOKEN_APDU)
            if (!hasSuccessStatus(tokenResponse) || tokenResponse.size <= 2) {
                throw IOException("No active NFC receive session was found")
            }
            val token = String(tokenResponse, 0, tokenResponse.size - 2, StandardCharsets.UTF_8)
            mainHandler.post {
                eventSink?.success(token)
                stopReader()
            }
        } catch (exception: Exception) {
            mainHandler.post {
                eventSink?.error("nfc_read_failed", exception.message ?: "Could not read NFC session", null)
                stopReader()
            }
        } finally {
            try {
                IsoDep.get(tag)?.close()
            } catch (_: IOException) {
            }
        }
    }

    override fun onPause() {
        stopReader()
        super.onPause()
    }

    override fun onDestroy() {
        stopReader()
        super.onDestroy()
    }

    private fun hasSuccessStatus(response: ByteArray): Boolean =
        response.size >= 2 &&
            response[response.size - 2] == 0x90.toByte() &&
            response[response.size - 1] == 0x00.toByte()

    companion object {
        private val SELECT_APDU = byteArrayOf(
            0x00, 0xA4.toByte(), 0x04, 0x00, 0x0A,
            0xF0.toByte(), 0x39, 0x43, 0x41, 0x4D,
            0x50, 0x55, 0x53, 0x01, 0x00,
        )
        private val GET_TOKEN_APDU = byteArrayOf(
            0x00, 0xCA.toByte(), 0x00, 0x00, 0x00,
        )
    }
}
