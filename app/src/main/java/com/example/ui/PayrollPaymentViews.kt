package com.example.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.example.domain.model.PayrollPaymentParams
import com.example.domain.model.PayrollPeriodParams
import com.example.domain.model.PAYROLL_PAYMENT_NO_BANK_TRANSFER_NOTICE
import com.example.domain.model.arabicPaymentState
import com.example.domain.model.arabicPaymentStatus
import com.example.domain.model.canRecordPayment
import com.example.domain.model.canVoidPayment
import com.example.domain.model.isVoided
import com.example.domain.model.numericPeriodLabel
import com.example.ui.theme.AmberStatus
import com.example.ui.theme.EmeraldMain
import com.example.ui.theme.RedStatus
import com.example.ui.theme.SlateDark
import com.example.ui.theme.SlateLight
import com.example.ui.theme.SlateMedium

private fun paymentStateColor(period: PayrollPeriodParams): Color = when (period.paymentState) {
    "paid" -> EmeraldMain
    "partially_paid" -> AmberStatus
    "unpaid" -> RedStatus
    else -> SlateLight
}

private fun formatMoney(value: String?, currency: String = "SAR"): String =
    value?.let { "$it ${if (currency == "SAR") "ر.س" else currency}" } ?: "غير متاح"

/**
 * Sprint 12H — payroll partial payments (v2). Shown for the selected period, below the
 * item breakdown, whenever the user holds `payroll.payments.view`.
 */
@Composable
fun PayrollPaymentsSection(
    period: PayrollPeriodParams,
    payments: List<PayrollPaymentParams>,
    isLoading: Boolean,
    canRecord: Boolean,
    canVoid: Boolean,
    isDarkTheme: Boolean,
    onRecordPayment: () -> Unit,
    onVoidPayment: (PayrollPaymentParams) -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    "المدفوعات — فترة ${period.numericPeriodLabel()}",
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                    color = if (isDarkTheme) Color.White else SlateDark
                )
                Box(
                    modifier = Modifier
                        .background(paymentStateColor(period).copy(alpha = 0.15f), RoundedCornerShape(6.dp))
                        .padding(vertical = 2.dp, horizontal = 8.dp)
                ) {
                    Text(period.arabicPaymentState(), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = paymentStateColor(period))
                }
            }
            if (canRecord && period.canRecordPayment()) {
                Button(onClick = onRecordPayment, shape = RoundedCornerShape(6.dp)) {
                    Text("تسجيل دفعة", fontSize = 11.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        if (isLoading) {
            Box(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.height(20.dp).width(20.dp), color = EmeraldMain)
            }
        } else if (payments.isEmpty()) {
            Text("لا توجد دفعات مسجلة لهذه الفترة.", fontSize = 11.sp, color = SlateLight)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                payments.forEach { payment ->
                    PayrollPaymentRow(
                        payment = payment,
                        canVoid = canVoid && !payment.isVoided() && period.canVoidPayment(),
                        onVoid = { onVoidPayment(payment) }
                    )
                }
            }
        }
    }
}

@Composable
fun PayrollPaymentRow(
    payment: PayrollPaymentParams,
    canVoid: Boolean,
    onVoid: () -> Unit
) {
    val statusColor = if (payment.isVoided()) SlateLight else EmeraldMain
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isSystemInDarkTheme()) SlateMedium.copy(alpha = 0.6f) else Color(0xFFF8FAFC)
        )
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    formatMoney(payment.amount, payment.currency),
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                    color = if (isSystemInDarkTheme()) Color.White else SlateDark
                )
                Text(
                    listOfNotNull(payment.paymentDate, payment.reference).joinToString(" • "),
                    fontSize = 9.sp,
                    color = SlateLight
                )
                if (payment.isVoided() && !payment.voidReason.isNullOrBlank()) {
                    Text("سبب الإلغاء: ${payment.voidReason}", fontSize = 9.sp, color = RedStatus)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(payment.arabicPaymentStatus(), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = statusColor)
                if (canVoid) {
                    TextButton(onClick = onVoid, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Icon(Icons.Default.Cancel, contentDescription = null, tint = RedStatus, modifier = Modifier.height(14.dp))
                        Spacer(modifier = Modifier.width(2.dp))
                        Text("إلغاء", fontSize = 10.sp, color = RedStatus)
                    }
                }
            }
        }
    }
}

@Composable
fun PayrollRecordPaymentDialog(
    isDarkTheme: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (amount: String, paymentDate: String, reference: String?, note: String?) -> Unit
) {
    var amount by remember { mutableStateOf("") }
    var paymentDate by remember {
        val today = java.util.Calendar.getInstance()
        mutableStateOf(
            "%04d-%02d-%02d".format(
                today.get(java.util.Calendar.YEAR),
                today.get(java.util.Calendar.MONTH) + 1,
                today.get(java.util.Calendar.DAY_OF_MONTH)
            )
        )
    }
    var reference by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = if (isDarkTheme) SlateMedium else Color.White
        ) {
            com.example.ui.ux.MawaredScrollableForm(modifier = Modifier.padding(20.dp)) {
                Text(
                    "تسجيل دفعة رواتب",
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isDarkTheme) Color.White else SlateDark
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(PAYROLL_PAYMENT_NO_BANK_TRANSFER_NOTICE, fontSize = 11.sp, color = SlateLight)
                Spacer(modifier = Modifier.height(12.dp))
                com.example.ui.ux.MawaredTextField(
                    value = amount,
                    onValueChange = { amount = it },
                    label = "قيمة الدفعة (ر.س)",
                    keyboardType = KeyboardType.Decimal,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))
                com.example.ui.ux.MawaredTextField(
                    value = paymentDate,
                    onValueChange = { paymentDate = it },
                    label = "تاريخ الدفعة (YYYY-MM-DD)",
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))
                com.example.ui.ux.MawaredTextField(
                    value = reference,
                    onValueChange = { reference = it },
                    label = "مرجع الدفعة (اختياري)",
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("ملاحظة (اختياري)") },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("إلغاء", color = SlateLight) }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = { onSubmit(amount, paymentDate, reference, note) },
                        colors = ButtonDefaults.buttonColors(containerColor = EmeraldMain)
                    ) {
                        Text("تسجيل الدفعة", color = SlateDark, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
fun PayrollVoidPaymentConfirmation(
    payment: PayrollPaymentParams,
    onDismiss: () -> Unit,
    onConfirm: (reason: String) -> Unit
) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("إلغاء دفعة ${formatMoney(payment.amount, payment.currency)}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("سيتم إعادة حساب حالة دفع الفترة تلقائياً بعد الإلغاء.", fontSize = 11.sp, color = SlateLight)
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("سبب الإلغاء") },
                    minLines = 2,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = { TextButton(onClick = { onConfirm(reason) }) { Text("تأكيد الإلغاء", color = RedStatus) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } }
    )
}
