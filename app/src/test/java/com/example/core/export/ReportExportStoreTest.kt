package com.example.core.export

import androidx.test.core.app.ApplicationProvider
import android.net.Uri
import com.example.domain.model.ReportExportPayload
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class ReportExportStoreTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var store: ReportExportStore

    @Before
    fun setUp() {
        store = ReportExportStore(context) { _, file ->
            Uri.Builder()
                .scheme("content")
                .authority("${context.packageName}.fileprovider")
                .appendPath("reports")
                .appendPath(file.name)
                .build()
        }
        store.clear()
    }

    @After
    fun tearDown() {
        store.clear()
    }

    @Test
    fun `filename parser rejects path traversal and unsafe extensions`() {
        assertEquals(
            "mawared_report.csv",
            ReportExportFilename.fromContentDisposition(
                "attachment; filename=..%2F..%2Fprivate.csv",
                "mawared_report.csv"
            )
        )
        assertEquals(
            "mawared_report.csv",
            ReportExportFilename.sanitize("report.apk")
        )
        assertEquals(
            "mawared_attendance_20260711.csv",
            ReportExportFilename.sanitize("mawared_attendance_20260711.csv")
        )
    }

    @Test
    fun `report is cache only and shared through a content URI`() {
        val share = store.save(
            ReportExportPayload(
                bytes = "\uFEFF\"العنوان\"\r\n".toByteArray(),
                filename = "mawared_attendance.csv",
                mimeType = "text/csv"
            )
        )
        assertEquals("content", share.uri.scheme)
        assertEquals("text/csv", share.mimeType)
        val reportFile = File(context.cacheDir, "reports/${share.filename}")
        assertTrue(reportFile.exists())
        assertTrue(reportFile.canonicalPath.startsWith(context.cacheDir.canonicalPath))

        store.clear()
        assertFalse(reportFile.exists())
    }
}
