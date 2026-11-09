package com.example.data.repository.mock

import com.example.core.auth.CompanyLoginRules
import com.example.core.permissions.Permissions
import com.example.core.session.SessionManager
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.AuthLoginResult
import com.example.domain.model.CurrentSession
import com.example.domain.model.MfaAuthenticationResult
import com.example.domain.model.MfaEnrollment
import com.example.domain.model.OwnerRecoveryConfirmRequest
import com.example.domain.model.OwnerRecoveryConfirmResult
import com.example.domain.model.OwnerRecoveryInitiateRequest
import com.example.domain.model.OwnerRecoveryInitiateResult
import com.example.domain.repository.AuthRepository
import com.example.core.auth.OwnerRecoveryDeepLink
import com.example.core.auth.OwnerRecoveryTokenRules
import com.example.core.auth.PasswordPolicy
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * Demo-only auth repository.
 *
 * Each known demo email maps to a DIFFERENT permission set so the UI can prove that
 * authorization is driven purely by CurrentSession.permissions (see PermissionChecker).
 *
 * Security rules enforced here:
 *  - Unknown email            -> AppResult.Error(AppError.Unauthorized)
 *  - Wrong password           -> AppResult.Error(AppError.Unauthorized)
 *  - No "give everyone admin" -> permissions are scoped per user, never a global super-set.
 *
 * All keys MUST come from the canonical [Permissions] object (mirror of
 * backend/src/permissions.ts) — CanonicalPermissionsTest enforces this.
 * Grants are chosen to demo every module state and may be broader than the
 * seeded backend roles (e.g. demo HR can also calculate payroll).
 */
class MockAuthRepository(
    private val sessionManager: SessionManager
) : AuthRepository {

    // Single shared demo password. Arabic-digit form "١٢٣٤" is accepted as the same code.
    private val demoPassword = "1234"
    private val demoPasswordArabic = "١٢٣٤"

    private data class DemoAccount(
        val password: String,
        val session: CurrentSession
    )

    // Company code + identifier -> demo account.
    private val demoAccounts: Map<String, DemoAccount> = mapOf(
        // HR Manager — أحمد العتيبي / مدير الموارد البشرية / الموارد البشرية
        "CMP-DEMO|a.otaibi@fixture-1.example.test" to DemoAccount(
            password = demoPassword,
            session = CurrentSession(
                companyId = "1",
                companyCode = "CMP-DEMO",
                companyName = "Mawared Demo Company",
                userId = "1",
                employeeId = "1",
                roleId = "1",
                departmentId = "1",
                permissions = setOf(
                    Permissions.HR_VIEW,
                    // hr.manage gates Training management + leave admin actions in the UI.
                    Permissions.HR_MANAGE,
                    Permissions.EMPLOYEES_VIEW,
                    Permissions.EMPLOYEES_CREATE,
                    Permissions.EMPLOYEES_UPDATE,
                    // Demo HR may delete employees (reserved destructive key).
                    Permissions.EMPLOYEES_MANAGE,
                    Permissions.ATTENDANCE_VIEW,
                    Permissions.ATTENDANCE_MANAGE,
                    Permissions.LEAVES_VIEW,
                    Permissions.LEAVES_REVIEW,
                    Permissions.LEAVES_APPROVE,
                    Permissions.PAYROLL_VIEW,
                    // payroll.manage = "calculate" in the UI.
                    Permissions.PAYROLL_MANAGE,
                    Permissions.PAYROLL_REPORT,
                    Permissions.SALARY_VIEW_COMPANY,
                    Permissions.SALARY_MANAGE,
                    Permissions.SALARY_VIEW_OWNER,
                    Permissions.TASKS_VIEW_COMPANY,
                    Permissions.TASKS_CREATE,
                    Permissions.TASKS_ASSIGN_COMPANY,
                    Permissions.TASKS_REVIEW,
                    Permissions.CHAT_VIEW,
                    // Reports migration: HR Manager can view operational reports (not financial).
                    Permissions.REPORTS_VIEW,
                    Permissions.REPORTS_EXPORT
                )
            )
        ),
        // Finance Manager — سارة الغامدي / مديرة المالية / المالية
        "CMP-DEMO|s.ghamdi@fixture-1.example.test" to DemoAccount(
            password = demoPassword,
            session = CurrentSession(
                companyId = "1",
                companyCode = "CMP-DEMO",
                companyName = "Mawared Demo Company",
                userId = "2",
                employeeId = "2",
                roleId = "2",
                departmentId = "3",
                permissions = setOf(
                    Permissions.FINANCE_VIEW,
                    Permissions.FINANCE_APPROVE,
                    Permissions.PAYROLL_VIEW,
                    Permissions.PAYROLL_MANAGE,
                    Permissions.PAYROLL_APPROVE,
                    Permissions.PAYROLL_REPORT,
                    Permissions.PAYROLL_PAY,
                    Permissions.SALARY_VIEW_COMPANY,
                    Permissions.PURCHASING_VIEW,
                    Permissions.PURCHASING_REPORT,
                    Permissions.VENDORS_VIEW,
                    Permissions.CHAT_VIEW,
                    // Reports migration: Finance Manager can view financial reports.
                    Permissions.REPORTS_FINANCE,
                    Permissions.REPORTS_EXPORT
                )
            )
        ),
        // Purchasing Officer — رائد الشمري / مسؤول المشتريات / المشتريات
        "CMP-DEMO|r.shammari@fixture-1.example.test" to DemoAccount(
            password = demoPassword,
            session = CurrentSession(
                companyId = "1",
                companyCode = "CMP-DEMO",
                companyName = "Mawared Demo Company",
                userId = "3",
                employeeId = "3",
                roleId = "3",
                departmentId = "4",
                permissions = setOf(
                    Permissions.PURCHASING_VIEW,
                    Permissions.PURCHASING_CREATE,
                    Permissions.PURCHASING_APPROVE,
                    Permissions.PURCHASING_MANAGE,
                    Permissions.PURCHASING_RECEIVE,
                    Permissions.PURCHASING_REPORT,
                    Permissions.REPORTS_EXPORT,
                    Permissions.VENDORS_VIEW,
                    Permissions.VENDORS_MANAGE,
                    Permissions.CHAT_VIEW
                )
            )
        ),
        // Regular Employee — بدر اليوسف / موظف / تقنية المعلومات
        "CMP-DEMO|b.yousef@fixture-1.example.test" to DemoAccount(
            password = demoPassword,
            session = CurrentSession(
                companyId = "1",
                companyCode = "CMP-DEMO",
                companyName = "Mawared Demo Company",
                userId = "4",
                employeeId = "4",
                roleId = "4",
                departmentId = "2",
                permissions = setOf(
                    Permissions.EMPLOYEES_VIEW,
                    Permissions.CHAT_VIEW,
                    // Self-service scope: the *_own keys open the Attendance/Leaves
                    // screens via the PermissionChecker scoped-view fallbacks.
                    // Intentionally NOT granting manage/approve/payroll/purchasing/admin.
                    Permissions.ATTENDANCE_VIEW_OWN,
                    Permissions.ATTENDANCE_CLOCK,
                    Permissions.LEAVES_VIEW_OWN,
                    Permissions.LEAVES_CREATE,
                    Permissions.TASKS_VIEW_OWN,
                    Permissions.PURCHASING_VIEW_OWN,
                    Permissions.PURCHASING_CREATE
                )
            )
        ),
        "CMP-BRANCH|b.yousef@fixture-1.example.test" to DemoAccount(
            password = demoPassword,
            session = CurrentSession(
                companyId = "2",
                companyCode = "CMP-BRANCH",
                companyName = "Mawared Branch",
                userId = "5",
                employeeId = "5",
                roleId = "4",
                departmentId = "5",
                permissions = setOf(
                    Permissions.EMPLOYEES_VIEW,
                    Permissions.CHAT_VIEW,
                    Permissions.ATTENDANCE_VIEW_OWN,
                    Permissions.ATTENDANCE_CLOCK,
                    Permissions.LEAVES_VIEW_OWN,
                    Permissions.LEAVES_CREATE,
                    Permissions.TASKS_VIEW_OWN
                )
            )
        )
    )

    override suspend fun login(
        companyCode: String,
        identifier: String,
        password: String
    ): AppResult<AuthLoginResult> {
        delay(1000) // Simulate network delay

        val key = "${CompanyLoginRules.normalizeCompanyCode(companyCode)}|${identifier.trim().lowercase()}"
        val account = demoAccounts[key]
            ?: return AppResult.Error(AppError.Unauthorized, AppError.Unauthorized)

        val passwordOk = password == account.password || password == demoPasswordArabic
        if (!passwordOk) {
            return AppResult.Error(AppError.Unauthorized, AppError.Unauthorized) // Wrong password
        }

        sessionManager.updateSession(account.session)
        return AppResult.Success(AuthLoginResult.Authenticated(account.session))
    }

    override suspend fun startMfaEnrollment(challengeToken: String): AppResult<MfaEnrollment> =
        AppResult.Error(AppError.ValidationError("Demo MFA does not enroll"), AppError.ValidationError("Demo MFA does not enroll"))

    override suspend fun confirmMfaEnrollment(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult> =
        AppResult.Error(AppError.ValidationError("Demo MFA does not enroll"), AppError.ValidationError("Demo MFA does not enroll"))

    override suspend fun verifyMfa(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult> =
        AppResult.Error(AppError.ValidationError("Demo MFA uses the local code"), AppError.ValidationError("Demo MFA uses the local code"))

    override suspend fun initiateOwnerRecovery(
        request: OwnerRecoveryInitiateRequest
    ): AppResult<OwnerRecoveryInitiateResult> {
        delay(300)
        // Enumeration-safe: always the same generic accepted contract.
        return AppResult.Success(
            OwnerRecoveryInitiateResult(
                status = "if_owner_account_exists_instructions_sent",
                requestId = UUID.randomUUID().toString()
            )
        )
    }

    override suspend fun confirmOwnerRecovery(
        request: OwnerRecoveryConfirmRequest
    ): AppResult<OwnerRecoveryConfirmResult> {
        delay(300)
        val token = request.resetToken.trim()
        val password = request.newPassword
        if (!OwnerRecoveryTokenRules.isValid(token) || !PasswordPolicy.isValid(password)) {
            return AppResult.Error(
                Exception(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID),
                AppError.ValidationError(OwnerRecoveryDeepLink.MESSAGE_KEY_INVALID)
            )
        }
        sessionManager.clearSession()
        return AppResult.Success(
            OwnerRecoveryConfirmResult(
                status = "recovery_complete",
                requestId = UUID.randomUUID().toString()
            )
        )
    }

    override suspend fun logout(): AppResult<Unit> {
        delay(500)
        sessionManager.clearSession()
        return AppResult.Success(Unit)
    }

    override fun clearLocalSessions() {
        sessionManager.clearSession()
    }

    override fun observeCurrentSession(): Flow<CurrentSession?> {
        return sessionManager.currentSession
    }

    override fun observeRememberedSession(): Flow<CurrentSession?> {
        return sessionManager.rememberedSession
    }

    override fun unlockRememberedSession(companyCode: String): AppResult<CurrentSession> {
        val session = sessionManager.unlockRememberedSession(companyCode)
            ?: return AppResult.Error(AppError.Unauthorized, AppError.Unauthorized)
        return AppResult.Success(session)
    }

    override fun currentSessionOrNull(): CurrentSession? = sessionManager.currentSession.value

    override fun updateAuthorizationSnapshot(
        authorizationVersion: Int,
        permissions: Set<String>
    ): Boolean {
        val current = sessionManager.currentSession.value ?: return false
        if (
            current.authorizationVersion == authorizationVersion &&
            current.permissions == permissions
        ) {
            return false
        }
        sessionManager.updateSession(
            current.copy(
                authorizationVersion = authorizationVersion,
                permissions = permissions
            )
        )
        return true
    }
}
