package com.example.ui

import android.content.Context
import androidx.core.content.FileProvider
import com.example.core.export.ReportShareFile
import com.example.domain.model.ReportExportPayload
import java.io.File

/**
 * Sprint 12H — payroll payments/exports (CSV/XLSX/PDF).
 *
 * Mirrors `core.export.ReportExportStore` but supports the three mime types payroll
 * exports can return (the reports store is intentionally CSV-only). Reuses the SAME
 * FileProvider authority + "reports" cache-path already declared in AndroidManifest.xml,
 * so no manifest or resource changes are required for this sprint.
 */
class PayrollExportStore(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis
) {
    private val appContext = context.applicationContext
    private val exportDirectory = File(appContext.cacheDir, "reports")

    fun save(payload: ReportExportPayload): ReportShareFile {
        val mime = payload.mimeType.substringBefore(';').trim()
        require(mime in ALLOWED_MIME_TYPES) { "Unexpected payroll export type" }
        require(payload.bytes.isNotEmpty() && payload.bytes.size <= MAX_BYTES) {
            "Unexpected payroll export size"
        }
        ensureDirectory()
        cleanStale()
        val filename = sanitizeFilename(payload.filename, fallbackExtensionFor(mime))
        val target = uniqueTarget(filename)
        ensureInsideDirectory(target)
        val temporary = File.createTempFile("payroll_export_", ".tmp", exportDirectory)
        try {
            temporary.outputStream().use { it.write(payload.bytes) }
            check(temporary.renameTo(target)) { "Unable to finalize payroll export file" }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
        val uri = FileProvider.getUriForFile(
            appContext,
            "${appContext.packageName}.fileprovider",
            target
        )
        check(uri.scheme == "content" && uri.authority == "${appContext.packageName}.fileprovider") {
            "Invalid payroll export sharing URI"
        }
        return ReportShareFile(uri, target.name, mime)
    }

    fun clear() {
        if (!exportDirectory.exists()) return
        exportDirectory.listFiles()?.forEach { file ->
            if (file.isFile && file.name.startsWith(FILE_PREFIX) && isInsideDirectory(file)) {
                file.delete()
            }
        }
    }

    private fun ensureDirectory() {
        check(exportDirectory.exists() || exportDirectory.mkdirs()) { "Unable to create export cache" }
        check(exportDirectory.isDirectory) { "Invalid export cache" }
    }

    private fun uniqueTarget(filename: String): File {
        val initial = File(exportDirectory, "$FILE_PREFIX$filename")
        if (!initial.exists()) return initial
        val dot = filename.lastIndexOf('.')
        val base = if (dot > 0) filename.substring(0, dot) else filename
        val ext = if (dot > 0) filename.substring(dot) else ""
        return File(exportDirectory, "$FILE_PREFIX${base}_${now()}$ext")
    }

    private fun cleanStale() {
        val files = exportDirectory.listFiles()
            ?.filter { it.isFile && it.name.startsWith(FILE_PREFIX) && isInsideDirectory(it) }
            ?.sortedByDescending { it.lastModified() }
            .orEmpty()
        files.forEachIndexed { index, file ->
            if (index >= MAX_FILES || now() - file.lastModified() > MAX_AGE_MS) file.delete()
        }
    }

    private fun ensureInsideDirectory(file: File) {
        check(isInsideDirectory(file)) { "Invalid payroll export path" }
    }

    private fun isInsideDirectory(file: File): Boolean =
        file.canonicalFile.parentFile == exportDirectory.canonicalFile

    private fun fallbackExtensionFor(mime: String): String = when (mime) {
        "text/csv" -> "csv"
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" -> "xlsx"
        "application/pdf" -> "pdf"
        else -> "bin"
    }

    private fun sanitizeFilename(candidate: String?, fallbackExtension: String): String {
        val value = candidate?.trim()?.removeSurrounding("\"")
        if (value != null &&
            !value.contains('/') && !value.contains('\\') && !value.contains("..") &&
            value.none { it.code < 32 } && SAFE_FILENAME_PATTERN.matches(value)
        ) {
            return value
        }
        return "mawared_payroll_export.$fallbackExtension"
    }

    companion object {
        const val MAX_BYTES = 10 * 1024 * 1024
        private const val MAX_FILES = 20
        private const val MAX_AGE_MS = 24 * 60 * 60 * 1000L
        private const val FILE_PREFIX = "payroll_export_"
        private val SAFE_FILENAME_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
        private val ALLOWED_MIME_TYPES = setOf(
            "text/csv",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/pdf"
        )
    }
}
