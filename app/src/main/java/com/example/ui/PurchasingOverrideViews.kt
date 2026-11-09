package com.example.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.domain.model.PURCHASING_OVERRIDE_CONFIRMATION_TOKEN
import com.example.domain.model.PURCHASING_OVERRIDE_NOTICE
import com.example.domain.model.PurchaseRequestParams
import com.example.domain.model.purchasingOverrideLegalActionsFor
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateLight

/**
 * Sprint 12I — purchasing admin override (`purchasing.admin_override`) UI.
 *
 * Mirrors the backend's second-confirmation contract 1:1
 * (`backend/src/purchasingOverride.ts`): the actor must pick approve/reject/cancel from
 * only the currently-legal transitions, provide a mandatory reason, and type the exact
 * token `OVERRIDE` before the confirm button becomes enabled. Kept in its own file (not
 * `PurchaseViews.kt`) to avoid clashing with the vendor-archive work also landing there.
 */
private fun overrideActionLabel(action: String): String = when (action) {
    "approve" -> "اعتماد"
    "reject" -> "رفض"
    "cancel" -> "إلغاء"
    else -> action
}

@Composable
fun PurchasingOverrideButton(onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Icon(Icons.Default.AdminPanelSettings, contentDescription = null, modifier = Modifier.height(16.dp).width(16.dp))
        Spacer(Modifier.width(4.dp))
        Text("إجراء إداري", color = RedStatus)
    }
}

@Composable
fun PurchasingOverrideDialog(
    request: PurchaseRequestParams,
    statusLabel: String,
    isSubmitting: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (action: String, reason: String) -> Unit
) {
    val legalActions = remember(request.id, request.status) { purchasingOverrideLegalActionsFor(request.status) }
    var action by remember(request.id) { mutableStateOf(legalActions.firstOrNull().orEmpty()) }
    var reason by remember(request.id) { mutableStateOf("") }
    var confirmationInput by remember(request.id) { mutableStateOf("") }
    val confirmationMatches = confirmationInput.trim() == PURCHASING_OVERRIDE_CONFIRMATION_TOKEN
    val canSubmit = legalActions.isNotEmpty() && action.isNotBlank() && reason.isNotBlank() && confirmationMatches

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text("إجراء إداري استثنائي على طلب الشراء") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(request.requestNumber, style = MaterialTheme.typography.labelMedium, color = SlateLight)
                Text(request.title, fontWeight = FontWeight.Bold)
                Text("الحالة الحالية: $statusLabel", style = MaterialTheme.typography.bodySmall)
                Text(PURCHASING_OVERRIDE_NOTICE, style = MaterialTheme.typography.bodySmall, color = RedStatus)
                if (legalActions.isEmpty()) {
                    Text(
                        "لا يمكن تنفيذ أي إجراء إداري على هذا الطلب في حالته الحالية.",
                        color = RedStatus
                    )
                } else {
                    Column {
                        legalActions.forEach { value ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(
                                    selected = action == value,
                                    onClick = { action = value },
                                    enabled = !isSubmitting
                                )
                                Text(overrideActionLabel(value))
                            }
                        }
                    }
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("سبب الإجراء الإداري (مطلوب)") },
                        enabled = !isSubmitting,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = confirmationInput,
                        onValueChange = { confirmationInput = it },
                        label = { Text("اكتب OVERRIDE للتأكيد") },
                        isError = confirmationInput.isNotEmpty() && !confirmationMatches,
                        enabled = !isSubmitting,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        },
        confirmButton = {
            Button(
                enabled = canSubmit && !isSubmitting,
                onClick = { onConfirm(action, reason.trim()) }
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(modifier = Modifier.height(16.dp).width(16.dp))
                    Spacer(Modifier.width(6.dp))
                }
                Text("تنفيذ الإجراء الإداري")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !isSubmitting) { Text("رجوع") } }
    )
}
