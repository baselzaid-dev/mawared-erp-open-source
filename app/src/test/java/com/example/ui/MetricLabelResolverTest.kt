package com.example.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "ar")
class MetricLabelResolverTest {

    private val requiredKeys = listOf(
        "pendingDepartmentCount",
        "pendingPurchasingCount",
        "orderedCount",
        "receivedCount",
        "draftOrderCount",
        "issuedOrderCount",
        "receivedOrderCount",
        "cancelledOrderCount",
        "estimatedTotal",
        "draftCourseCount",
        "cancelledCourseCount",
        "assignedCount",
        "inProgressCount",
        "completedAssignmentCount",
        "returnedCount",
        "cancelledAssignmentCount",
        "overdueCount",
        "averageScore",
        // Previously mapped in UnifiedReportViews / ReportTemplateViews
        "totalEmployeeCount",
        "activeEmployeeCount",
        "recordCount",
        "presentCount",
        "lateCount",
        "absentCount",
        "requestCount",
        "pendingHrCount",
        "pendingAdminCount",
        "approvedCount",
        "rejectedCount",
        "cancelledCount",
        "totalDays",
        "taskCount",
        "activeCount",
        "completedCount",
        "assignmentCount",
        "submittedCount",
        "acceptedCount",
        "visibleEmployeeCount",
        "visibleGross",
        "visibleDeductions",
        "visibleNet",
        "currency",
        "month",
        "year",
        "status",
        "baseSalary",
        "orderCount",
        "orderedTotal",
        "receivedTotal",
        "courseCount",
        "publishedCourseCount",
        "completedCourseCount",
        "completionRatePercent",
        "averageProgressPercent",
        "eventCount",
        "employeeNum",
        "employeeName",
        "departmentName",
        "date",
        "clockIn",
        "clockOut",
        "leaveType",
        "startDate",
        "endDate",
        "title",
        "priority",
        "dueDate",
        "grossPay",
        "totalDeductions",
        "netPay",
        "recordType",
        "referenceNumber",
        "titleOrVendor",
        "amount",
        "createdAt",
        "courseCode",
        "category",
        "action",
        "actorName",
        "details",
        "id",
        "employeeId",
        "periodId",
        "requestNumber",
        "requesterName",
        "employeeCount",
        "jobTitle",
        "departmentId",
        "joiningDate",
        "isArchived",
        "archivedAt",
        "includeArchived",
        "archivedCount",
        "payrollPeriodId",
        "paymentDate",
        "reference",
        "voidedAt",
        "isLegacyMigration",
        "paymentCount",
        "postedCount",
        "voidedCount",
        "deliveryMode"
    )

    @Test
    fun `all required metric keys are known and map to dedicated resources`() {
        requiredKeys.forEach { key ->
            assertTrue("missing mapping for $key", MetricLabelResolver.isKnown(key))
            val resId = MetricLabelResolver.resolveResId(key)
            assertNotEquals(
                "known key $key must not use fallback",
                R.string.metric_additional_indicator,
                resId
            )
        }
        assertEquals(requiredKeys.toSet(), MetricLabelResolver.knownKeys)
    }

    @Test
    fun `unknown key returns additional indicator and never equals raw camelCase`() {
        val unknown = "pendingDepartmentCountXYZ"
        assertEquals(R.string.metric_additional_indicator, MetricLabelResolver.resolveResId(unknown))
        assertFalse(MetricLabelResolver.isKnown(unknown))

        val context = ApplicationProvider.getApplicationContext<Context>()
        val label = context.getString(MetricLabelResolver.resolveResId(unknown))
        assertEquals("مؤشر إضافي", label)
        assertNotEquals(unknown, label)
        assertFalse(label.contains("pending", ignoreCase = true))
        assertFalse(label.any { it in 'A'..'Z' })
    }

    @Test
    fun `purchasing and training recommended arabic labels resolve`() {
        val arabic = ApplicationProvider.getApplicationContext<Context>()
        assertEquals(
            "بانتظار اعتماد القسم",
            arabic.getString(MetricLabelResolver.resolveResId("pendingDepartmentCount"))
        )
        assertEquals(
            "بانتظار اعتماد المشتريات",
            arabic.getString(MetricLabelResolver.resolveResId("pendingPurchasingCount"))
        )
        assertEquals(
            "الإجمالي التقديري",
            arabic.getString(MetricLabelResolver.resolveResId("estimatedTotal"))
        )
        assertEquals(
            "عدد الطلبات الملغاة",
            arabic.getString(MetricLabelResolver.resolveResId("cancelledOrderCount"))
        )
        assertEquals(
            "مهام تدريبية مسندة",
            arabic.getString(MetricLabelResolver.resolveResId("assignedCount"))
        )
        assertEquals(
            "مهام متأخرة",
            arabic.getString(MetricLabelResolver.resolveResId("overdueCount"))
        )
        assertEquals(
            "متوسط التقييم",
            arabic.getString(MetricLabelResolver.resolveResId("averageScore"))
        )
    }

    @Test
    fun `current employee payment and purchasing template fields have dedicated labels`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertEquals("عدد الموظفين", context.getString(MetricLabelResolver.resolveResId("employeeCount")))
        assertEquals("المسمى الوظيفي", context.getString(MetricLabelResolver.resolveResId("jobTitle")))
        assertEquals("تاريخ الانضمام", context.getString(MetricLabelResolver.resolveResId("joiningDate")))
        assertEquals("الراتب الأساسي", context.getString(MetricLabelResolver.resolveResId("baseSalary")))
        assertEquals("عدد الدفعات", context.getString(MetricLabelResolver.resolveResId("paymentCount")))
        assertEquals("تاريخ الدفع", context.getString(MetricLabelResolver.resolveResId("paymentDate")))
        assertEquals("اسم مقدم الطلب", context.getString(MetricLabelResolver.resolveResId("requesterName")))
        assertEquals("طريقة التسليم", context.getString(MetricLabelResolver.resolveResId("deliveryMode")))
    }

    @Test
    fun `section resolver never returns raw unknown keys`() {
        assertEquals(
            R.string.report_section_employees,
            ReportSectionLabelResolver.resolveResId("employees")
        )
        assertEquals(
            R.string.report_section_additional,
            ReportSectionLabelResolver.resolveResId("unknownSectionKey")
        )
        val arabic = ApplicationProvider.getApplicationContext<Context>()
        val label = arabic.getString(ReportSectionLabelResolver.resolveResId("camelCaseSection"))
        assertNotEquals("camelCaseSection", label)
        assertEquals("قسم إضافي", label)
    }
}
