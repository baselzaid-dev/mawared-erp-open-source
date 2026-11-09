package com.example.ui

import com.example.domain.model.TrainingExportFormat
import com.example.domain.model.TrainingTimelineEvent
import com.example.domain.model.TrainingTimelineParams
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Sprint 12K — Training timeline/export UI helpers.
 * Pure JVM rules so gating and Arabic labels stay unit-testable without Compose.
 */

data class TrainingTimelineUiState(
    val courseId: String? = null,
    val timeline: TrainingTimelineParams? = null,
    val isLoading: Boolean = false,
    val errorMessage: String? = null
)

data class TrainingExportUiState(
    val exportingFormat: TrainingExportFormat? = null,
    val progressMessage: String? = null,
    val completionMessage: String? = null,
    val errorMessage: String? = null
)

/** Export buttons require `training.report` (matches Backend checkTrainingExportPermissions). */
internal fun canShowTrainingExportActions(canReport: Boolean): Boolean = canReport

internal fun trainingExportFormats(): List<TrainingExportFormat> = TrainingExportFormat.entries.toList()

internal fun trainingTimelineEventLabel(type: String): String = when (type) {
    "course.created" -> "إنشاء الدورة"
    "course.published" -> "نشر الدورة"
    "course.completed" -> "إكمال الدورة"
    "course.cancelled" -> "إلغاء الدورة"
    "course.archived" -> "أرشفة الدورة"
    "assignment.assigned" -> "إسناد تكليف"
    "assignment.submitted" -> "تسليم التكليف"
    "assignment.reviewed" -> "مراجعة التكليف"
    else -> type
}

/**
 * Formats Backend ISO timestamps for Arabic/RTL display.
 * Prefers `yyyy-MM-dd HH:mm` (UTC) and falls back to the raw value.
 */
internal fun formatTrainingTimelineAt(at: String): String {
    val trimmed = at.trim()
    if (trimmed.isEmpty()) return trimmed
    val parsers = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSX",
        "yyyy-MM-dd'T'HH:mm:ssX",
        "yyyy-MM-dd"
    )
    for (pattern in parsers) {
        val parsed = runCatching {
            SimpleDateFormat(pattern, Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
                isLenient = false
            }.parse(trimmed)
        }.getOrNull() ?: continue
        return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(parsed)
    }
    return if (trimmed.length >= 16) trimmed.take(16).replace('T', ' ') else trimmed
}

internal fun trainingTimelineEmpty(timeline: TrainingTimelineParams?): Boolean =
    timeline == null || timeline.events.isEmpty()

internal fun trainingTimelineSortedEvents(timeline: TrainingTimelineParams?): List<TrainingTimelineEvent> =
    timeline?.events?.sortedBy { it.at }.orEmpty()
