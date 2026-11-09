package com.example.ui

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
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
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
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
import com.example.core.auth.CompanyLoginRules
import com.example.data.demo.DemoLoginProfiles
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.ChatMessage
import com.example.data.model.Task
import com.example.data.model.TrainingCourse
import com.example.data.model.TrainingAssignment
import com.example.ui.theme.*
import com.example.ui.ux.MawaredPasswordField
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

@Composable
fun MawaredWelcomeScreen(viewModel: MawaredViewModel) {
    val authUiState by viewModel.authUiState.collectAsState()
    val focusManager = LocalFocusManager.current
    val fieldsRequiredMessage = stringResource(R.string.login_fields_required)
    val submitLogin: () -> Unit = {
        if (authUiState.isLoading) {
            Unit
        } else if (!CompanyLoginRules.canSubmit(
                viewModel.inputCompanyCode,
                viewModel.inputIdentifier,
                viewModel.inputPassword,
                false
            )
        ) {
            viewModel.showNotification(fieldsRequiredMessage)
        } else {
            focusManager.clearFocus()
            viewModel.login(
                viewModel.inputCompanyCode,
                viewModel.inputIdentifier,
                viewModel.inputPassword
            )
        }
    }
    val gradientBrush = Brush.verticalGradient(
        colors = listOf(SlateMedium, SlateDark)
    )
    val loginFieldColors = Triple(EmeraldMain, EmeraldMain, Color.White)

    MawaredScrollableForm(
        modifier = Modifier
            .fillMaxSize()
            .background(gradientBrush)
            .padding(24.dp),
        bottomAction = null
    ) {
        Spacer(modifier = Modifier.height(40.dp))

        // Brand Icon / Graphic
        Box(
            modifier = Modifier
                .size(100.dp)
                .background(
                    Brush.radialGradient(listOf(EmeraldMain.copy(alpha = 0.4f), Color.Transparent)),
                    shape = CircleShape
                )
                .drawBehind {
                    drawRect(color = Color.Transparent)
                },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Filled.Business,
                contentDescription = stringResource(R.string.app_name),
                tint = EmeraldMain,
                modifier = Modifier.size(64.dp)
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineLarge,
            color = Color.White,
            fontWeight = FontWeight.Black,
            letterSpacing = 2.sp,
            textAlign = TextAlign.Center
        )
        Text(
            text = "النظام المتكامل لإدارة الموارد البشرية والمشتريات والموازنات",
            style = MaterialTheme.typography.titleMedium,
            color = SlateLight,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp)
        )

        // DEMO_MODE only: demo login selector. Hidden entirely in production (DEMO_MODE=false).
        // These profiles are display-only and are NEVER used for authorization.
        if (BuildConfig.DEMO_MODE) {
            Spacer(modifier = Modifier.height(35.dp))

            Surface(
                color = SlateMedium,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, EmeraldMain.copy(alpha = 0.3f)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.Start
                ) {
                    Text(
                        text = "اختر حساب الموظف للمحاكاة (تخصيص الصلاحيات):",
                        style = MaterialTheme.typography.bodyMedium,
                        color = EmeraldMain,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(bottom = 12.dp)
                    )

                    DemoLoginProfiles.profiles.forEachIndexed { idx, profile ->
                        val isSelected = viewModel.selectedDemoUserIndex == idx
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .background(
                                    color = if (isSelected) EmeraldMain.copy(alpha = 0.15f) else Color.Transparent,
                                    shape = RoundedCornerShape(8.dp)
                                )
                                .clickable { viewModel.selectDemoUser(idx) }
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(
                                selected = isSelected,
                                onClick = { viewModel.selectDemoUser(idx) },
                                colors = RadioButtonDefaults.colors(selectedColor = EmeraldMain)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Column {
                                Text(
                                    text = profile.fullName,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = Color.White,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = "${profile.companyCode} • ${profile.identifier}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = SlateLight
                                )
                                Text(
                                    text = "${profile.roleName} • قسم ${profile.departmentName}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = SlateLight
                                )
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(30.dp))

            Button(
                onClick = submitLogin,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.Login, contentDescription = stringResource(R.string.sign_in), tint = SlateDark)
                Spacer(modifier = Modifier.width(12.dp))
                Text(stringResource(R.string.sign_in), color = SlateDark, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }

        } else {
            Spacer(modifier = Modifier.height(35.dp))

            MawaredTextField(
                value = viewModel.inputCompanyCode,
                onValueChange = { value ->
                    viewModel.inputCompanyCode = value.uppercase(Locale.ROOT)
                        .filter { it in 'A'..'Z' || it in '0'..'9' || it == '-' }
                        .take(32)
                },
                label = stringResource(R.string.company_code),
                capitalization = KeyboardCapitalization.Characters,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Next,
                forceLtr = true,
                focusedBorderColor = loginFieldColors.first,
                unfocusedBorderColor = SlateLight,
                textColor = loginFieldColors.third,
                labelColor = loginFieldColors.second
            )

            Spacer(modifier = Modifier.height(16.dp))

            MawaredTextField(
                value = viewModel.inputIdentifier,
                onValueChange = { viewModel.inputIdentifier = it.take(320) },
                label = stringResource(R.string.login_identifier),
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Next,
                forceLtr = true,
                focusedBorderColor = loginFieldColors.first,
                unfocusedBorderColor = SlateLight,
                textColor = loginFieldColors.third,
                labelColor = loginFieldColors.second
            )

            Spacer(modifier = Modifier.height(16.dp))

            MawaredPasswordField(
                value = viewModel.inputPassword,
                onValueChange = { viewModel.inputPassword = it },
                label = stringResource(R.string.password),
                imeAction = ImeAction.Done,
                onImeAction = submitLogin,
                focusedBorderColor = loginFieldColors.first,
                unfocusedBorderColor = SlateLight,
                textColor = loginFieldColors.third,
                labelColor = loginFieldColors.second
            )

            if (!authUiState.errorMessage.isNullOrEmpty()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = authUiState.errorMessage!!,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Right
                )
            }

            Spacer(modifier = Modifier.height(30.dp))

            Button(
                onClick = submitLogin,
                enabled = !authUiState.isLoading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain, disabledContainerColor = EmeraldMain.copy(alpha = 0.5f)),
                shape = RoundedCornerShape(12.dp)
            ) {
                if (authUiState.isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = SlateDark,
                        strokeWidth = 2.dp
                    )
                } else {
                    Icon(Icons.Default.Login, contentDescription = stringResource(R.string.sign_in), tint = SlateDark)
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        stringResource(R.string.sign_in),
                        color = SlateDark,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))
            TextButton(
                onClick = { viewModel.openOwnerForgotPassword() },
                enabled = !authUiState.isLoading,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = stringResource(R.string.owner_recovery_forgot_link),
                    color = EmeraldMain,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }

        Spacer(modifier = Modifier.height(20.dp))
        HorizontalDivider(color = SlateLight.copy(alpha = 0.35f))
        Spacer(modifier = Modifier.height(12.dp))
        Text(
            text = stringResource(
                if (authUiState.hasRememberedSession) {
                    R.string.biometric_company_prompt
                } else {
                    R.string.biometric_first_login
                }
            ),
            style = MaterialTheme.typography.bodySmall,
            color = SlateLight,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(8.dp))

        OutlinedButton(
            onClick = { viewModel.initBiometricLogin() },
            enabled = authUiState.hasRememberedSession && !authUiState.isLoading,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = EmeraldMain),
            border = BorderStroke(1.dp, EmeraldMain),
            shape = RoundedCornerShape(12.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Fingerprint,
                contentDescription = stringResource(R.string.biometric_sign_in),
                tint = EmeraldMain
            )
            Spacer(modifier = Modifier.width(12.dp))
            Text(
                text = stringResource(R.string.biometric_sign_in),
                color = EmeraldMain,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.Security,
                contentDescription = null,
                tint = SlateLight,
                modifier = Modifier.size(16.dp)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = stringResource(R.string.ux_login_security_note),
                style = MaterialTheme.typography.bodySmall,
                color = SlateLight
            )
        }
        Spacer(modifier = Modifier.height(30.dp))
    }
}

// ---------------- BIOMETRIC HARDWARE CHALLENGE SCREEN ----------------
@Composable
fun MawaredBiometricScreen(viewModel: MawaredViewModel) {
    var isFingerScanning by remember { mutableStateOf(false) }
    val infiniteTransition = rememberInfiniteTransition(label = "RadarAnimation")

    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.9f,
        targetValue = 1.3f,
        animationSpec = infiniteRepeatable(
            animation = tween(1200, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulsePulse"
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SlateDark)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "تسجيل الدخول بالبصمة",
            style = MaterialTheme.typography.headlineMedium,
            color = Color.White,
            fontWeight = FontWeight.Bold
        )
        Text(
            text = "يرجى لمس حساس البصمة للمتابعة والتحقق",
            style = MaterialTheme.typography.bodyMedium,
            color = SlateLight,
            modifier = Modifier.padding(top = 8.dp)
        )

        Spacer(modifier = Modifier.height(60.dp))

        // Circular Scanner Button
        Box(
            modifier = Modifier
                .size(160.dp)
                .drawBehind {
                    drawCircle(
                        color = EmeraldMain.copy(alpha = 0.15f * pulseScale),
                        radius = size.minDimension / 1.5f * pulseScale
                    )
                }
                .background(
                    color = if (isFingerScanning) EmeraldMain.copy(alpha = 0.2f) else SlateMedium,
                    shape = CircleShape
                )
                .border(2.dp, EmeraldMain, CircleShape)
                .clickable {
                    if (!isFingerScanning) {
                        isFingerScanning = true
                        // Simulate hardware verification and unlock MFA
                        viewModel.showNotification("جرس: تم التعرف على البصمة بنجاح!")
                        viewModel.approveBiometrics()
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            if (isFingerScanning) {
                CircularProgressIndicator(
                    color = EmeraldMain,
                    modifier = Modifier.size(120.dp)
                )
            }
            Icon(
                imageVector = Icons.Default.Fingerprint,
                contentDescription = "حساس بصمة الإصبع",
                tint = EmeraldMain,
                modifier = Modifier.size(80.dp)
            )
        }

        Spacer(modifier = Modifier.height(50.dp))

        Text(
            text = "اضغط على البصمة لمحاكاة اللمس الفوري للجهاز",
            style = MaterialTheme.typography.bodySmall,
            color = EmeraldMain,
            fontWeight = FontWeight.Medium
        )

        Spacer(modifier = Modifier.height(40.dp))

        TextButton(onClick = { viewModel.logOut() }) {
            Text("إلغاء والرجوع للخلف", color = RedStatus)
        }
    }
}

// ---------------- TWO FACTOR (MFA) SCREEN ----------------
@Composable
fun MawaredMfaScreen(viewModel: MawaredViewModel) {
    val codeRequired = stringResource(R.string.mfa_code_required)
    MawaredScrollableForm(
        modifier = Modifier
            .fillMaxSize()
            .background(SlateDark)
            .padding(24.dp)
    ) {
        Spacer(modifier = Modifier.height(48.dp))
        Icon(
            imageVector = Icons.Default.LockReset,
            contentDescription = stringResource(R.string.mfa_title),
            tint = AmberStatus,
            modifier = Modifier.size(64.dp)
        )
        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.mfa_title),
            style = MaterialTheme.typography.headlineSmall,
            color = Color.White,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
        Text(
            text = stringResource(R.string.mfa_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = SlateLight,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp)
        )

        viewModel.mfaEnrollment?.let { enrollment ->
            Spacer(modifier = Modifier.height(16.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = SlateMedium),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        stringResource(R.string.mfa_enrollment_instructions),
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        enrollment.manualSecret,
                        color = AmberStatus,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyLarge
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(30.dp))

        if (viewModel.mfaBackupCodes.isNotEmpty()) {
            Card(
                colors = CardDefaults.cardColors(containerColor = SlateMedium),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        stringResource(R.string.mfa_backup_codes_title),
                        color = Color.White,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        stringResource(R.string.mfa_backup_codes_warning),
                        color = AmberStatus,
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    viewModel.mfaBackupCodes.forEach { code ->
                        Text(code, color = Color.White, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Button(
                onClick = viewModel::confirmMfaBackupCodesSaved,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
            ) {
                Text(stringResource(R.string.mfa_backup_codes_saved), color = SlateDark)
            }
        } else {
            MawaredTextField(
                value = viewModel.inputMfaCode,
                onValueChange = {
                    viewModel.inputMfaCode = it
                        .filter { ch -> ch.isLetterOrDigit() || ch == '-' }
                        .uppercase()
                        .take(11)
                },
                label = stringResource(R.string.mfa_code_label),
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
                forceLtr = true,
                onImeAction = {
                    if (viewModel.inputMfaCode.isBlank()) {
                        viewModel.mfaError = codeRequired
                    } else {
                        viewModel.verifyMfa()
                    }
                },
                isError = viewModel.mfaError.isNotEmpty(),
                supportingText = viewModel.mfaError.takeIf { it.isNotEmpty() },
                focusedBorderColor = EmeraldMain,
                unfocusedBorderColor = SlateLight,
                textColor = Color.White,
                labelColor = EmeraldMain
            )

            Spacer(modifier = Modifier.height(12.dp))

            if (BuildConfig.DEMO_MODE) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = SlateMedium),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Lightbulb,
                            contentDescription = null,
                            tint = AmberStatus,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "رمز المحاكاة السريع هو: 1234",
                            style = MaterialTheme.typography.bodySmall,
                            color = Color.White
                        )
                    }
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            Button(
                onClick = {
                    if (viewModel.inputMfaCode.isBlank()) {
                        viewModel.mfaError = codeRequired
                    } else {
                        viewModel.verifyMfa()
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text(
                    text = stringResource(R.string.mfa_verify),
                    color = SlateDark,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
        TextButton(onClick = { viewModel.logOut() }) {
            Text(stringResource(R.string.ux_cancel), color = RedStatus)
        }
        Spacer(modifier = Modifier.height(30.dp))
    }
}

// ---------------- MAIN LOGGED-IN SYSTEM CONTROLLER ----------------
