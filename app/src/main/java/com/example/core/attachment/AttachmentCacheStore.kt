package com.example.core.attachment

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File

data class CachedAttachmentFile(
    val uri: Uri,
    val filename: String,
    val mimeType: String
)

/**
 * Writes downloaded attachment bytes into app cache and builds a shareable content Uri
 * for ACTION_VIEW. Reuses the existing FileProvider authority + reports cache path.
 */
class AttachmentCacheStore(
    context: Context,
    private val contentUriForFile: (Context, File) -> Uri = { appContext, file ->
        FileProvider.getUriForFile(
            appContext,
            "${appContext.packageName}.fileprovider",
            file
        )
    }
) {
    private val appContext = context.applicationContext
    private val directory = File(appContext.cacheDir, DIRECTORY_NAME)

    fun save(bytes: ByteArray, filename: String, mimeType: String): CachedAttachmentFile {
        require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) { "Unexpected attachment size" }
        ensureDirectory()
        val safeName = sanitizeFilename(filename)
        val target = File(directory, "${System.currentTimeMillis()}_$safeName")
        target.outputStream().use { it.write(bytes) }
        return CachedAttachmentFile(
            uri = contentUriForFile(appContext, target),
            filename = safeName,
            mimeType = mimeType
        )
    }

    fun openViewerIntent(file: CachedAttachmentFile): Intent {
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(file.uri, file.mimeType)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    private fun ensureDirectory() {
        if (!directory.exists()) check(directory.mkdirs()) { "Unable to create attachment cache" }
    }

    companion object {
        const val DIRECTORY_NAME = "reports"
        const val MAX_BYTES = 5 * 1024 * 1024

        fun sanitizeFilename(raw: String): String {
            val base = raw.trim().substringAfterLast('/').substringAfterLast('\\')
            val cleaned = base.replace("..", ".").filter { it.code >= 32 }.take(120)
            return cleaned.ifBlank { "attachment.bin" }
        }
    }
}
