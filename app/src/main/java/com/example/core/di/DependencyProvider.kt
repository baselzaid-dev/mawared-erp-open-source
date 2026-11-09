package com.example.core.di

import com.example.BuildConfig
import com.example.core.session.SessionManager
import com.example.data.remote.api.NetworkModule
import com.example.data.remote.api.AuthApi
import com.example.data.remote.api.EmployeeApi
import com.example.data.remote.api.LeaveApi
import com.example.data.remote.api.AttendanceApi
import com.example.data.remote.api.AuthorizationApi
import com.example.data.remote.api.CredentialApi
import com.example.data.remote.api.SessionApi
import com.example.data.remote.repository.ApiAttendanceRepository
import com.example.data.remote.repository.ApiAuthorizationRepository
import com.example.data.remote.repository.ApiAuthRepository
import com.example.data.remote.repository.ApiCredentialRepository
import com.example.data.remote.repository.ApiSessionRepository
import com.example.data.remote.repository.ApiChatRepository
import com.example.data.remote.repository.ApiEmployeeRepository
import com.example.data.remote.repository.ApiLeaveRepository
import com.example.data.remote.repository.ApiPayrollRepository
import com.example.data.remote.repository.ApiPurchaseRepository
import com.example.data.remote.repository.ApiReportRepository
import com.example.data.remote.repository.ApiSupplierRepository
import com.example.data.repository.mock.MockAttendanceRepository
import com.example.data.repository.mock.MockAuthorizationRepository
import com.example.data.repository.mock.MockAuthRepository
import com.example.data.repository.mock.MockCredentialRepository
import com.example.data.repository.mock.MockSessionRepository
import com.example.data.repository.mock.MockChatRepository
import com.example.data.repository.mock.MockEmployeeRepository
import com.example.data.repository.mock.MockLeaveRepository
import com.example.data.repository.mock.MockPayrollRepository
import com.example.data.repository.mock.MockPurchaseRepository
import com.example.data.repository.mock.MockReportRepository
import com.example.data.repository.mock.MockSupplierRepository
import com.example.domain.repository.AttendanceRepository
import com.example.domain.repository.AuthRepository
import com.example.domain.repository.ChatRepository
import com.example.domain.repository.CredentialRepository
import com.example.domain.repository.EmployeeRepository
import com.example.domain.repository.LeaveRepository
import com.example.domain.repository.PayrollRepository
import com.example.domain.repository.PurchaseRepository
import com.example.domain.repository.ReportRepository
import com.example.domain.repository.SessionRepository
import com.example.domain.repository.SupplierRepository

object DependencyProvider {

    @Volatile
    private var appContext: android.content.Context? = null

    /**
     * Must be called once (MainActivity.onCreate) BEFORE any repository is
     * accessed, so the session can be persisted encrypted and restored on
     * app restart. Without init, the session is memory-only (unit tests).
     */
    fun init(context: android.content.Context) {
        if (appContext == null) {
            appContext = context.applicationContext
        }
    }

    val sessionManager: SessionManager by lazy {
        val store = appContext?.let { ctx ->
            try {
                com.example.core.session.EncryptedSessionStore(ctx)
            } catch (e: Exception) {
                // Broken Keystore on this device: fall back to memory-only
                // (safer than persisting tokens unencrypted).
                null
            }
        }
        SessionManager(store)
    }

    private val retrofit by lazy {
        NetworkModule.provideRetrofit(sessionManager)
    }

    private val authApi by lazy { retrofit.create(AuthApi::class.java) }
    private val employeeApi by lazy { retrofit.create(EmployeeApi::class.java) }
    private val attendanceApi by lazy { retrofit.create(AttendanceApi::class.java) }
    private val leaveApi by lazy { retrofit.create(LeaveApi::class.java) }
    private val vendorApi by lazy { retrofit.create(com.example.data.remote.api.VendorApi::class.java) }
    private val purchaseApi by lazy { retrofit.create(com.example.data.remote.api.PurchaseApi::class.java) }
    private val payrollApi by lazy { retrofit.create(com.example.data.remote.api.PayrollApi::class.java) }
    private val taskApi by lazy { retrofit.create(com.example.data.remote.api.TaskApi::class.java) }
    private val chatApi by lazy { retrofit.create(com.example.data.remote.api.ChatApi::class.java) }
    private val attachmentApi by lazy { retrofit.create(com.example.data.remote.api.AttachmentApi::class.java) }
    private val trainingApi by lazy { retrofit.create(com.example.data.remote.api.TrainingApi::class.java) }
    private val reportApi by lazy { retrofit.create(com.example.data.remote.api.ReportApi::class.java) }
    private val authorizationApi by lazy { retrofit.create(AuthorizationApi::class.java) }
    private val credentialApi by lazy { retrofit.create(CredentialApi::class.java) }
    private val sessionApi by lazy { retrofit.create(SessionApi::class.java) }
    private val notificationApi by lazy {
        retrofit.create(com.example.data.remote.api.NotificationApi::class.java)
    }

    val authRepository: AuthRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockAuthRepository(sessionManager)
        } else {
            ApiAuthRepository(sessionManager, authApi)
        }
    }

    val employeeRepository: EmployeeRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockEmployeeRepository()
        } else {
            ApiEmployeeRepository(employeeApi) // Need to update this too
        }
    }

    val purchaseRepository: PurchaseRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockPurchaseRepository()
        } else {
            ApiPurchaseRepository(purchaseApi)
        }
    }

    val supplierRepository: SupplierRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockSupplierRepository()
        } else {
            ApiSupplierRepository(vendorApi)
        }
    }

    val attendanceRepository: AttendanceRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockAttendanceRepository()
        } else {
            ApiAttendanceRepository(attendanceApi) // Need to update this too
        }
    }

    val attendanceCorrectionRepository: com.example.domain.repository.AttendanceCorrectionRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockAttendanceCorrectionRepository()
        } else {
            com.example.data.remote.repository.ApiAttendanceCorrectionRepository(attendanceApi)
        }
    }

    val attendanceExemptionRepository: com.example.domain.repository.AttendanceExemptionRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockAttendanceExemptionRepository()
        } else {
            com.example.data.remote.repository.ApiAttendanceExemptionRepository(attendanceApi)
        }
    }

    val leaveRepository: LeaveRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockLeaveRepository()
        } else {
            ApiLeaveRepository(leaveApi) // Need to update this too
        }
    }

    val payrollRepository: PayrollRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockPayrollRepository()
        } else {
            ApiPayrollRepository(payrollApi)
        }
    }

    val chatRepository: ChatRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockChatRepository()
        } else {
            ApiChatRepository(chatApi)
        }
    }

    val attachmentRepository: com.example.data.remote.repository.ApiAttachmentRepository? by lazy {
        val ctx = appContext ?: return@lazy null
        com.example.data.remote.repository.ApiAttachmentRepository(
            attachmentApi,
            com.example.core.attachment.AttachmentCacheStore(ctx),
            ctx
        )
    }

    val aiAssistantApi: com.example.data.remote.api.AiAssistantApi by lazy {
        retrofit.create(com.example.data.remote.api.AiAssistantApi::class.java)
    }

    val taskRepository: com.example.domain.repository.TaskRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockTaskRepository()
        } else {
            com.example.data.remote.repository.ApiTaskRepository(taskApi)
        }
    }

    val trainingRepository: com.example.domain.repository.TrainingRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockTrainingRepository()
        } else {
            com.example.data.remote.repository.ApiTrainingRepository(trainingApi)
        }
    }

    val reportRepository: ReportRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockReportRepository()
        } else {
            ApiReportRepository(reportApi)
        }
    }

    val authorizationRepository: com.example.domain.repository.AuthorizationRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockAuthorizationRepository()
        } else {
            ApiAuthorizationRepository(authorizationApi)
        }
    }

    val credentialRepository: CredentialRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockCredentialRepository()
        } else {
            ApiCredentialRepository(credentialApi)
        }
    }

    val sessionRepository: SessionRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            MockSessionRepository()
        } else {
            ApiSessionRepository(sessionApi)
        }
    }

    val notificationInboxRepository: com.example.domain.repository.NotificationInboxRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockNotificationInboxRepository()
        } else {
            com.example.data.remote.repository.ApiNotificationInboxRepository(notificationApi)
        }
    }

    private val globalSearchApi by lazy {
        retrofit.create(com.example.data.remote.api.GlobalSearchApi::class.java)
    }

    val globalSearchRepository: com.example.domain.repository.GlobalSearchRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockGlobalSearchRepository()
        } else {
            com.example.data.remote.repository.ApiGlobalSearchRepository(globalSearchApi)
        }
    }

    private val timelineApi by lazy {
        retrofit.create(com.example.data.remote.api.TimelineApi::class.java)
    }

    val timelineRepository: com.example.domain.repository.TimelineRepository by lazy {
        if (BuildConfig.DEMO_MODE) {
            com.example.data.repository.mock.MockTimelineRepository()
        } else {
            com.example.data.remote.repository.ApiTimelineRepository(timelineApi)
        }
    }
}
