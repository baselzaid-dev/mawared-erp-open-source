package com.example.ui

import android.util.Log
import androidx.annotation.StringRes
import com.example.R

/**
 * Maps stable backend metric / row field keys to string resource IDs.
 * Unknown keys never return raw camelCase — they use [R.string.metric_additional_indicator].
 */
object MetricLabelResolver {
    private const val TAG = "MetricLabelResolver"

    private val known: Map<String, Int> = mapOf(
        // Employees / attendance / leaves
        "totalEmployeeCount" to R.string.metric_total_employee_count,
        "activeEmployeeCount" to R.string.metric_active_employee_count,
        "recordCount" to R.string.metric_record_count,
        "presentCount" to R.string.metric_present_count,
        "lateCount" to R.string.metric_late_count,
        "absentCount" to R.string.metric_absent_count,
        "requestCount" to R.string.metric_request_count,
        "pendingHrCount" to R.string.metric_pending_hr_count,
        "pendingAdminCount" to R.string.metric_pending_admin_count,
        "approvedCount" to R.string.metric_approved_count,
        "rejectedCount" to R.string.metric_rejected_count,
        "cancelledCount" to R.string.metric_cancelled_count,
        "totalDays" to R.string.metric_total_days,
        // Tasks
        "taskCount" to R.string.metric_task_count,
        "activeCount" to R.string.metric_active_count,
        "completedCount" to R.string.metric_completed_count,
        "assignmentCount" to R.string.metric_assignment_count,
        "submittedCount" to R.string.metric_submitted_count,
        "acceptedCount" to R.string.metric_accepted_count,
        "overdueCount" to R.string.metric_overdue_count,
        // Payroll
        "visibleEmployeeCount" to R.string.metric_visible_employee_count,
        "visibleGross" to R.string.metric_visible_gross,
        "visibleDeductions" to R.string.metric_visible_deductions,
        "visibleNet" to R.string.metric_visible_net,
        "currency" to R.string.metric_currency,
        "month" to R.string.metric_month,
        "year" to R.string.metric_year,
        "status" to R.string.metric_status,
        "baseSalary" to R.string.metric_template_base_salary,
        "grossPay" to R.string.metric_gross_pay,
        "totalDeductions" to R.string.metric_total_deductions,
        "netPay" to R.string.metric_net_pay,
        // Purchasing
        "orderCount" to R.string.metric_order_count,
        "orderedTotal" to R.string.metric_ordered_total,
        "receivedTotal" to R.string.metric_received_total,
        "pendingDepartmentCount" to R.string.metric_pending_department_count,
        "pendingPurchasingCount" to R.string.metric_pending_purchasing_count,
        "orderedCount" to R.string.metric_ordered_count,
        "receivedCount" to R.string.metric_received_count,
        "draftOrderCount" to R.string.metric_draft_order_count,
        "issuedOrderCount" to R.string.metric_issued_order_count,
        "receivedOrderCount" to R.string.metric_received_order_count,
        "cancelledOrderCount" to R.string.metric_template_cancelled_order_count,
        "estimatedTotal" to R.string.metric_estimated_total,
        "recordType" to R.string.metric_record_type,
        "referenceNumber" to R.string.metric_reference_number,
        "titleOrVendor" to R.string.metric_title_or_vendor,
        "amount" to R.string.metric_amount,
        "createdAt" to R.string.metric_created_at,
        // Training
        "courseCount" to R.string.metric_course_count,
        "publishedCourseCount" to R.string.metric_published_course_count,
        "completedCourseCount" to R.string.metric_completed_course_count,
        "completionRatePercent" to R.string.metric_completion_rate_percent,
        "averageProgressPercent" to R.string.metric_average_progress_percent,
        "averageScore" to R.string.metric_template_average_score,
        "draftCourseCount" to R.string.metric_draft_course_count,
        "cancelledCourseCount" to R.string.metric_cancelled_course_count,
        "assignedCount" to R.string.metric_assigned_count,
        "inProgressCount" to R.string.metric_in_progress_count,
        "completedAssignmentCount" to R.string.metric_completed_assignment_count,
        "returnedCount" to R.string.metric_returned_count,
        "cancelledAssignmentCount" to R.string.metric_cancelled_assignment_count,
        "courseCode" to R.string.metric_course_code,
        "category" to R.string.metric_category,
        // Audit / row fields
        "eventCount" to R.string.metric_event_count,
        "employeeNum" to R.string.metric_employee_num,
        "employeeName" to R.string.metric_employee_name,
        "departmentName" to R.string.metric_department_name,
        "date" to R.string.metric_date,
        "clockIn" to R.string.metric_clock_in,
        "clockOut" to R.string.metric_clock_out,
        "leaveType" to R.string.metric_leave_type,
        "startDate" to R.string.metric_start_date,
        "endDate" to R.string.metric_end_date,
        "title" to R.string.metric_title,
        "priority" to R.string.metric_priority,
        "dueDate" to R.string.metric_due_date,
        "action" to R.string.metric_action,
        "actorName" to R.string.metric_actor_name,
        "details" to R.string.metric_details,
        // Current report-template summary and row fields
        "id" to R.string.metric_template_id,
        "employeeId" to R.string.metric_template_employee_id,
        "periodId" to R.string.metric_template_period_id,
        "requestNumber" to R.string.metric_template_request_number,
        "requesterName" to R.string.metric_template_requester_name,
        "employeeCount" to R.string.metric_template_employee_count,
        "jobTitle" to R.string.metric_template_job_title,
        "departmentId" to R.string.metric_template_department_id,
        "joiningDate" to R.string.metric_template_joining_date,
        "isArchived" to R.string.metric_template_is_archived,
        "archivedAt" to R.string.metric_template_archived_at,
        "includeArchived" to R.string.metric_template_include_archived,
        "archivedCount" to R.string.metric_template_archived_count,
        "payrollPeriodId" to R.string.metric_template_payroll_period_id,
        "paymentDate" to R.string.metric_template_payment_date,
        "reference" to R.string.metric_template_reference,
        "voidedAt" to R.string.metric_template_voided_at,
        "isLegacyMigration" to R.string.metric_template_legacy_migration,
        "paymentCount" to R.string.metric_template_payment_count,
        "postedCount" to R.string.metric_template_posted_count,
        "voidedCount" to R.string.metric_template_voided_count,
        "deliveryMode" to R.string.metric_template_delivery_mode
    )

    /** Stable backend keys that have a dedicated string resource. */
    val knownKeys: Set<String> get() = known.keys

    @StringRes
    fun resolveResId(key: String): Int {
        val resId = known[key]
        if (resId != null) return resId
        // Length-only debug log — never log the raw key (may be unexpected / sensitive-looking).
        Log.d(TAG, "Unknown metric key length=${key.length}")
        return R.string.metric_additional_indicator
    }

    fun isKnown(key: String): Boolean = known.containsKey(key)
}

/**
 * Maps report section type codes to string resources.
 * Unknown section codes never return raw camelCase keys.
 */
object ReportSectionLabelResolver {
    private val known: Map<String, Int> = mapOf(
        "employees" to R.string.report_section_employees,
        "attendance" to R.string.report_section_attendance,
        "leaves" to R.string.report_section_leaves,
        "tasks" to R.string.report_section_tasks,
        "payroll" to R.string.report_section_payroll,
        "purchasing" to R.string.report_section_purchasing,
        "training" to R.string.report_section_training,
        "audit" to R.string.report_section_audit
    )

    val knownKeys: Set<String> get() = known.keys

    @StringRes
    fun resolveResId(key: String): Int =
        known[key] ?: R.string.report_section_additional
}
