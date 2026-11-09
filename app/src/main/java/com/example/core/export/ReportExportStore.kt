package com.example.core.export

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import com.example.domain.model.ReportExportPayload
import java.io.File
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class ReportShareFile(
    val uri: Uri,
    val filename: String,
    val mimeType: String
)

object ReportExportFilename {
    private val filenamePattern = Regex(
        "filename\\*?=\\s*(?:UTF-8''|\")?([^\";]+)",
        RegexOption.IGNORE_CASE
    )
    private val safePattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\\.csv$", RegexOption.IGNORE_CASE)

    fun fromContentDisposition(header: String?, fallback: String): String {
        val encoded = header?.let { filenamePattern.find(it)?.groupValues?.getOrNull(1) }
        val decoded = try {
            encoded?.let { URLDecoder.decode(it.trim(), StandardCharsets.UTF_8.name()) }
        } catch (_: IllegalArgumentException) {
            null
        }
        return sanitize(decoded, fallback)
    }

    fun sanitize(candidate: String?, fallback: String = "mawared_report.csv"): String {
        val cleanFallback = fallback.takeIf { safePattern.matches(it) } ?: "mawared_report.csv"
        val value = candidate?.trim()?.removeSurrounding("\"") ?: return cleanFallback
        if (
            value.contains('/') ||
            value.contains('\\') ||
            value.contains("..") ||
            value.any { it.code < 32 } ||
            !safePattern.matches(value)
        ) {
            return cleanFallback
        }
        return value
    }
}

class ReportExportStore(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis,
    private val contentUriForFile: (Context, File) -> Uri = { appContext, file ->
        FileProvider.getUriForFile(
            appContext,
            "${appContext.packageName}.fileprovider",
            file
        )
    }
) {
    private val appContext = context.applicationContext
    private val reportDirectory = File(appContext.cacheDir, DIRECTORY_NAME)

    fun save(payload: ReportExportPayload): ReportShareFile {
        require(payload.mimeType.substringBefore(';').trim().equals(CSV_MIME, ignoreCase = true)) {
            "Unexpected report type"
        }
        require(payload.bytes.isNotEmpty() && payload.bytes.size <= MAX_BYTES) {
            "Unexpected report size"
        }
        ensureDirectory()
        cleanStale()
        val filename = ReportExportFilename.sanitize(payload.filename)
        val target = uniqueTarget(filename)
        ensureInsideDirectory(target)
        val temporary = File.createTempFile("report_", ".tmp", reportDirectory)
        try {
            temporary.outputStream().use { it.write(payload.bytes) }
            check(temporary.renameTo(target)) { "Unable to finalize report file" }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        val uri = contentUriForFile(appContext, target)
        check(uri.scheme == "content" && uri.authority == "${appContext.packageName}.fileprovider") {
            "Invalid report sharing URI"
        }
        return ReportShareFile(uri, target.name, CSV_MIME)
    }

    fun clear() {
        if (!reportDirectory.exists()) return
        reportDirectory.listFiles()?.forEach { file ->
            if (file.isFile && isInsideDirectory(file)) file.delete()
        }
    }

    private fun ensureDirectory() {
        check(reportDirectory.exists() || reportDirectory.mkdirs()) {
            "Unable to create report cache"
        }
        check(reportDirectory.isDirectory) { "Invalid report cache" }
    }

    private fun uniqueTarget(filename: String): File {
        val initial = File(reportDirectory, filename)
        if (!initial.exists()) return initial
        val base = filename.removeSuffix(".csv")
        return File(reportDirectory, "${base}_${now()}.csv")
    }

    private fun cleanStale() {
        val files = reportDirectory.listFiles()?.filter { it.isFile && isInsideDirectory(it) }
            ?.sortedByDescending { it.lastModified() }
            .orEmpty()
        files.forEachIndexed { index, file ->
            if (index >= MAX_FILES || now() - file.lastModified() > MAX_AGE_MS) file.delete()
        }
    }

    private fun ensureInsideDirectory(file: File) {
        check(isInsideDirectory(file)) { "Invalid report path" }
    }

    private fun isInsideDirectory(file: File): Boolean =
        file.canonicalFile.parentFile == reportDirectory.canonicalFile

    companion object {
        const val CSV_MIME = "text/csv"
        const val MAX_BYTES = 10 * 1024 * 1024
        private const val DIRECTORY_NAME = "reports"
        private const val MAX_FILES = 20
        private const val MAX_AGE_MS = 24 * 60 * 60 * 1000L
    }
}
