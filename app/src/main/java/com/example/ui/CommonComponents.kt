package com.example.ui

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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.BuildConfig
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MawaredTopToolbar(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated,
    onMenuClick: () -> Unit
) {
    TopAppBar(
        title = {
            Column {
                Text(
                    text = "مَوَارِد ERP",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Black,
                    color = if (viewModel.isDarkTheme) Color.White else SlateDark
                )
                Text(
                    text = "${user.userName} • ${user.userRole}",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (viewModel.isDarkTheme) EmeraldMain else SlateLight,
                    fontWeight = FontWeight.Bold
                )
            }
        },
        navigationIcon = {
            IconButton(onClick = onMenuClick) {
                Icon(
                    imageVector = Icons.Default.Menu,
                    contentDescription = "فتح قائمة التنقل",
                    tint = if (viewModel.isDarkTheme) Color.White else SlateDark
                )
            }
        },
        actions = {
            val permissions = viewModel.authUiState.collectAsState().value.currentSession?.permissions.orEmpty()
            if (com.example.core.permissions.PermissionChecker(permissions)
                    .hasAnyPermission(listOf(com.example.core.permissions.Permissions.NOTIFICATIONS_VIEW))
            ) {
                // Bell is the only nav entry to notifications (drawer/bottom removed — QA Issue 4).
                // Unread badge omitted: no low-effort unread-count API on the inbox state today.
                IconButton(onClick = { viewModel.openNotificationCenter() }) {
                    Icon(
                        imageVector = Icons.Default.Notifications,
                        contentDescription = "مركز الإشعارات",
                        tint = if (viewModel.isDarkTheme) EmeraldMain else SlateDark
                    )
                }
            }

            // Theme Switcher
            IconButton(onClick = { viewModel.toggleTheme() }) {
                Icon(
                    imageVector = if (viewModel.isDarkTheme) Icons.Outlined.LightMode else Icons.Outlined.DarkMode,
                    contentDescription = "الوضع المظلم",
                    tint = if (viewModel.isDarkTheme) EmeraldMain else SlateDark
                )
            }

            // Logout icon
            IconButton(onClick = { viewModel.logOut() }) {
                Icon(
                    imageVector = Icons.Default.ExitToApp,
                    contentDescription = "تسجيل الخروج",
                    tint = RedStatus
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White
        )
    )

    // Support request dialog. It is opened from the authenticated support destination.
    if (viewModel.isSupportDrawerOpen) {
        Dialog(onDismissRequest = { viewModel.isSupportDrawerOpen = false }) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(550.dp)
                    .padding(8.dp),
                shape = RoundedCornerShape(16.dp),
                color = if (viewModel.isDarkTheme) SlateMedium else Color.White,
                tonalElevation = 8.dp
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    // Header Support
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.SupportAgent, contentDescription = "دعم", tint = EmeraldMain)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                "طلب دعم فني",
                                fontWeight = FontWeight.Bold,
                                style = MaterialTheme.typography.titleMedium,
                                color = if (viewModel.isDarkTheme) Color.White else SlateDark
                            )
                        }
                        IconButton(onClick = { viewModel.isSupportDrawerOpen = false }) {
                            Icon(Icons.Default.Close, contentDescription = "أغلق", tint = RedStatus)
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    val supportLogs by viewModel.supportChatLogs.collectAsState()
                    val stateScroll = rememberLazyListState()

                    // Chat space
                    LazyColumn(
                        state = stateScroll,
                        modifier = Modifier
                            .weight(1f)
                            .background(
                                if (viewModel.isDarkTheme) SlateDark else Color(0xFFF8FAFC),
                                RoundedCornerShape(12.dp)
                            )
                            .padding(8.dp)
                    ) {
                        items(supportLogs) { (sender, text) ->
                            val isMe = sender == "أنت"
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                horizontalAlignment = if (isMe) Alignment.End else Alignment.Start
                            ) {
                                Text(
                                    sender,
                                    fontSize = 11.sp,
                                    color = if (isMe) EmeraldMain else SlateLight,
                                    modifier = Modifier.padding(horizontal = 4.dp)
                                )
                                Box(
                                    modifier = Modifier
                                        .background(
                                            color = if (isMe) EmeraldMain.copy(alpha = 0.2f) else SlateMedium.copy(alpha = 0.5f),
                                            shape = RoundedCornerShape(12.dp)
                                        )
                                        .padding(10.dp)
                                ) {
                                    Text(
                                        text = text,
                                        color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                                        style = MaterialTheme.typography.bodyMedium
                                    )
                                }
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    // Input slot
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedTextField(
                            value = viewModel.supportInputText,
                            onValueChange = { viewModel.supportInputText = it },
                            placeholder = { Text("اكتب تفاصيل المشكلة هنا...") },
                            modifier = Modifier.weight(1f),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark,
                                unfocusedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark
                            )
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        IconButton(
                            onClick = { viewModel.sendSupportTicket() },
                            modifier = Modifier.background(EmeraldMain, CircleShape)
                        ) {
                            Icon(Icons.Default.Send, contentDescription = "إرسال طلب الدعم", tint = SlateDark)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun MawaredNavigationDrawer(
    viewModel: MawaredViewModel,
    user: LoggedInState.Authenticated,
    destinations: List<MawaredDestination>,
    onDestinationSelected: (MawaredDestination) -> Unit
) {
    ModalDrawerSheet(
        modifier = Modifier
            .fillMaxHeight()
            .widthIn(max = 320.dp),
        drawerContainerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 20.dp)
        ) {
            Text(
                text = "موارد ERP",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Black,
                color = if (viewModel.isDarkTheme) Color.White else SlateDark
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = user.userName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = if (viewModel.isDarkTheme) MintLight else EmeraldMain
            )
            Text(
                text = user.userRole,
                style = MaterialTheme.typography.bodySmall,
                color = SlateLight
            )
        }

        HorizontalDivider(color = SlateLight.copy(alpha = 0.2f))

        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
        ) {
            destinations.groupBy { it.section }.forEach { (section, sectionDestinations) ->
                item(key = "section-${section.name}") {
                    Text(
                        text = section.arabicTitle,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        color = SlateLight,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
                    )
                }
                items(
                    items = sectionDestinations,
                    key = { it.tabIndex }
                ) { destination ->
                    val isSelected = viewModel.currentSelectedTab == destination.tabIndex
                    val destinationLabel = destination.labelRes
                        ?.let { stringResource(it) }
                        ?: destination.label
                    NavigationDrawerItem(
                        selected = isSelected,
                        onClick = { onDestinationSelected(destination) },
                        icon = {
                            Icon(
                                imageVector = navigationIconFor(destination.tabIndex),
                                contentDescription = null
                            )
                        },
                        label = {
                            Text(
                                text = destinationLabel,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        },
                        colors = NavigationDrawerItemDefaults.colors(
                            selectedContainerColor = EmeraldMain.copy(alpha = 0.16f),
                            selectedIconColor = EmeraldMain,
                            selectedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark,
                            unselectedIconColor = SlateLight,
                            unselectedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark
                        ),
                        modifier = Modifier.padding(vertical = 2.dp)
                    )
                }
            }
        }
    }
}

// ---------------- BOTTOM NAVIGATION CONTROLLER ----------------
@Composable
fun MawaredBottomNavigation(
    viewModel: MawaredViewModel,
    destinations: List<MawaredDestination>
) {
    NavigationBar(
        containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White,
        windowInsets = WindowInsets.navigationBars
    ) {
        destinations.forEach { destination ->
            val isSelected = viewModel.currentSelectedTab == destination.tabIndex
            val destinationLabel = destination.labelRes
                ?.let { stringResource(it) }
                ?: destination.label
            NavigationBarItem(
                selected = isSelected,
                onClick = { viewModel.currentSelectedTab = destination.tabIndex },
                icon = {
                    Icon(
                        imageVector = navigationIconFor(destination.tabIndex),
                        contentDescription = destinationLabel,
                        tint = if (isSelected) EmeraldMain else SlateLight
                    )
                },
                label = {
                    Text(
                        text = destinationLabel,
                        fontSize = 11.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        color = if (isSelected) EmeraldMain else SlateLight,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                },
                colors = NavigationBarItemDefaults.colors(
                    indicatorColor = EmeraldMain.copy(alpha = 0.15f)
                )
            )
        }
    }
}

private fun navigationIconFor(tabIndex: Int): ImageVector = when (tabIndex) {
    MawaredNavigation.TAB_DASHBOARD -> Icons.Filled.GridView
    MawaredNavigation.TAB_EMPLOYEES -> Icons.Filled.People
    MawaredNavigation.TAB_PURCHASING -> Icons.Filled.ShoppingCart
    MawaredNavigation.TAB_REPORTS -> Icons.Filled.Assessment
    MawaredNavigation.TAB_CHAT -> Icons.Filled.Chat
    MawaredNavigation.TAB_TASKS -> Icons.Filled.Assignment
    MawaredNavigation.TAB_TRAINING -> Icons.Filled.School
    MawaredNavigation.TAB_SUPPORT -> Icons.Filled.SupportAgent
    MawaredNavigation.TAB_AI_ASSISTANT -> Icons.Filled.AutoAwesome
    MawaredNavigation.TAB_ATTENDANCE -> Icons.Filled.AccessTime
    MawaredNavigation.TAB_LEAVES -> Icons.Filled.EventNote
    MawaredNavigation.TAB_PAYROLL -> Icons.Filled.Payments
    MawaredNavigation.TAB_AUTHORIZATION -> Icons.Filled.AdminPanelSettings
    MawaredNavigation.TAB_NOTIFICATIONS -> Icons.Filled.Notifications
    MawaredNavigation.TAB_MY_WORK -> Icons.Filled.Work
    MawaredNavigation.TAB_SECURITY_SESSIONS -> Icons.Filled.DevicesOther
    MawaredNavigation.TAB_GLOBAL_SEARCH -> Icons.Filled.Search
    else -> Icons.Filled.Apps
}

// ---------------- TAB 0: GENERAL SYSTEM DASHBOARD ----------------
@Composable
fun MawaredTechnicalSupport(viewModel: MawaredViewModel, user: LoggedInState.Authenticated) {
    var activeSubTab by remember { mutableStateOf(0) } // 0: help, 1: guidance, 2: support request

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        // Mode switch row
        ScrollableTabRow(
            selectedTabIndex = activeSubTab,
            containerColor = Color.Transparent,
            contentColor = EmeraldMain,
            edgePadding = 0.dp
        ) {
            Tab(
                selected = activeSubTab == 0,
                onClick = { activeSubTab = 0 },
                text = { Text("معلومات المساعدة", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
            )
            Tab(
                selected = activeSubTab == 1,
                onClick = { activeSubTab = 1 },
                text = { Text("إرشادات الاستخدام", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
            )
            Tab(
                selected = activeSubTab == 2,
                onClick = { activeSubTab = 2 },
                text = { Text("طلب دعم", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        when (activeSubTab) {
            0 -> {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = if (viewModel.isDarkTheme) Color(0xFF1E293B) else Color.White
                            ),
                            border = BorderStroke(1.dp, if (viewModel.isDarkTheme) Color(0xFF334155) else Color(0xFFE2E8F0))
                        ) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text(
                                    "كيف تحصل على المساعدة؟",
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 15.sp,
                                    color = EmeraldMain
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    "• استخدم قائمة التنقل للوصول إلى الشاشات المتاحة لحسابك.\n\n" +
                                    "• إذا لم يظهر قسم تحتاجه، اطلب من مسؤول النظام مراجعة صلاحيات حسابك.\n\n" +
                                    "• عند وجود مشكلة فنية، دوّن الخطوات التي سبقتها والرسالة التي ظهرت لك.\n\n" +
                                    "• لا تشارك كلمة المرور أو رموز الدخول ضمن طلب الدعم.",
                                    fontSize = 13.sp,
                                    color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                                    lineHeight = 20.sp
                                )
                            }
                        }
                    }

                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = if (viewModel.isDarkTheme) Color(0xFF131B2A) else Color(0xFFF1F5F9)
                            ),
                            border = BorderStroke(1.dp, if (viewModel.isDarkTheme) Color(0xFF1E293B) else Color(0xFFCBD5E1))
                        ) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text(
                                    "قبل إرسال طلب الدعم",
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 15.sp,
                                    color = MintLight
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    "1. تأكد من اتصال الجهاز بالإنترنت.\n\n" +
                                    "2. أعد فتح الشاشة التي ظهرت فيها المشكلة.\n\n" +
                                    "3. اكتب وصفاً واضحاً للمشكلة دون إدخال بيانات سرية.\n\n" +
                                    "4. تواصل مع مسؤول النظام إذا كانت المشكلة مرتبطة بالصلاحيات.",
                                    fontSize = 13.sp,
                                    color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                                    lineHeight = 20.sp
                                )
                            }
                        }
                    }
                }
            }

            1 -> {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = if (viewModel.isDarkTheme) Color(0xFF1E293B) else Color.White
                            ),
                            border = BorderStroke(1.dp, EmeraldMain.copy(0.3f))
                        ) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.Security, contentDescription = "إرشادات", tint = EmeraldMain)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        "إرشادات الاستخدام الآمن",
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 15.sp,
                                        color = EmeraldMain
                                    )
                                }
                                Spacer(modifier = Modifier.height(12.dp))
                                Text(
                                    "• استخدم حسابك الشخصي فقط ولا تسمح للآخرين باستخدامه.\n\n" +
                                    "• راجع البيانات قبل اعتماد أي إجراء إداري أو مالي.\n\n" +
                                    "• سجّل الخروج عند استخدام جهاز مشترك.\n\n" +
                                    "• بلّغ مسؤول النظام عن أي نشاط غير معتاد أو صلاحية غير متوقعة.",
                                    fontSize = 13.sp,
                                    color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                                    lineHeight = 22.sp
                                )
                            }
                        }
                    }
                }
            }

            2 -> {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(
                            imageVector = Icons.Default.SupportAgent,
                            contentDescription = "دعم",
                            tint = EmeraldMain,
                            modifier = Modifier.size(72.dp)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            "إذا واجهت مشكلة في استخدام النظام، أرسل وصفاً واضحاً للمشكلة ليتم توجيه طلبك للدعم.",
                            textAlign = TextAlign.Center,
                            fontSize = 13.sp,
                            color = if (viewModel.isDarkTheme) Color.White else SlateDark,
                            lineHeight = 20.sp,
                            modifier = Modifier.padding(horizontal = 16.dp)
                        )
                        Spacer(modifier = Modifier.height(24.dp))
                        Button(
                            onClick = { viewModel.isSupportDrawerOpen = true },
                            colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                        ) {
                            Text("إرسال طلب دعم", color = SlateDark, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

// Helper formatting function for Arabic Currency (SAR)
fun formatCurrency(amount: Double): String {
    val formatter = NumberFormat.getCurrencyInstance(Locale("ar", "SA"))
    // Strip fractional parts for cleaner ERP display
    return formatter.format(amount).replace("٫٠٠", "").replace(".00", "")
}

fun formatCurrency(amount: String): String {
    val value = amount.toBigDecimalOrNull() ?: java.math.BigDecimal.ZERO
    return NumberFormat.getCurrencyInstance(Locale("ar", "SA")).format(value)
}

// ---------------- DYNAMIC GEMINI AI COPILOT VIEW ----------------
