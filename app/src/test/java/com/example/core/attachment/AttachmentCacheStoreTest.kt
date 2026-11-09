package com.example.core.attachment

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AttachmentCacheStoreTest {
    @Test
    fun `sanitizeFilename strips path traversal and control characters`() {
        assertEquals(
            "quote.pdf",
            AttachmentCacheStore.sanitizeFilename("../quote.pdf")
        )
        assertEquals(
            "1.xlsx",
            AttachmentCacheStore.sanitizeFilename("invoice\\1.xlsx")
        )
        assertEquals(
            "attachment.bin",
            AttachmentCacheStore.sanitizeFilename("   ")
        )
    }

    @Test
    fun `chat and purchasing screens expose attach entry points`() {
        val appRoot = listOf(File("."), File("app"))
            .first { File(it, "src/main/AndroidManifest.xml").exists() }
        val chat = File(appRoot, "src/main/java/com/example/ui/ChatViews.kt").readText()
        val purchase = File(appRoot, "src/main/java/com/example/ui/PurchaseViews.kt").readText()
        assertTrue(chat.contains("AttachFile"))
        assertTrue(chat.contains("attachment_pick"))
        assertTrue(purchase.contains("PurchaseOrderAttachmentsDialog"))
        assertTrue(purchase.contains("attachment_list_title"))
        assertFalse(chat.contains("OutlinedTextField"))
    }
}
