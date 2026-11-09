package com.example.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.LockReset
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.R
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium
import com.example.ui.ux.MawaredPasswordField
import com.example.ui.ux.MawaredScrollableForm
import com.example.ui.ux.MawaredTextField

@Composable
fun OwnerForgotPasswordScreen(
    state: OwnerForgotUiState,
    actions: OwnerRecoveryActions,
    onBack: () -> Unit,
    onEnterTokenManually: (companyCode: String) -> Unit,
    modifier: Modifier = Modifier
) {
    val gradientBrush = Brush.verticalGradient(colors = listOf(SlateMedium, SlateDark))
    MawaredScrollableForm(
        modifier = modifier
            .fillMaxSize()
            .background(gradientBrush)
            .padding(24.dp),
        bottomAction = null
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.ux_back),
                    tint = Color.White
                )
            }
            Text(
                text = stringResource(R.string.owner_recovery_forgot_title),
                style = MaterialTheme.typography.titleLarge,
                color = Color.White,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = stringResource(R.string.owner_recovery_forgot_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = SlateLight,
            textAlign = TextAlign.Start
        )
        Spacer(modifier = Modifier.height(24.dp))

        when (state) {
            is OwnerForgotUiState.Accepted -> {
                Icon(
                    imageVector = Icons.Filled.MarkEmailRead,
                    contentDescription = null,
                    tint = EmeraldMain,
                    modifier = Modifier.size(48.dp)
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = stringResource(R.string.owner_recovery_initiate_accepted),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color.White
                )
                Spacer(modifier = Modifier.height(24.dp))
                Button(
                    onClick = onBack,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = stringResource(R.string.owner_recovery_back_to_login),
                        color = SlateDark,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                TextButton(onClick = { onEnterTokenManually(state.companyCode) }) {
                    Text(
                        text = stringResource(R.string.owner_recovery_enter_token_manually),
                        color = EmeraldMain
                    )
                }
            }
            is OwnerForgotUiState.Form -> {
                MawaredTextField(
                    value = state.companyCode,
                    onValueChange = actions::onForgotCompanyCodeChange,
                    label = stringResource(R.string.company_code),
                    capitalization = KeyboardCapitalization.Characters,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Next,
                    forceLtr = true,
                    focusedBorderColor = EmeraldMain,
                    unfocusedBorderColor = SlateLight,
                    textColor = Color.White,
                    labelColor = EmeraldMain,
                    enabled = !state.isSubmitting
                )
                Spacer(modifier = Modifier.height(16.dp))
                MawaredTextField(
                    value = state.ownerEmail,
                    onValueChange = actions::onForgotEmailChange,
                    label = stringResource(R.string.owner_recovery_owner_email),
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Done,
                    forceLtr = true,
                    focusedBorderColor = EmeraldMain,
                    unfocusedBorderColor = SlateLight,
                    textColor = Color.White,
                    labelColor = EmeraldMain,
                    enabled = !state.isSubmitting
                )
                if (!state.errorMessageKey.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = ownerRecoveryMessage(state.errorMessageKey),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Spacer(modifier = Modifier.height(28.dp))
                Button(
                    onClick = actions::submitForgot,
                    enabled = !state.isSubmitting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = EmeraldMain,
                        disabledContainerColor = EmeraldMain.copy(alpha = 0.5f)
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    if (state.isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            color = SlateDark,
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text(
                            text = stringResource(R.string.owner_recovery_send_instructions),
                            color = SlateDark,
                            fontWeight = FontWeight.Bold,
                            fontSize = 16.sp
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun OwnerResetConfirmScreen(
    state: OwnerResetUiState,
    actions: OwnerRecoveryActions,
    hasInMemoryToken: Boolean,
    onBack: () -> Unit,
    onDoneToLogin: () -> Unit,
    modifier: Modifier = Modifier
) {
    // Clear password drafts from Compose memory when leaving the screen.
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    DisposableEffect(Unit) {
        onDispose {
            newPassword = ""
            confirmPassword = ""
            actions.onNewPasswordChange("")
            actions.onConfirmPasswordChange("")
        }
    }

    val gradientBrush = Brush.verticalGradient(colors = listOf(SlateMedium, SlateDark))
    MawaredScrollableForm(
        modifier = modifier
            .fillMaxSize()
            .background(gradientBrush)
            .padding(24.dp),
        bottomAction = null
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.ux_back),
                    tint = Color.White
                )
            }
            Text(
                text = stringResource(R.string.owner_recovery_reset_title),
                style = MaterialTheme.typography.titleLarge,
                color = Color.White,
                fontWeight = FontWeight.Bold
            )
        }
        Spacer(modifier = Modifier.height(12.dp))

        when (state) {
            OwnerResetUiState.Completed -> {
                Icon(
                    imageVector = Icons.Filled.LockReset,
                    contentDescription = null,
                    tint = EmeraldMain,
                    modifier = Modifier.size(48.dp)
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = stringResource(R.string.owner_recovery_complete),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color.White
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.owner_recovery_complete_sign_in_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = SlateLight
                )
                Spacer(modifier = Modifier.height(24.dp))
                Button(
                    onClick = onDoneToLogin,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = stringResource(R.string.owner_recovery_back_to_login),
                        color = SlateDark,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
            is OwnerResetUiState.Form -> {
                Text(
                    text = stringResource(R.string.owner_recovery_reset_subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = SlateLight
                )
                if (state.deepLinkRejected) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.owner_recovery_deeplink_rejected),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Spacer(modifier = Modifier.height(20.dp))
                if (state.requiresManualToken || !hasInMemoryToken) {
                    MawaredTextField(
                        value = state.manualToken,
                        onValueChange = actions::onManualTokenChange,
                        label = stringResource(R.string.owner_recovery_reset_token),
                        keyboardType = KeyboardType.Ascii,
                        imeAction = ImeAction.Next,
                        forceLtr = true,
                        focusedBorderColor = EmeraldMain,
                        unfocusedBorderColor = SlateLight,
                        textColor = Color.White,
                        labelColor = EmeraldMain,
                        enabled = !state.isSubmitting
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                } else {
                    Text(
                        text = stringResource(R.string.owner_recovery_token_ready),
                        style = MaterialTheme.typography.bodySmall,
                        color = EmeraldMain
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                }
                MawaredPasswordField(
                    value = newPassword,
                    onValueChange = {
                        newPassword = it
                        actions.onNewPasswordChange(it)
                    },
                    label = stringResource(R.string.owner_recovery_new_password),
                    imeAction = ImeAction.Next,
                    focusedBorderColor = EmeraldMain,
                    unfocusedBorderColor = SlateLight,
                    textColor = Color.White,
                    labelColor = EmeraldMain
                )
                Spacer(modifier = Modifier.height(16.dp))
                MawaredPasswordField(
                    value = confirmPassword,
                    onValueChange = {
                        confirmPassword = it
                        actions.onConfirmPasswordChange(it)
                    },
                    label = stringResource(R.string.owner_recovery_confirm_password),
                    imeAction = ImeAction.Done,
                    onImeAction = {
                        actions.submitReset(newPassword, confirmPassword)
                    },
                    focusedBorderColor = EmeraldMain,
                    unfocusedBorderColor = SlateLight,
                    textColor = Color.White,
                    labelColor = EmeraldMain
                )
                if (!state.errorMessageKey.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = ownerRecoveryMessage(state.errorMessageKey),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Spacer(modifier = Modifier.height(28.dp))
                Button(
                    onClick = {
                        actions.submitReset(newPassword, confirmPassword)
                        // Clear local Compose copies after submit attempt succeeds via state.
                    },
                    enabled = !state.isSubmitting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = EmeraldMain,
                        disabledContainerColor = EmeraldMain.copy(alpha = 0.5f)
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    if (state.isSubmitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            color = SlateDark,
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text(
                            text = stringResource(R.string.owner_recovery_submit_new_password),
                            color = SlateDark,
                            fontWeight = FontWeight.Bold,
                            fontSize = 16.sp
                        )
                    }
                }
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(
                    onClick = onBack,
                    enabled = !state.isSubmitting,
                    modifier = Modifier.fillMaxWidth(),
                    border = BorderStroke(1.dp, EmeraldMain),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = EmeraldMain),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(stringResource(R.string.ux_cancel), color = EmeraldMain)
                }
            }
        }
    }
}

@Composable
private fun ownerRecoveryMessage(messageKey: String): String = when (messageKey) {
    "owner_recovery.invalid_or_expired" -> stringResource(R.string.owner_recovery_invalid_or_expired)
    "owner_recovery.fields_required" -> stringResource(R.string.owner_recovery_fields_required)
    "password.too_short" -> stringResource(R.string.owner_recovery_password_too_short)
    "password.too_long" -> stringResource(R.string.owner_recovery_password_too_long)
    "password.contains_whitespace" -> stringResource(R.string.owner_recovery_password_whitespace)
    "password.confirm_mismatch" -> stringResource(R.string.owner_recovery_password_mismatch)
    "password.required" -> stringResource(R.string.owner_recovery_password_required)
    else -> stringResource(R.string.owner_recovery_generic_error)
}
