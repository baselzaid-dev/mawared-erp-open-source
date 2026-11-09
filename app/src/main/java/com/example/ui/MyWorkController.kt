package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.CurrentSession
import com.example.domain.model.MyWorkPermissions
import com.example.domain.model.MyWorkSnapshot
import com.example.domain.model.TaskFilters
import com.example.domain.repository.AttendanceRepository
import com.example.domain.repository.LeaveRepository
import com.example.domain.repository.TaskRepository
import kotlinx.coroutines.flow.first

sealed interface MyWorkUiState {
    data object Loading : MyWorkUiState

    data class Content(
        val items: List<com.example.domain.model.MyWorkItem>,
        val selectedCategory: String? = null
    ) : MyWorkUiState

    data object Empty : MyWorkUiState

    data class Error(val message: String) : MyWorkUiState
}

interface MyWorkActions {
    fun onItemClick(item: com.example.domain.model.MyWorkItem)
    fun onCategorySelected(category: String?)
    fun onRetry()
}

/**
 * Loads My Work from existing module repositories or from a preloaded snapshot.
 * Wiring into MawaredViewModel / DependencyProvider is handled by Agent A.
 */
class MyWorkController(
    private val leaveRepository: LeaveRepository? = null,
    private val taskRepository: TaskRepository? = null,
    private val attendanceRepository: AttendanceRepository? = null
) {
    data class LoadRequest(
        val session: CurrentSession,
        val category: String? = null,
        val snapshot: MyWorkSnapshot? = null
    )

    suspend fun load(request: LoadRequest): MyWorkUiState {
        val permissions = MyWorkPermissions.from(request.session.permissions)
        if (!permissions.hasAnySource) {
            return MyWorkUiState.Empty
        }

        val snapshotResult = request.snapshot?.let { AppResult.Success(it) } ?: loadSnapshot(request.session, permissions)
        return when (snapshotResult) {
            is AppResult.Success -> buildUiState(snapshotResult.data, permissions, request.category)
            is AppResult.Error -> MyWorkUiState.Error(
                snapshotResult.appError?.message ?: snapshotResult.exception.message ?: "تعذّر تحميل عملي."
            )
            AppResult.Loading -> MyWorkUiState.Loading
        }
    }

    fun buildFromSnapshot(
        snapshot: MyWorkSnapshot,
        permissions: MyWorkPermissions,
        category: String? = null
    ): MyWorkUiState = buildUiState(snapshot, permissions, category)

    private fun buildUiState(
        snapshot: MyWorkSnapshot,
        permissions: MyWorkPermissions,
        category: String?
    ): MyWorkUiState {
        val items = MyWorkAggregator.aggregate(snapshot, permissions, category)
        return when {
            items.isEmpty() && category == null -> MyWorkUiState.Empty
            else -> MyWorkUiState.Content(items = items, selectedCategory = category)
        }
    }

    private suspend fun loadSnapshot(
        session: CurrentSession,
        permissions: MyWorkPermissions
    ): AppResult<MyWorkSnapshot> {
        if (leaveRepository == null || taskRepository == null || attendanceRepository == null) {
            return AppResult.Error(
                Exception("My Work repositories are not wired yet.")
            )
        }

        val errors = mutableListOf<String>()

        val leaveReviewQueue = if (permissions.canReviewLeaves) {
            when (val refresh = leaveRepository.refreshLeaveReview()) {
                is AppResult.Error -> {
                    errors += refreshMessage(refresh, "تعذّر تحميل إجازات المراجعة.")
                    emptyList()
                }
                else -> leaveRepository.observeLeaveRequests().first()
            }
        } else {
            emptyList()
        }

        val ownLeaves = if (permissions.canViewOwnLeaves && !session.employeeId.isNullOrBlank()) {
            when (val refresh = leaveRepository.refreshMyLeaveRequests()) {
                is AppResult.Error -> {
                    errors += refreshMessage(refresh, "تعذّر تحميل إجازاتي.")
                    emptyList()
                }
                else -> leaveRepository.observeMyLeaveRequests(session.employeeId!!).first()
            }
        } else {
            emptyList()
        }

        val tasks = if (permissions.canViewTasks || permissions.canReviewTasks) {
            val filters = taskFiltersFor(session)
            when (val refresh = taskRepository.refreshTasks(filters)) {
                is AppResult.Error -> {
                    errors += refreshMessage(refresh, "تعذّر تحميل المهام.")
                    emptyList()
                }
                else -> taskRepository.observeTasks().first()
            }
        } else {
            emptyList()
        }

        val todayAttendance = if (permissions.canClockAttendance || permissions.canViewOwnAttendance) {
            when (val refresh = attendanceRepository.refreshAttendance()) {
                is AppResult.Error -> {
                    errors += refreshMessage(refresh, "تعذّر تحميل حضور اليوم.")
                    emptyList()
                }
                else -> attendanceRepository.observeTodayAttendance().first()
            }
        } else {
            emptyList()
        }

        if (errors.isNotEmpty()) {
            return AppResult.Error(Exception(errors.first()))
        }

        return AppResult.Success(
            MyWorkSnapshot(
                companyId = session.companyId,
                employeeId = session.employeeId,
                leaveReviewQueue = leaveReviewQueue,
                ownLeaveRequests = ownLeaves,
                tasks = tasks,
                todayAttendance = todayAttendance
            )
        )
    }

    private fun taskFiltersFor(session: CurrentSession): TaskFilters {
        val permissions = session.permissions
        val scope = when {
            com.example.core.permissions.Permissions.ADMIN_FULL in permissions ||
                com.example.core.permissions.Permissions.TASKS_VIEW_COMPANY in permissions -> "company"
            com.example.core.permissions.Permissions.TASKS_VIEW_DEPARTMENT in permissions -> "department"
            else -> "own"
        }
        return TaskFilters(
            scope = scope,
            employeeId = session.employeeId?.takeIf { scope == "own" }
        )
    }

    private fun refreshMessage(result: AppResult.Error, fallback: String): String =
        result.appError?.message ?: result.exception.message ?: fallback
}
