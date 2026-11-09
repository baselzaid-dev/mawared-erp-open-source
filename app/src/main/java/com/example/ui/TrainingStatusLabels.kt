package com.example.ui

import androidx.annotation.StringRes
import com.example.R

@StringRes
internal fun trainingCourseStatusLabelRes(status: String): Int = when (status) {
    "draft" -> R.string.training_status_draft
    "published" -> R.string.training_status_published
    "completed" -> R.string.training_status_completed
    "cancelled" -> R.string.training_status_cancelled
    "archived" -> R.string.training_status_archived
    else -> R.string.status_unknown
}

@StringRes
internal fun trainingAssignmentStatusLabelRes(status: String): Int = when (status) {
    "assigned" -> R.string.training_assignment_assigned
    "in_progress" -> R.string.training_assignment_in_progress
    "submitted" -> R.string.training_assignment_submitted
    "completed" -> R.string.training_assignment_completed
    "returned" -> R.string.training_assignment_returned
    "cancelled" -> R.string.training_assignment_cancelled
    else -> R.string.status_unknown
}

@StringRes
internal fun trainingDeliveryLabelRes(mode: String): Int = when (mode) {
    "onsite" -> R.string.training_delivery_onsite
    "online" -> R.string.training_delivery_online
    "hybrid" -> R.string.training_delivery_hybrid
    "self_paced" -> R.string.training_delivery_self_paced
    else -> R.string.status_unknown
}
