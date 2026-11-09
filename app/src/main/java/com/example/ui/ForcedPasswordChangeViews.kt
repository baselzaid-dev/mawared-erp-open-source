package com.example.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LockReset
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun ForcedPasswordChangeScreen(
    state: ForcedPasswordChangeUiState,
    actions: ForcedPasswordChangeActions,
    modifier: Modifier = Modifier
) {
    when (state) {
        is ForcedPasswordChangeUiState.Completed -> {
            ForcedPasswordChangeSuccessCard(result = state.result)
        }
        is ForcedPasswordChangeUiState.Blocking -> {
            ForcedPasswordChangeForm(
                state = state,
                actions = actions,
                modifier = modifier
            )
        }
    }
}

@Composable
private fun ForcedPasswordChangeForm(
    state: ForcedPasswordChangeUiState.Blocking,
    actions: ForcedPasswordChangeActions,
    modifier: Modifier = Modifier
) {
    var temporaryPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }

    // Clear temporary credential fields from Compose memory when leaving.
    DisposableEffect(Unit) {
        onDispose {
            temporaryPassword = ""
            newPassword = ""
            confirmPassword = ""
        }
    }

    Scaffold(modifier = modifier.fillMaxSize()) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 24.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                imageVector = Icons.Filled.LockReset,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
            Text(
                text = "تغيير كلمة المرور مطلوب",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = "يجب تغيير كلمة المرور المؤقتة قبل متابعة استخدام التطبيق.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = temporaryPassword,
                onValueChange = { temporaryPassword = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isSubmitting,
                label = { Text("كلمة المرور المؤقتة") },
                visualTransformation = PasswordVisualTransformation()
            )
            OutlinedTextField(
                value = newPassword,
                onValueChange = { newPassword = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isSubmitting,
                label = { Text("كلمة المرور الجديدة") },
                visualTransformation = PasswordVisualTransformation()
            )
            OutlinedTextField(
                value = confirmPassword,
                onValueChange = { confirmPassword = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isSubmitting,
                label = { Text("تأكيد كلمة المرور الجديدة") },
                visualTransformation = PasswordVisualTransformation()
            )
            if (!state.errorMessage.isNullOrBlank()) {
                Text(
                    text = state.errorMessage,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Button(
                onClick = {
                    actions.onSubmit(temporaryPassword, newPassword, confirmPassword)
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isSubmitting
            ) {
                Text(if (state.isSubmitting) "جاري الحفظ..." else "حفظ كلمة المرور الجديدة")
            }
        }
    }
}

@Composable
private fun ForcedPasswordChangeSuccessCard(
    result: com.example.domain.model.ForcedPasswordChangeResult,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer
            )
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(
                    text = "تم تغيير كلمة المرور",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "تم إنهاء ${result.sessionsRevoked} جلسة أخرى لحماية حسابك.",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }
    }
}
