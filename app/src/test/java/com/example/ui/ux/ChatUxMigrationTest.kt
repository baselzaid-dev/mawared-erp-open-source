package com.example.ui.ux

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ChatUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `chat directory search and composer use shared text fields`() {
        val source = File(appRoot, "src/main/java/com/example/ui/ChatViews.kt").readText()
        assertTrue(source.contains("MawaredTextField"))
        assertTrue(source.contains("DirectoryPanel"))
        assertTrue(source.contains("ChatComposer"))

        val directoryPanel = source.substringAfter("private fun DirectoryPanel")
            .substringBefore("private fun DirectoryRow")
        assertTrue(directoryPanel.contains("MawaredTextField"))
        assertFalse(directoryPanel.contains("OutlinedTextField"))

        val composer = source.substringAfter("private fun ChatComposer")
            .substringBefore("private fun EmptyChatState")
        assertTrue(composer.contains("MawaredTextField"))
        assertFalse(composer.contains("OutlinedTextField"))
        assertTrue(composer.contains("ChatUiRules.canSend"))
        assertTrue(composer.contains("R.string.chat_text_only_hint") || composer.contains("attachment_pick"))
        assertTrue(composer.contains("AttachFile") || composer.contains("attachment_pick"))
    }
}
