package com.example.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.domain.model.OneTimeCredential

@Composable
fun EmployeeCreateCredentialDialog(
    employeeName: String,
    initialEmail: String,
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onConfirm: (email: String) -> Unit
) {
    var email by remember(initialEmail) { mutableStateOf(initialEmail) }

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = {
            Text(text = "إنشاء بيانات الدخول", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "سيتم إنشاء كلمة مرور مؤقتة لمرة واحدة لـ $employeeName. لن تُعرض مرة أخرى بعد الإغلاق.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSubmitting,
                    label = { Text("البريد الإلكتروني") },
                    singleLine = true
                )
                if (!errorMessage.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(email.trim()) },
                enabled = !isSubmitting && email.trim().isNotBlank()
            ) {
                Text(if (isSubmitting) "جاري الإنشاء..." else "إنشاء")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) {
                Text("إلغاء")
            }
        }
    )
}

@Composable
fun EmployeeResetCredentialDialog(
    employeeName: String,
    isSubmitting: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onConfirm: (reason: String) -> Unit
) {
    var reason by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = {
            Text(text = "إعادة تعيين كلمة المرور", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "سيتم إنهاء جلسات $employeeName وإصدار كلمة مرور مؤقتة جديدة تُعرض مرة واحدة فقط.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSubmitting,
                    label = { Text("سبب إعادة التعيين") },
                    minLines = 2
                )
                if (!errorMessage.isNullOrBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(reason.trim()) },
                enabled = !isSubmitting && reason.trim().length >= 3
            ) {
                Text(if (isSubmitting) "جاري إعادة التعيين..." else "تأكيد")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) {
                Text("إلغاء")
            }
        }
    )
}

@Composable
fun EmployeeOneTimeCredentialDialog(
    employeeName: String,
    credential: OneTimeCredential,
    onDismiss: () -> Unit
) {
    // Hold a local copy so the parent can clear controller state on dismiss
    // without the dialog retaining a stale reference after close.
    var revealedPassword by remember(credential.temporaryPassword) {
        mutableStateOf(credential.temporaryPassword)
    }
    DisposableEffect(Unit) {
        onDispose {
            revealedPassword = ""
        }
    }

    AlertDialog(
        onDismissRequest = {
            revealedPassword = ""
            onDismiss()
        },
        title = {
            Text(text = "كلمة المرور المؤقتة", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "انسخ كلمة المرور لـ $employeeName الآن. لن تظهر مرة أخرى ولا تُحفظ في السجلات أو الإشعارات.",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = revealedPassword,
                    style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace),
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "تنتهي في: ${credential.expiresAt}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "تحذير: بعد الإغلاق لا يمكن عرض كلمة المرور مرة أخرى.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    revealedPassword = ""
                    onDismiss()
                }
            ) {
                Text("تم النسخ / إغلاق")
            }
        }
    )
}
