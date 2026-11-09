package com.example.ui

import com.example.data.model.Task
import com.example.domain.model.TaskParams

/**
 * Domain to legacy-UI-model mapper for the Tasks screen.
 *
 * Training renders API domain models directly. Tasks keeps this narrow
 * compatibility mapper until its old Room-shaped display model is retired.
 */

/** A task is "completed" in the old UI exactly when its domain status says so. */
internal const val TASK_STATUS_COMPLETED = "مكتملة"
internal const val TASK_STATUS_OPEN = "قيد التنفيذ"
internal const val TASK_STATUS_NEW = "جديدة"

internal fun TaskParams.toLegacyTask() = Task(
    id = id,
    title = title,
    description = description ?: "",
    dueDate = dueDate ?: "",
    priority = priority ?: "متوسطة",
    isCompleted = status == TASK_STATUS_COMPLETED
)
