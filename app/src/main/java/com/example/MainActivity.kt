package com.example

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import com.example.ui.MawaredMainScreen
import com.example.ui.MawaredViewModel
import com.example.ui.MawaredViewModelFactory
import com.example.ui.theme.MyApplicationTheme

class MainActivity : ComponentActivity() {
    private lateinit var viewModel: MawaredViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Enable encrypted session persistence (must run before repositories).
        com.example.core.di.DependencyProvider.init(applicationContext)

        // Get repository interfaces (Mock/Api selected by DEMO_MODE inside the provider)
        val authRepository = com.example.core.di.DependencyProvider.authRepository
        val employeeRepository = com.example.core.di.DependencyProvider.employeeRepository
        val purchaseRepository = com.example.core.di.DependencyProvider.purchaseRepository
        val supplierRepository = com.example.core.di.DependencyProvider.supplierRepository
        val attendanceRepository = com.example.core.di.DependencyProvider.attendanceRepository
        val attendanceCorrectionRepository = com.example.core.di.DependencyProvider.attendanceCorrectionRepository
        val attendanceExemptionRepository = com.example.core.di.DependencyProvider.attendanceExemptionRepository
        val leaveRepository = com.example.core.di.DependencyProvider.leaveRepository
        val payrollRepository = com.example.core.di.DependencyProvider.payrollRepository
        val chatRepository = com.example.core.di.DependencyProvider.chatRepository
        val taskRepository = com.example.core.di.DependencyProvider.taskRepository
        val trainingRepository = com.example.core.di.DependencyProvider.trainingRepository
        val reportRepository = com.example.core.di.DependencyProvider.reportRepository
        val authorizationRepository = com.example.core.di.DependencyProvider.authorizationRepository
        val credentialRepository = com.example.core.di.DependencyProvider.credentialRepository
        val sessionRepository = com.example.core.di.DependencyProvider.sessionRepository
        val notificationInboxRepository = com.example.core.di.DependencyProvider.notificationInboxRepository
        val aiAssistantApi = com.example.core.di.DependencyProvider.aiAssistantApi

        // Create ViewModel through Factory
        val factory = MawaredViewModelFactory(
            application,
            authRepository,
            employeeRepository,
            purchaseRepository,
            supplierRepository,
            attendanceRepository,
            attendanceCorrectionRepository,
            attendanceExemptionRepository,
            leaveRepository,
            payrollRepository,
            chatRepository,
            taskRepository,
            trainingRepository,
            reportRepository,
            authorizationRepository,
            credentialRepository,
            sessionRepository,
            notificationInboxRepository,
            aiAssistantApi,
            com.example.core.di.DependencyProvider.globalSearchRepository,
            com.example.core.di.DependencyProvider.timelineRepository
        )
        viewModel = ViewModelProvider(this, factory)[MawaredViewModel::class.java]
        consumeOwnerRecoveryIntent(intent)

        setContent {
            // Respect user toggle preference for light/dark theme dynamically
            MyApplicationTheme(darkTheme = viewModel.isDarkTheme, dynamicColor = false) {
                MawaredMainScreen(viewModel = viewModel)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::viewModel.isInitialized) {
            consumeOwnerRecoveryIntent(intent)
        }
    }

    private fun consumeOwnerRecoveryIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        viewModel.handleOwnerRecoveryDeepLink(intent.data)
    }
}
