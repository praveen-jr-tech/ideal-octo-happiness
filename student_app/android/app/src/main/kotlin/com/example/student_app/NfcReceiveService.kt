package com.example.student_app

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import java.nio.charset.StandardCharsets

class NfcReceiveService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
        if (isSelectAid(commandApdu)) return SUCCESS_STATUS
        if (commandApdu.contentEquals(GET_TOKEN_APDU)) {
            val token = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
                .getString(RECEIVE_TOKEN_KEY, null)
                ?: return NOT_FOUND_STATUS
            val tokenBytes = token.toByteArray(StandardCharsets.UTF_8)
            return tokenBytes + SUCCESS_STATUS
        }
        return NOT_FOUND_STATUS
    }

    override fun onDeactivated(reason: Int) = Unit

    private fun isSelectAid(command: ByteArray): Boolean {
        if (command.size < 15 ||
            command[0] != 0x00.toByte() ||
            command[1] != 0xA4.toByte() ||
            command[2] != 0x04.toByte()
        ) {
            return false
        }
        return command.copyOfRange(5, 15).contentEquals(AID)
    }

    companion object {
        private const val PREFERENCES_NAME = "campus_wallet_nfc"
        private const val RECEIVE_TOKEN_KEY = "receive_token"
        private val AID = byteArrayOf(
            0xF0.toByte(), 0x39, 0x43, 0x41, 0x4D,
            0x50, 0x55, 0x53, 0x01, 0x00,
        )
        private val SUCCESS_STATUS = byteArrayOf(0x90.toByte(), 0x00)
        private val NOT_FOUND_STATUS = byteArrayOf(0x6A, 0x82.toByte())
        private val GET_TOKEN_APDU = byteArrayOf(
            0x00, 0xCA.toByte(), 0x00, 0x00, 0x00,
        )
    }
}
