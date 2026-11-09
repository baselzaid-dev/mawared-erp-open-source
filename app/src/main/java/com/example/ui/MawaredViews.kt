package com.example.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.BuildConfig
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

@Composable
fun MawaredMainScreen(viewModel: MawaredViewModel) {
    // Compose derives LTR/RTL from the active locale.
    // AuthUiState is the SINGLE SOURCE OF TRUTH for whether the user is authenticated.
    val authUiState by viewModel.authUiState.collectAsState()
    // LEGACY_UI_COMPATIBILITY_ONLY: loginState only drives the pre-auth challenge screens
    // (PreLogin / BiometricChallenge / MfaChallenge). It is NOT used for authorization.
        val loginState by viewModel.loginState.collectAsState()

        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                if (authUiState.isLoggedIn && loginState is LoggedInState.Authenticated) {
                    val mustChangePassword = authUiState.currentSession?.mustChangePassword == true
                    if (mustChangePassword) {
                        val forcedState by viewModel.forcedPasswordChangeController.state
                            .collectAsStateWithLifecycle()
                        ForcedPasswordChangeScreen(
                            state = forcedState,
                            actions = viewModel.forcedPasswordChangeController
                        )
                    } else {
                        MawaredAppDashboardContent(viewModel, authUiState)
                    }
                } else {
                    AnimatedContent(
                        targetState = loginState,
                        transitionSpec = {
                            fadeIn(animationSpec = tween(400)) togetherWith fadeOut(animationSpec = tween(400))
                        },
                        label = "AppLoginTransition"
                    ) { state ->
                        // LEGACY_UI_COMPATIBILITY_ONLY: pre-auth challenge screens only.
                        when (state) {
                            is LoggedInState.PreLogin -> {
                                MawaredWelcomeScreen(viewModel)
                            }
                            is LoggedInState.OwnerForgotPassword -> {
                                val forgotState by viewModel.ownerRecoveryController.forgotState
                                    .collectAsStateWithLifecycle()
                                OwnerForgotPasswordScreen(
                                    state = forgotState,
                                    actions = viewModel.ownerRecoveryController,
                                    onBack = { viewModel.leaveOwnerRecoveryToLogin() },
                                    onEnterTokenManually = { code ->
                                        viewModel.openOwnerResetConfirm(
                                            tokenFromDeepLink = null,
                                            companyCode = code
                                        )
                                    }
                                )
                            }
                            is LoggedInState.OwnerResetConfirm -> {
                                val resetState by viewModel.ownerRecoveryController.resetState
                                    .collectAsStateWithLifecycle()
                                OwnerResetConfirmScreen(
                                    state = resetState,
                                    actions = viewModel.ownerRecoveryController,
                                    hasInMemoryToken = viewModel.ownerRecoveryController.hasInMemoryToken(),
                                    onBack = { viewModel.leaveOwnerRecoveryToLogin() },
                                    onDoneToLogin = { viewModel.leaveOwnerRecoveryToLogin() }
                                )
                            }
                            is LoggedInState.BiometricChallenge -> {
                                MawaredBiometricScreen(viewModel)
                            }
                            is LoggedInState.MfaChallenge -> {
                                MawaredMfaScreen(viewModel)
                            }
                            // Authenticated rendering is owned by the authUiState.isLoggedIn branch
                            // above; nothing to draw here. Do NOT treat this as the auth source.
                            is LoggedInState.Authenticated -> {
                                Box(modifier = Modifier.fillMaxSize())
                            }
                        }
                    }
                }

                // Global Notification overlay toast. Auto-dismisses after ~3s so
                // it no longer stays until the user presses X (the X still works).
                viewModel.activeAlertMessage?.let { msg ->
                    LaunchedEffect(msg) {
                        kotlinx.coroutines.delay(3000)
                        viewModel.dismissNotification()
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .align(Alignment.BottomCenter)
                    ) {
                        Surface(
                            color = MaterialTheme.colorScheme.primaryContainer,
                            tonalElevation = 6.dp,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier
                                    .padding(vertical = 12.dp, horizontal = 16.dp)
                                    .fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Icon(
                                        imageVector = Icons.Filled.NotificationsActive,
                                        contentDescription = "جرس تنبيه",
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(24.dp)
                                    )
                                    Spacer(modifier = Modifier.width(12.dp))
                                    Text(
                                        text = msg,
                                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                                IconButton(
                                    onClick = { viewModel.dismissNotification() },
                                    modifier = Modifier.size(32.dp)
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Close,
                                        contentDescription = "إغلاق",
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(18.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
}

// ---------------- WELCOME LOGIN SCREEN ----------------
@Composable
fun MawaredAppDashboardContent(
    viewModel: MawaredViewModel,
    authUiState: AuthUiState
) {
    // LEGACY_UI_COMPATIBILITY_ONLY: not-yet-migrated tabs still consume LoggedInState.Authenticated
    // for DISPLAY only. Authorization for migrated screens comes from AuthUiState / EmployeesUiState.
    val profile = authUiState.userDisplayProfile
    val user = LoggedInState.Authenticated(
        userName = profile?.fullName ?: authUiState.currentUserDisplayName,
        userRole = profile?.roleName ?: authUiState.currentUserRoleName,
        department = profile?.departmentName ?: authUiState.currentDepartmentName
    )

    val permissions = authUiState.currentSession?.permissions ?: emptySet()
    val visibleDestinations = remember(permissions) {
        MawaredNavigation.visibleDestinations(permissions)
    }
    val bottomDestinations = remember(permissions) {
        MawaredNavigation.bottomDestinations(permissions)
    }
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val coroutineScope = rememberCoroutineScope()
    val defaultTab = remember(permissions) { MawaredNavigation.defaultTab(permissions) }
    val chatUiState by viewModel.chatUiState.collectAsStateWithLifecycle()
    val chatHasSelectedConversation =
        viewModel.currentSelectedTab == MawaredNavigation.TAB_CHAT &&
            chatUiState.selectedConversation != null

    // Authenticated-shell system Back only (not pre-login / owner recovery).
    val backAction = resolveAuthenticatedBackAction(
        drawerOpen = drawerState.isOpen,
        notificationPreferencesOpen = viewModel.showNotificationPreferences,
        chatHasSelectedConversation = chatHasSelectedConversation,
        currentTab = viewModel.currentSelectedTab,
        defaultTab = defaultTab
    )
    BackHandler(enabled = backAction != AuthenticatedBackAction.AllowSystemBack) {
        when (
            resolveAuthenticatedBackAction(
                drawerOpen = drawerState.isOpen,
                notificationPreferencesOpen = viewModel.showNotificationPreferences,
                chatHasSelectedConversation =
                    viewModel.currentSelectedTab == MawaredNavigation.TAB_CHAT &&
                        viewModel.chatUiState.value.selectedConversation != null,
                currentTab = viewModel.currentSelectedTab,
                defaultTab = defaultTab
            )
        ) {
            AuthenticatedBackAction.CloseDrawer ->
                coroutineScope.launch { drawerState.close() }
            AuthenticatedBackAction.CloseNotificationPreferences ->
                viewModel.closeNotificationPreferences()
            AuthenticatedBackAction.CloseChatConversation ->
                viewModel.closeChatConversation()
            AuthenticatedBackAction.NavigateToDefaultTab ->
                viewModel.currentSelectedTab = defaultTab
            AuthenticatedBackAction.AllowSystemBack -> Unit
        }
    }

    // If a restored/stale tab is no longer permitted, return to the role-safe default.
    // Self-service employees keep Attendance as their landing screen.
    LaunchedEffect(permissions, viewModel.currentSelectedTab) {
        if (!MawaredNavigation.isTabVisible(viewModel.currentSelectedTab, permissions)) {
            viewModel.currentSelectedTab = MawaredNavigation.defaultTab(permissions)
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            MawaredNavigationDrawer(
                viewModel = viewModel,
                user = user,
                destinations = visibleDestinations,
                onDestinationSelected = { destination ->
                    viewModel.currentSelectedTab = destination.tabIndex
                    coroutineScope.launch { drawerState.close() }
                }
            )
        }
    ) {
        Scaffold(
            topBar = {
                MawaredTopToolbar(
                    viewModel = viewModel,
                    user = user,
                    onMenuClick = { coroutineScope.launch { drawerState.open() } }
                )
            },
            bottomBar = {
                MawaredBottomNavigation(
                    viewModel = viewModel,
                    destinations = bottomDestinations
                )
            }
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .background(if (viewModel.isDarkTheme) SlateDark else Color(0xFFF1F5F9))
            ) {
                AnimatedContent(
                    targetState = viewModel.currentSelectedTab,
                    transitionSpec = {
                        fadeIn(animationSpec = tween(300)) togetherWith fadeOut(animationSpec = tween(300))
                    },
                    label = "MainTabsTransitions"
                ) { tabIndex ->
                    when (tabIndex) {
                        MawaredNavigation.TAB_DASHBOARD -> MawaredGeneralDashboard(
                            viewModel = viewModel,
                            user = user,
                            onMetricClick = { descriptor ->
                                viewModel.navigateFromResourceDescriptor(descriptor)
                            }
                        )
                        MawaredNavigation.TAB_EMPLOYEES -> MawaredEmployeesManager(viewModel)
                        MawaredNavigation.TAB_PURCHASING -> MawaredProcurementManager(viewModel)
                        MawaredNavigation.TAB_REPORTS -> UnifiedReportsCenter(viewModel)
                        MawaredNavigation.TAB_CHAT -> MawaredInternalChat(viewModel)
                        MawaredNavigation.TAB_TASKS -> MawaredDailyTasks(viewModel, user)
                        MawaredNavigation.TAB_TRAINING -> MawaredTrainingManager(viewModel, user)
                        MawaredNavigation.TAB_SUPPORT -> MawaredTechnicalSupport(viewModel, user)
                        MawaredNavigation.TAB_AI_ASSISTANT -> MawaredAiCopilotView(viewModel, user)
                        MawaredNavigation.TAB_ATTENDANCE -> MawaredAttendanceManager(viewModel)
                        MawaredNavigation.TAB_LEAVES -> MawaredLeavesManager(viewModel)
                        MawaredNavigation.TAB_PAYROLL -> MawaredPayrollManager(viewModel)
                        MawaredNavigation.TAB_AUTHORIZATION -> MawaredAuthorizationManager(viewModel)
                        MawaredNavigation.TAB_SECURITY_SESSIONS -> {
                            val sessionState by viewModel.sessionListController.state
                                .collectAsStateWithLifecycle()
                            val sessionFeedback by viewModel.sessionListController.feedback
                                .collectAsStateWithLifecycle()
                            LaunchedEffect(Unit) { viewModel.sessionListController.load() }
                            SessionListScreen(
                                state = sessionState,
                                feedback = sessionFeedback,
                                actions = viewModel.sessionListController
                            )
                        }
                        MawaredNavigation.TAB_NOTIFICATIONS -> {
                            val inboxState by viewModel.notificationInboxState.collectAsStateWithLifecycle()
                            LaunchedEffect(Unit) { viewModel.openNotificationCenter() }
                            NotificationCenterScreen(
                                state = inboxState,
                                actions = viewModel.notificationInboxActions
                            )
                        }
                        MawaredNavigation.TAB_MY_WORK -> {
                            val myWorkState by viewModel.myWorkUiState.collectAsStateWithLifecycle()
                            LaunchedEffect(Unit) { viewModel.refreshMyWork() }
                            MyWorkScreen(
                                state = myWorkState,
                                actions = object : MyWorkActions {
                                    override fun onItemClick(item: com.example.domain.model.MyWorkItem) {
                                        viewModel.navigateTypedDestination(item.destination)
                                    }
                                    override fun onCategorySelected(category: String?) {
                                        viewModel.onMyWorkCategorySelected(category)
                                    }
                                    override fun onRetry() {
                                        viewModel.refreshMyWork()
                                    }
                                }
                            )
                        }
                        MawaredNavigation.TAB_GLOBAL_SEARCH -> {
                            val searchState by viewModel.globalSearchController.state
                                .collectAsStateWithLifecycle()
                            GlobalSearchScreen(
                                state = searchState,
                                actions = viewModel.globalSearchController,
                                onResultClick = { result ->
                                    viewModel.navigateFromResourceDescriptor(
                                        com.example.ui.navigation.ResourceDescriptor.parse(
                                            routeKey = result.routeKey,
                                            resourceType = result.resourceType,
                                            resourceId = result.resourceId,
                                            filterJson = result.filterJson
                                        )
                                    )
                                }
                            )
                        }
                    }
                }

                if (viewModel.showNotificationPreferences) {
                    val prefsState by viewModel.notificationPreferencesController.state.collectAsStateWithLifecycle()
                    Surface(modifier = Modifier.fillMaxSize()) {
                        NotificationPreferencesScreen(
                            state = prefsState,
                            actions = object : NotificationPreferencesActions {
                                override fun onToggle(category: String, enabled: Boolean) {
                                    viewModel.notificationPreferencesController.toggleCategory(category, enabled)
                                }
                                override fun onSave() {
                                    viewModel.notificationPreferencesController.save()
                                }
                                override fun onRetry() {
                                    viewModel.notificationPreferencesController.retry()
                                }
                                override fun onDismissSaveFeedback() {
                                    viewModel.notificationPreferencesController.dismissSaveFeedback()
                                }
                            },
                            onBack = { viewModel.closeNotificationPreferences() }
                        )
                    }
                }

                // Sprint 12L: shared timeline viewer — any screen opens it via
                // viewModel.openTimeline(kind, id, title).
                val timelineState by viewModel.timelineController.state.collectAsStateWithLifecycle()
                TimelineDialogHost(
                    state = timelineState,
                    onDismiss = { viewModel.timelineController.dismiss() },
                    onRetry = { viewModel.timelineController.retry() }
                )
            }
        }
    }
}

// ---------------- HEADER TOOLBAR ----------------
