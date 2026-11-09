package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

/**
 * Guards Sprint 3 pure mappers on MawaredViewModel: landing-tab choice by role,
 * clock-in error mapping, and leave-submit error mapping.
 */
class Sprint3MappingTest {

    // ---- landingTabForPermissions ----

    @Test
    fun `self-service employee lands on attendance`() {
        val perms = setOf(
            Permissions.DASHBOARD_SELF,
            Permissions.ATTENDANCE_CLOCK,
            Permissions.LEAVES_CREATE
        )
        assertEquals(MawaredViewModel.TAB_ATTENDANCE, MawaredViewModel.landingTabForPermissions(perms))
    }

    @Test
    fun `owner admin lands on dashboard`() {
        val perms = setOf(Permissions.ADMIN_FULL, Permissions.DASHBOARD_SELF)
        assertEquals(MawaredViewModel.TAB_DASHBOARD, MawaredViewModel.landingTabForPermissions(perms))
    }

    @Test
    fun `hr lands on dashboard`() {
        val perms = setOf(Permissions.HR_VIEW, Permissions.DASHBOARD_SELF, Permissions.EMPLOYEES_VIEW)
        assertEquals(MawaredViewModel.TAB_DASHBOARD, MawaredViewModel.landingTabForPermissions(perms))
    }

    @Test
    fun `user without dashboard-self stays on dashboard`() {
        val perms = setOf(Permissions.ATTENDANCE_CLOCK)
        assertEquals(MawaredViewModel.TAB_DASHBOARD, MawaredViewModel.landingTabForPermissions(perms))
    }

    // ---- mapClockInError ----

    @Test
    fun `already clocked in maps to informational Arabic message`() {
        val err = AppResult.Error(Exception("Already clocked in today"), AppError.ServerError(400, "Already clocked in today"))
        assertEquals("لقد سجّلت حضورك اليوم بالفعل.", MawaredViewModel.mapClockInError(err))
    }

    @Test
    fun `clock-in generic arabic server message is shown as-is`() {
        val msg = "لا تملك صلاحية تسجيل الحضور"
        val err = AppResult.Error(Exception(msg), AppError.ServerError(403, msg))
        assertEquals(msg, MawaredViewModel.mapClockInError(err))
    }

    @Test
    fun `clock-in admin-not-available maps to canonical owner message`() {
        val msg = "تسجيل الحضور غير متاح لحساب المدير العام"
        val err = AppResult.Error(Exception(msg), AppError.ServerError(403, msg))
        assertEquals("تسجيل الحضور غير متاح لحساب المدير العام.", MawaredViewModel.mapClockInError(err))
    }

    @Test
    fun `clock-in network error uses generic message`() {
        val err = AppResult.Error(IOException("timeout"), AppError.NetworkError)
        assertEquals("حدث خطأ أثناء تسجيل الحضور.", MawaredViewModel.mapClockInError(err))
    }

    // ---- mapLeaveSubmitError ----

    @Test
    fun `leave arabic server message is shown as-is`() {
        val msg = "الرجاء دفع رسوم التأشيرة ثم تقديم الطلب مرة أخرى"
        val err = AppResult.Error(Exception(msg), AppError.ServerError(400, msg))
        assertEquals(msg, MawaredViewModel.mapLeaveSubmitError(err))
    }

    @Test
    fun `leave english sick cap maps to arabic`() {
        val err = AppResult.Error(
            Exception("cap"),
            AppError.ServerError(400, "You only have 2 sick leave days remaining this year.")
        )
        assertEquals("لقد تجاوزت الحد المسموح للإجازات المرضية هذا العام.", MawaredViewModel.mapLeaveSubmitError(err))
    }

    @Test
    fun `leave generic 500 english maps to generic arabic`() {
        val err = AppResult.Error(Exception("x"), AppError.ServerError(500, "Failed to request leave."))
        assertEquals("حدث خطأ أثناء تقديم طلب الإجازة.", MawaredViewModel.mapLeaveSubmitError(err))
    }

    @Test
    fun `leave network error uses generic message`() {
        val err = AppResult.Error(IOException("timeout"), AppError.NetworkError)
        assertEquals("حدث خطأ أثناء تقديم طلب الإجازة.", MawaredViewModel.mapLeaveSubmitError(err))
    }
}
