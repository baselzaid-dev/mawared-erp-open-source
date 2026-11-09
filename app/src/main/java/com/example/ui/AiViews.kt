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
import com.example.R
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

@Composable
fun MawaredAiCopilotView(viewModel: MawaredViewModel, user: LoggedInState.Authenticated) {
    val aiMessages by viewModel.aiMessages.collectAsState()
    val scrollState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // Scroll to bottom when new messages arrive
    LaunchedEffect(aiMessages.size) {
        if (aiMessages.isNotEmpty()) {
            scrollState.animateScrollToItem(aiMessages.size - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        // Assistant header
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (viewModel.isDarkTheme) SlateMedium else Color.White
            ),
            border = BorderStroke(1.dp, if (viewModel.isDarkTheme) Color(0xFF334155) else Color(0xFFE2E8F0)),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .padding(16.dp)
                    .fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.weight(1f)
                ) {
                    Box(
                        modifier = Modifier
                            .background(EmeraldMain.copy(alpha = 0.15f), CircleShape)
                            .padding(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.AutoAwesome,
                            contentDescription = "مساعد الذكاء الاصطناعي",
                            tint = EmeraldMain,
                            modifier = Modifier.size(24.dp)
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "مساعد الذكاء الاصطناعي",
                            fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.titleMedium,
                            color = if (viewModel.isDarkTheme) Color.White else SlateDark
                        )
                        Text(
                            text = "يساعدك في صياغة الاستفسارات ومراجعة المعلومات، ${user.userName}",
                            fontSize = 11.sp,
                            color = SlateLight
                        )
                    }
                }

                Spacer(modifier = Modifier.width(8.dp))
                Button(
                    onClick = { viewModel.clearAiChat() },
                    colors = ButtonDefaults.buttonColors(containerColor = RedStatus.copy(alpha = 0.15f)),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Text("مسح المحادثة", color = RedStatus, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Prompt suggestions
        Text(
            text = "اقتراحات جاهزة:",
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = SlateLight,
            modifier = Modifier.padding(bottom = 6.dp)
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            val suggestions = listOf(
                "أعطني ملخصاً مالياً كاملاً للرواتب والمشتريات الحالية للشركة 📊",
                "من هو الموظف صاحب أعلى راتب ومن يحصل على أقل حافز؟ 💸",
                "افحص برامج التدريب والتكليفات الموجهة، وحدد ما إذا كان هناك تعثر بالتقدم 🎓",
                "اقترح خطة عمل فورية لرفع كفاءة تكنولوجيا المعلومات بناء على المهام المعلقة ⚡",
                "اكتب لي مسودة تعميم داخلي للموظفين لتهنئتهم بإطلاق نظام Mawared ERP الجديد 🎉"
            )

            suggestions.forEach { suggestion ->
                Surface(
                    onClick = {
                        viewModel.aiInputText = suggestion
                        viewModel.submitAiPrompt()
                    },
                    color = if (viewModel.isDarkTheme) Color(0xFF1E293B) else Color(0xFFE2E8F0),
                    shape = RoundedCornerShape(20.dp),
                    border = BorderStroke(1.dp, if (viewModel.isDarkTheme) Color(0xFF334155) else Color(0xFFCBD5E1)),
                    modifier = Modifier
                        .widthIn(min = 220.dp, max = 340.dp)
                        .heightIn(max = 42.dp)
                ) {
                    Text(
                        text = suggestion,
                        fontSize = 11.sp,
                        color = if (viewModel.isDarkTheme) MintLight else SlateDark,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                    )
                }
            }
        }

        // Error message banner
        viewModel.aiErrorMessage?.let { err ->
            val displayError = if (
                err.contains("503") ||
                err.contains("unavailable", ignoreCase = true) ||
                err.contains("not configured", ignoreCase = true) ||
                err.contains("غير مفعلة")
            ) {
                "خدمة الذكاء الاصطناعي غير مفعلة حالياً"
            } else {
                err
            }
            Surface(
                color = RedStatus.copy(alpha = 0.15f),
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, RedStatus.copy(alpha = 0.3f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp)
            ) {
                Row(
                    modifier = Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.Error, contentDescription = stringResource(R.string.ux_error_cd), tint = RedStatus, modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(displayError, color = RedStatus, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
        }

        // Messages Conversation list
        LazyColumn(
            state = scrollState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(
                    if (viewModel.isDarkTheme) Color(0xFF0B111E) else Color(0xFFF8FAFC),
                    RoundedCornerShape(12.dp)
                )
                .border(
                    1.dp,
                    if (viewModel.isDarkTheme) Color(0xFF1E293B) else Color(0xFFF1F5F9),
                    RoundedCornerShape(12.dp)
                )
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(aiMessages, key = { it.messageId }) { msg ->
                val isAi = msg.sender == "مساعد AI"
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = if (isAi) Alignment.Start else Alignment.End
                ) {
                    // Chat Bubble container
                    Surface(
                        color = if (isAi) {
                            if (viewModel.isDarkTheme) SlateMedium else Color(0xFFE2E8F0)
                        } else {
                            EmeraldMain
                        },
                        shape = RoundedCornerShape(
                            topStart = 12.dp,
                            topEnd = 12.dp,
                            bottomStart = if (isAi) 0.dp else 12.dp,
                            bottomEnd = if (isAi) 12.dp else 0.dp
                        ),
                        modifier = Modifier.widthIn(max = 290.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            // Speaker name/role
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text(
                                    text = msg.sender,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (isAi) {
                                        if (viewModel.isDarkTheme) EmeraldMain else Color(0xFF047857)
                                    } else {
                                        SlateDark
                                    }
                                )
                                Text(
                                    text = if (isAi) "المساعد" else "رسالتك",
                                    fontSize = 8.sp,
                                    color = if (isAi) SlateLight else SlateDark.copy(alpha = 0.6f)
                                )
                            }
                            Spacer(modifier = Modifier.height(6.dp))
                            // Content
                            Text(
                                text = msg.text,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Normal,
                                color = if (isAi) {
                                    if (viewModel.isDarkTheme) Color.White else SlateDark
                                } else {
                                    SlateDark
                                },
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }
                }
            }

            if (viewModel.isAiLoading) {
                item {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(8.dp)
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = EmeraldMain,
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            "جارٍ إعداد الرد...",
                            fontSize = 11.sp,
                            color = SlateLight
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Input Box footer
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = viewModel.aiInputText,
                onValueChange = { viewModel.aiInputText = it },
                placeholder = { Text("اكتب استفسارك هنا...", fontSize = 12.sp) },
                modifier = Modifier.weight(1f),
                singleLine = false,
                maxLines = 3,
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EmeraldMain,
                    unfocusedBorderColor = if (viewModel.isDarkTheme) Color(0xFF334155) else Color(0xFFCBD5E1),
                    focusedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark,
                    unfocusedTextColor = if (viewModel.isDarkTheme) Color.White else SlateDark
                )
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(
                onClick = { viewModel.submitAiPrompt() },
                modifier = Modifier
                    .background(EmeraldMain, CircleShape)
                    .size(48.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Send,
                    contentDescription = "إرسال",
                    tint = SlateDark
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Clear user-facing accuracy notice without provider or infrastructure claims.
        Surface(
            color = if (viewModel.isDarkTheme) Color(0xFF131B2A) else Color(0xFFF1F5F9),
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = "قد تكون الإجابات غير دقيقة. راجع بيانات النظام قبل اعتماد أي قرار إداري أو مالي.",
                fontSize = 9.sp,
                color = SlateLight,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(10.dp)
            )
        }
    }
}

// ---------------- TAB 9: ATTENDANCE & TIME TRACKING (الحضور والدوام) ----------------
// Driven entirely by AttendanceUiState. Authorization is canView / canClock / canManage /
// canApprove (derived from CurrentSession.permissions via PermissionChecker). No role/name checks.
