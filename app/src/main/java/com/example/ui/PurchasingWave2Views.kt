package com.example.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.example.R
import com.example.core.utils.PurchasingQuantity
import com.example.domain.model.OrderReceiptProgressParams
import com.example.domain.model.PurchaseReturnReasons
import com.example.domain.model.SupplierQuotationParams
import com.example.ui.theme.*

/**
 * Commercial Wave 2 purchasing UI (Operations Slice E1).
 *
 * These composables extend the existing purchasing experience — they do not
 * replace it. Every mutation goes through [PurchasingWave2Controller], which
 * blocks a second submit while one is in flight and refuses to send an
 * over-receipt without the elevated permission plus a typed confirmation.
 */

@Composable
internal fun purchaseReturnReasonLabel(code: String): String = when (code) {
    PurchaseReturnReasons.DAMAGED -> stringResource(R.string.w2_return_reason_damaged)
    PurchaseReturnReasons.WRONG_ITEM -> stringResource(R.string.w2_return_reason_wrong_item)
    PurchaseReturnReasons.EXCESS_QUANTITY -> stringResource(R.string.w2_return_reason_excess)
    PurchaseReturnReasons.QUALITY_REJECTED -> stringResource(R.string.w2_return_reason_quality)
    PurchaseReturnReasons.EXPIRED -> stringResource(R.string.w2_return_reason_expired)
    else -> stringResource(R.string.w2_return_reason_other)
}

@Composable
private fun DialogFrame(
    title: String,
    onDismiss: () -> Unit,
    confirmLabel: String? = null,
    confirmEnabled: Boolean = true,
    onConfirm: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, fontWeight = FontWeight.Bold) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                content = content
            )
        },
        confirmButton = {
            if (confirmLabel != null && onConfirm != null) {
                Button(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmLabel) }
            } else {
                TextButton(onClick = onDismiss) { Text("إغلاق") }
            }
        },
        dismissButton = if (confirmLabel != null) {
            { TextButton(onClick = onDismiss) { Text("إلغاء") } }
        } else null
    )
}

/** Supplier quotations for one purchase request: view, submit and award. */
@Composable
fun PurchaseQuotationsDialog(
    requestId: String,
    controller: PurchasingWave2Controller,
    canManageQuotations: Boolean,
    canCompareQuotations: Boolean,
    onDismiss: () -> Unit
) {
    val state by controller.state.collectAsState()
    var awardTarget by remember { mutableStateOf<SupplierQuotationParams?>(null) }

    LaunchedEffect(requestId) { controller.loadQuotations(requestId) }

    DialogFrame(title = stringResource(R.string.w2_quotations_title), onDismiss = onDismiss) {
        state.errorMessage?.let { Text(it, color = RedStatus, fontWeight = FontWeight.Bold) }
        state.successMessage?.let { Text(it, color = EmeraldMain, fontWeight = FontWeight.Bold) }

        if (canCompareQuotations) {
            TextButton(
                onClick = { controller.compareQuotations(requestId) },
                enabled = !state.isBusy
            ) { Text(stringResource(R.string.w2_quotation_compare)) }
        }

        state.comparison?.let { comparison ->
            Text(stringResource(R.string.w2_comparison_title), fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.w2_comparison_neutral_note), style = MaterialTheme.typography.bodySmall, color = SlateLight)
            Text(
                "${stringResource(R.string.w2_comparison_lowest)}: ${comparison.totals.lowestTotalAmount ?: "—"}" +
                    " • ${stringResource(R.string.w2_comparison_highest)}: ${comparison.totals.highestTotalAmount ?: "—"}" +
                    " • ${stringResource(R.string.w2_comparison_spread)}: ${comparison.totals.spreadAmount ?: "—"}",
                style = MaterialTheme.typography.bodySmall
            )
            // Horizontal scroll keeps every supplier column reachable on a phone
            // without collapsing the request line it belongs to.
            comparison.matrix.forEach { row ->
                Column(Modifier.fillMaxWidth()) {
                    Text(
                        "${row.description} — ${PurchasingQuantity.format(row.requestedQuantity)} ${row.unit}",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodySmall
                    )
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        row.cells.forEach { cell ->
                            Column {
                                Text(cell.vendorNameSnapshot, style = MaterialTheme.typography.labelSmall, color = SlateLight)
                                Text(
                                    if (cell.quoted) "${cell.lineTotal}" else stringResource(R.string.w2_comparison_not_quoted),
                                    style = MaterialTheme.typography.bodySmall
                                )
                            }
                        }
                    }
                }
            }
            TextButton(onClick = { controller.clearComparison() }) { Text("إخفاء المقارنة") }
        }

        if (state.quotations.isEmpty()) {
            Text(stringResource(R.string.w2_quotations_empty), color = SlateLight)
        } else {
            state.quotations.forEach { quotation ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth()) {
                            Column(Modifier.weight(1f)) {
                                Text(quotation.quotationNumber, fontWeight = FontWeight.Bold)
                                Text(quotation.vendorNameSnapshot, style = MaterialTheme.typography.bodySmall, color = SlateLight)
                            }
                            Text(
                                if (quotation.isSelected) stringResource(R.string.w2_quotation_selected)
                                else purchasingStatusLabel(quotation.status),
                                color = purchasingStatusColor(quotation.status),
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Text("${quotation.totalAmount} ${quotation.currency}", color = EmeraldMain, fontWeight = FontWeight.Bold)
                        Text(
                            "${stringResource(R.string.w2_quotation_version)}: ${quotation.version}" +
                                " • ${stringResource(R.string.w2_quotation_valid_until)}: ${quotation.validUntilDate ?: "—"}" +
                                " • ${stringResource(R.string.w2_quotation_lead_time)}: ${quotation.leadTimeDays ?: "—"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = SlateLight
                        )
                        if (canManageQuotations) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (quotation.status == "draft") {
                                    TextButton(
                                        onClick = { controller.submitQuotation(quotation.id) },
                                        enabled = !state.isBusy
                                    ) { Text(stringResource(R.string.w2_quotation_submit)) }
                                }
                                if (quotation.status == "submitted") {
                                    Button(
                                        onClick = { awardTarget = quotation },
                                        enabled = !state.isBusy
                                    ) { Text(stringResource(R.string.w2_quotation_select)) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    awardTarget?.let { quotation ->
        var reason by remember(quotation.id) { mutableStateOf("") }
        DialogFrame(
            title = stringResource(R.string.w2_quotation_select_title),
            onDismiss = { awardTarget = null },
            confirmLabel = stringResource(R.string.w2_quotation_select),
            confirmEnabled = reason.isNotBlank() && !state.isBusy,
            onConfirm = {
                controller.selectQuotation(quotation.id, reason)
                awardTarget = null
            }
        ) {
            Text(stringResource(R.string.w2_quotation_select_hint), style = MaterialTheme.typography.bodySmall, color = SlateLight)
            OutlinedTextField(
                value = reason,
                onValueChange = { reason = it },
                label = { Text(stringResource(R.string.w2_quotation_select_reason)) },
                singleLine = false,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

/** Per-line receipt progress and the partial-receipt entry form. */
@Composable
fun PurchaseReceiptDialog(
    orderId: String,
    controller: PurchasingWave2Controller,
    canOverrideReceipt: Boolean,
    onDismiss: () -> Unit
) {
    val state by controller.state.collectAsState()
    val quantities = remember(orderId) { mutableStateMapOf<String, String>() }
    var reference by remember(orderId) { mutableStateOf("") }
    var overrideReason by remember(orderId) { mutableStateOf("") }
    var overrideConfirmation by remember(orderId) { mutableStateOf("") }

    LaunchedEffect(orderId) { controller.loadReceipts(orderId) }

    val progress: OrderReceiptProgressParams? = state.progress
    val entered = progress?.lines.orEmpty()
        .mapNotNull { line ->
            val value = quantities[line.purchaseOrderLineId]?.trim().orEmpty()
            if (value.isEmpty()) null else line to value
        }
    val needsOverride = entered.any { (line, value) ->
        PurchasingQuantity.exceeds(value, line.remainingQuantity)
    }

    DialogFrame(
        title = stringResource(R.string.w2_receipt_title),
        onDismiss = onDismiss,
        confirmLabel = stringResource(R.string.w2_receipt_record),
        confirmEnabled = entered.isNotEmpty() && !state.isBusy &&
            (!needsOverride || (canOverrideReceipt && overrideConfirmation == "OVERRIDE" && overrideReason.isNotBlank())),
        onConfirm = {
            controller.recordReceipt(
                orderId = orderId,
                lines = entered.map { (line, value) -> line.purchaseOrderLineId to value },
                referenceNumber = reference.ifBlank { null },
                note = null,
                overrideReason = overrideReason.ifBlank { null },
                overrideConfirmation = overrideConfirmation.ifBlank { null },
                canOverride = canOverrideReceipt
            )
        }
    ) {
        state.errorMessage?.let { Text(it, color = RedStatus, fontWeight = FontWeight.Bold) }
        state.successMessage?.let { Text(it, color = EmeraldMain, fontWeight = FontWeight.Bold) }

        progress?.lines.orEmpty().forEach { line ->
            Column(Modifier.fillMaxWidth()) {
                Text(line.descriptionSnapshot, fontWeight = FontWeight.Bold)
                Text(
                    "${stringResource(R.string.w2_receipt_ordered)}: ${PurchasingQuantity.format(line.orderedQuantity)}" +
                        " • ${stringResource(R.string.w2_receipt_received)}: ${PurchasingQuantity.format(line.receivedQuantity)}" +
                        " • ${stringResource(R.string.w2_receipt_returned)}: ${PurchasingQuantity.format(line.returnedQuantity)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = SlateLight
                )
                Text(
                    "${stringResource(R.string.w2_receipt_remaining)}: ${PurchasingQuantity.format(line.remainingQuantity)} ${line.unitSnapshot}",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold
                )
                LinearProgressIndicator(
                    progress = { PurchasingQuantity.receivedPercent(line.netReceivedQuantity, line.orderedQuantity) / 100f },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = quantities[line.purchaseOrderLineId].orEmpty(),
                    onValueChange = { quantities[line.purchaseOrderLineId] = it },
                    label = { Text(stringResource(R.string.w2_receipt_received)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        OutlinedTextField(
            value = reference,
            onValueChange = { reference = it },
            label = { Text(stringResource(R.string.w2_receipt_reference)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        if (needsOverride) {
            Text(stringResource(R.string.w2_receipt_override_title), color = AmberStatus, fontWeight = FontWeight.Bold)
            Text(stringResource(R.string.w2_receipt_override_hint), style = MaterialTheme.typography.bodySmall, color = SlateLight)
            if (canOverrideReceipt) {
                OutlinedTextField(
                    value = overrideConfirmation,
                    onValueChange = { overrideConfirmation = it },
                    label = { Text(stringResource(R.string.w2_receipt_override_confirm)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = overrideReason,
                    onValueChange = { overrideReason = it },
                    label = { Text(stringResource(R.string.w2_receipt_override_reason)) },
                    singleLine = false,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        if (state.receipts.isNotEmpty()) {
            Text(stringResource(R.string.w2_receipt_history), fontWeight = FontWeight.Bold)
            state.receipts.forEach { receipt ->
                Text(
                    "${receipt.receiptNumber} • ${receipt.receivedAt ?: "—"}" +
                        if (receipt.overrideApplied) " • ${stringResource(R.string.w2_receipt_override_applied)}" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = SlateLight
                )
            }
        }
    }
}

/** Supplier returns for one purchase order: list, raise and review. */
@Composable
fun PurchaseReturnsDialog(
    orderId: String,
    controller: PurchasingWave2Controller,
    canCreateReturn: Boolean,
    canApproveReturn: Boolean,
    onDismiss: () -> Unit
) {
    val state by controller.state.collectAsState()
    val quantities = remember(orderId) { mutableStateMapOf<String, String>() }
    var reasonCode by remember(orderId) { mutableStateOf(PurchaseReturnReasons.DAMAGED) }
    var reasonMenuOpen by remember { mutableStateOf(false) }

    LaunchedEffect(orderId) {
        controller.loadReceipts(orderId)
        controller.loadReturns(orderId)
    }

    val returnable = state.progress?.lines.orEmpty().filter { PurchasingQuantity.isPositive(it.netReceivedQuantity) }
    val entered = returnable.mapNotNull { line ->
        val value = quantities[line.purchaseOrderLineId]?.trim().orEmpty()
        if (value.isEmpty()) null else line to value
    }

    DialogFrame(
        title = stringResource(R.string.w2_returns_title),
        onDismiss = onDismiss,
        confirmLabel = if (canCreateReturn) stringResource(R.string.w2_return_create) else null,
        confirmEnabled = entered.isNotEmpty() && !state.isBusy,
        onConfirm = if (canCreateReturn) {
            {
                controller.createReturn(
                    orderId = orderId,
                    reasonCode = reasonCode,
                    note = null,
                    lines = entered.map { (line, value) -> line.purchaseOrderLineId to value }
                )
            }
        } else null
    ) {
        state.errorMessage?.let { Text(it, color = RedStatus, fontWeight = FontWeight.Bold) }
        state.successMessage?.let { Text(it, color = EmeraldMain, fontWeight = FontWeight.Bold) }
        Text(stringResource(R.string.w2_return_segregation_note), style = MaterialTheme.typography.bodySmall, color = SlateLight)

        if (canCreateReturn) {
            Box {
                TextButton(onClick = { reasonMenuOpen = true }) {
                    Text("${stringResource(R.string.w2_return_reason)}: ${purchaseReturnReasonLabel(reasonCode)}")
                }
                DropdownMenu(expanded = reasonMenuOpen, onDismissRequest = { reasonMenuOpen = false }) {
                    PurchaseReturnReasons.all.forEach { code ->
                        DropdownMenuItem(
                            text = { Text(purchaseReturnReasonLabel(code)) },
                            onClick = {
                                reasonCode = code
                                reasonMenuOpen = false
                            }
                        )
                    }
                }
            }
            returnable.forEach { line ->
                Column(Modifier.fillMaxWidth()) {
                    Text(line.descriptionSnapshot, fontWeight = FontWeight.Bold)
                    Text(
                        "${stringResource(R.string.w2_receipt_net)}: ${PurchasingQuantity.format(line.netReceivedQuantity)} ${line.unitSnapshot}",
                        style = MaterialTheme.typography.bodySmall,
                        color = SlateLight
                    )
                    OutlinedTextField(
                        value = quantities[line.purchaseOrderLineId].orEmpty(),
                        onValueChange = { quantities[line.purchaseOrderLineId] = it },
                        label = { Text(stringResource(R.string.w2_receipt_returned)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }

        if (state.returns.isEmpty()) {
            Text(stringResource(R.string.w2_returns_empty), color = SlateLight)
        } else {
            state.returns.forEach { row ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(row.returnNumber, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            Text(purchasingStatusLabel(row.status), color = purchasingStatusColor(row.status), fontWeight = FontWeight.Bold)
                        }
                        Text(purchaseReturnReasonLabel(row.reasonCode), style = MaterialTheme.typography.bodySmall, color = SlateLight)
                        if (canApproveReturn && row.isPendingApproval) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Button(
                                    onClick = { controller.reviewReturn(row.id, "approve", null) },
                                    enabled = !state.isBusy
                                ) { Text(stringResource(R.string.w2_return_approve)) }
                                TextButton(
                                    onClick = { controller.reviewReturn(row.id, "reject", "rejected on review") },
                                    enabled = !state.isBusy
                                ) { Text(stringResource(R.string.w2_return_reject), color = RedStatus) }
                            }
                        }
                    }
                }
            }
        }
    }
}
