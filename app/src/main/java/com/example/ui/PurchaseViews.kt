package com.example.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.example.domain.model.*
import com.example.ui.theme.*
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Strips locale-specific glyphs (Arabic-Indic ٠-٩, Extended Arabic-Indic ۰-۹, Arabic
 * decimal separator ٫) down to plain English numerals before they ever reach a
 * `toBigDecimalOrNull()` call. Some devices/keyboards emit these digits for
 * `KeyboardType.Decimal` under an Arabic locale even though the app's money/quantity
 * strings must always be plain English numerals end-to-end.
 */
internal fun normalizeDecimalInput(raw: String): String {
    var hasDot = false
    val builder = StringBuilder(raw.length)
    for (ch in raw) {
        when {
            ch in '0'..'9' -> builder.append(ch)
            ch in '\u0660'..'\u0669' -> builder.append('0' + (ch - '\u0660'))
            ch in '\u06F0'..'\u06F9' -> builder.append('0' + (ch - '\u06F0'))
            (ch == '.' || ch == '\u066B') && !hasDot -> { builder.append('.'); hasDot = true }
            else -> Unit
        }
    }
    return builder.toString()
}

private data class RequestLineDraft(
    val description: String = "",
    val category: String = "",
    val quantity: String = "1",
    val unit: String = "قطعة",
    val price: String = "0.00"
)

internal fun purchasingStatusLabel(status: String) = when (status) {
    "pending_department" -> "بانتظار القسم"
    "pending_purchasing" -> "بانتظار المشتريات"
    "approved" -> "معتمد"
    "rejected" -> "مرفوض"
    "cancelled" -> "ملغي"
    "ordered" -> "تم إنشاء أمر"
    "received" -> "مستلم"
    "draft" -> "مسودة"
    "issued" -> "صادر"
    // Commercial Wave 2 statuses.
    "partially_received" -> "مستلم جزئيًا"
    "submitted" -> "مُرحّل"
    "selected" -> "معتمد"
    "pending_approval" -> "بانتظار الاعتماد"
    else -> status
}

internal fun purchasingStatusColor(status: String) = when (status) {
    "approved", "received", "selected" -> EmeraldMain
    "rejected", "cancelled" -> RedStatus
    "ordered", "issued", "partially_received", "submitted" -> MintLight
    else -> AmberStatus
}

@Composable
fun MawaredProcurementManager(viewModel: MawaredViewModel) {
    val state by viewModel.purchasingUiState.collectAsState()
    val context = LocalContext.current
    val tabs = buildList {
        if (state.availableModes.isNotEmpty() || state.canCreate || state.canReviewDepartment || state.canApprove) add("requests" to "الطلبات")
        if (state.availableModes.isNotEmpty() || state.canManageOrders || state.canReceive) add("orders" to "أوامر الشراء")
        if (state.canViewSuppliers || state.canManageSuppliers) add("vendors" to "الموردون")
        if (state.canReport) add("report" to "التقرير")
    }
    var selectedTab by remember { mutableStateOf(tabs.firstOrNull()?.first ?: "requests") }

    LaunchedEffect(Unit) { viewModel.refreshPurchasing() }
    LaunchedEffect(viewModel.focusedPurchaseRequestId, viewModel.focusedVendor?.id) {
        selectedTab = when {
            viewModel.focusedVendor != null -> "vendors"
            viewModel.focusedPurchaseRequestId != null -> "requests"
            else -> selectedTab
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("المشتريات", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("طلبات الشراء والأوامر والموردون", style = MaterialTheme.typography.bodySmall, color = SlateLight)
            }
            IconButton(onClick = viewModel::refreshPurchasing, enabled = !state.isLoading) {
                Icon(Icons.Default.Refresh, contentDescription = "تحديث")
            }
        }
        if (!state.canView || tabs.isEmpty()) {
            PurchasingEmptyState(Icons.Default.Lock, "لا توجد صلاحية لعرض بيانات المشتريات")
            return@Column
        }
        if (state.errorMessage != null) {
            Text(state.errorMessage.orEmpty(), color = RedStatus, style = MaterialTheme.typography.bodySmall)
        }
        ScrollableTabRow(selectedTabIndex = tabs.indexOfFirst { it.first == selectedTab }.coerceAtLeast(0), edgePadding = 0.dp) {
            tabs.forEach { (key, label) ->
                Tab(
                    selected = selectedTab == key,
                    onClick = {
                        viewModel.clearTypedResourceFocus()
                        selectedTab = key
                    },
                    text = { Text(label) }
                )
            }
        }
        Spacer(Modifier.height(10.dp))
        if (state.isLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        when (selectedTab) {
            "requests" -> PurchaseRequestsTab(viewModel, state)
            "orders" -> PurchaseOrdersTab(viewModel, state)
            "vendors" -> SuppliersTabContent(viewModel, state)
            "report" -> PurchasingReportTab(viewModel, state)
        }
    }

    LaunchedEffect(state.pendingExportShare?.uri) {
        val share = state.pendingExportShare ?: return@LaunchedEffect
        try {
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = share.mimeType
                putExtra(android.content.Intent.EXTRA_STREAM, share.uri)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(android.content.Intent.createChooser(intent, "مشاركة ملف تصدير المشتريات"))
        } catch (_: Exception) {
            viewModel.showNotification("تعذرت مشاركة ملف التصدير")
        } finally {
            viewModel.consumePurchasingExportShare()
        }
    }
}

@Composable
private fun PurchaseRequestsTab(viewModel: MawaredViewModel, state: PurchasingUiState) {
    var createOpen by remember { mutableStateOf(false) }
    var reviewTarget by remember { mutableStateOf<Pair<PurchaseRequestParams, Boolean>?>(null) }
    var cancelTarget by remember { mutableStateOf<PurchaseRequestParams?>(null) }
    var orderTarget by remember { mutableStateOf<PurchaseRequestParams?>(null) }
    // Commercial Wave 2 — Operations Slice E1.
    var quotationsTarget by remember { mutableStateOf<PurchaseRequestParams?>(null) }
    val displayedRequests = viewModel.focusedPurchaseRequestId?.let { focusedId ->
        state.requests.filter { it.id == focusedId }
    } ?: state.requests
    Column(Modifier.fillMaxSize()) {
        if (state.availableModes.size > 1) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(state.availableModes) { mode ->
                    FilterChip(
                        selected = state.selectedMode == mode,
                        onClick = { viewModel.updatePurchasingMode(mode) },
                        label = { Text(when (mode) { "own" -> "طلباتي"; "department" -> "القسم"; else -> "الشركة" }) }
                    )
                }
            }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val statuses = listOf(null, "pending_department", "pending_purchasing", "approved", "ordered", "received", "rejected", "cancelled")
            items(statuses) { status ->
                FilterChip(selected = state.statusFilter == status, onClick = { viewModel.updatePurchasingStatus(status) }, label = { Text(status?.let(::purchasingStatusLabel) ?: "الكل") })
            }
        }
        if (state.canCreate) {
            Button(onClick = { createOpen = true }, modifier = Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
                Icon(Icons.Default.PostAdd, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("طلب شراء جديد")
            }
        }
        Spacer(Modifier.height(8.dp))
        if (displayedRequests.isEmpty()) PurchasingEmptyState(Icons.Default.RemoveShoppingCart, "لا توجد طلبات شراء ضمن هذا النطاق")
        else LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(displayedRequests, key = { it.id }) { item ->
                PurchaseRequestCard(
                    item = item,
                    state = state,
                    onDepartmentReview = { reviewTarget = item to true },
                    onPurchasingReview = { reviewTarget = item to false },
                    onCancel = { cancelTarget = item },
                    onCreateOrder = { orderTarget = item },
                    onOverride = { viewModel.openPurchasingOverrideDialog(item) },
                    onTimeline = {
                        viewModel.openTimeline(
                            com.example.domain.model.TimelineKind.PURCHASE_REQUEST,
                            item.id
                        )
                    },
                    onQuotations = { quotationsTarget = item }
                )
            }
        }
    }
    if (createOpen) PurchaseRequestDialog(onDismiss = { createOpen = false }) {
        viewModel.createPurchaseRequest(it); createOpen = false
    }
    reviewTarget?.let { target -> ReviewDialog(target.first, target.second, onDismiss = { reviewTarget = null }) { action, note ->
        viewModel.reviewPurchaseRequest(target.first.id, target.second, action, note); reviewTarget = null
    } }
    cancelTarget?.let { item -> ReasonDialog("إلغاء طلب الشراء", "سبب الإلغاء", onDismiss = { cancelTarget = null }) { reason ->
        viewModel.cancelPurchaseRequest(item.id, reason); cancelTarget = null
    } }
    orderTarget?.let { item -> PurchaseOrderDialog(item, state.suppliers.filter { it.isSelectableForPurchaseOrder }, null, onDismiss = { orderTarget = null }) { draft ->
        viewModel.createPurchaseOrder(draft); orderTarget = null
    } }
    // Sprint 12I: purchasing admin override — dialog visibility/state is ViewModel-driven
    // (state.overrideTarget) rather than local remember, so it survives recomposition and
    // shows the refreshed status/updatedAt after a 412/409 outcome.
    quotationsTarget?.let { request ->
        PurchaseQuotationsDialog(
            requestId = request.id,
            controller = viewModel.purchasingWave2Controller,
            canManageQuotations = state.canManageQuotations,
            canCompareQuotations = state.canCompareQuotations,
            onDismiss = {
                quotationsTarget = null
                viewModel.purchasingWave2Controller.clearComparison()
                viewModel.purchasingWave2Controller.dismissFeedback()
            }
        )
    }
    state.overrideTarget?.let { target ->
        PurchasingOverrideDialog(
            request = target,
            statusLabel = purchasingStatusLabel(target.status),
            isSubmitting = state.overrideSubmitting,
            onDismiss = viewModel::dismissPurchasingOverrideDialog
        ) { action, reason ->
            viewModel.submitPurchasingOverride(target.id, action, reason, target.updatedAt)
        }
    }
}

@Composable
private fun PurchaseRequestCard(
    item: PurchaseRequestParams,
    state: PurchasingUiState,
    onDepartmentReview: () -> Unit,
    onPurchasingReview: () -> Unit,
    onCancel: () -> Unit,
    onCreateOrder: () -> Unit,
    onOverride: () -> Unit,
    onTimeline: (() -> Unit)? = null,
    onQuotations: (() -> Unit)? = null
) {
    var expanded by remember { mutableStateOf(false) }
    val self = item.requestedByEmployeeId == state.currentEmployeeId
    Card(Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
        Column(Modifier.padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(item.requestNumber, style = MaterialTheme.typography.labelMedium, color = SlateLight)
                    Text(item.title, fontWeight = FontWeight.Bold)
                    Text("${item.requesterNameSnapshot} • ${item.departmentNameSnapshot ?: "بدون قسم"}", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                }
                AssistChip(onClick = {}, label = { Text(purchasingStatusLabel(item.status)) }, colors = AssistChipDefaults.assistChipColors(labelColor = purchasingStatusColor(item.status)))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatCurrency(item.totalEstimated), fontWeight = FontWeight.Bold, color = EmeraldMain)
                TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "إخفاء البنود" else "عرض البنود") }
            }
            if (expanded) item.lines.forEach { line ->
                Text("${line.description}: ${line.quantity} ${line.unit} × ${formatCurrency(line.estimatedUnitPrice)} = ${formatCurrency(line.estimatedTotal)}", style = MaterialTheme.typography.bodySmall)
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)
            ) {
                onTimeline?.let {
                    TextButton(onClick = it) {
                        Text(stringResource(com.example.R.string.timeline_action), color = SlateLight)
                    }
                }
                // Commercial Wave 2: quotations are only captured while sourcing is open.
                if (onQuotations != null &&
                    (state.canManageQuotations || state.canCompareQuotations) &&
                    item.status in listOf("pending_department", "pending_purchasing", "approved")
                ) {
                    TextButton(onClick = onQuotations) {
                        Text(stringResource(com.example.R.string.w2_quotations_title))
                    }
                }
                if (item.status == "pending_department" && state.canReviewDepartment && !self) TextButton(onClick = onDepartmentReview) { Text("مراجعة القسم") }
                if (item.status == "pending_purchasing" && state.canApprove && !self) TextButton(onClick = onPurchasingReview) { Text("مراجعة المشتريات") }
                if (item.status == "approved" && state.canManageOrders) Button(onClick = onCreateOrder) { Text("إنشاء أمر") }
                if ((self && item.status in listOf("pending_department", "pending_purchasing")) || (state.canManageOrders && item.status !in listOf("received", "cancelled"))) {
                    TextButton(onClick = onCancel) { Text("إلغاء", color = RedStatus) }
                }
                if (state.canAdminOverride && !self && purchasingOverrideLegalActionsFor(item.status).isNotEmpty()) {
                    PurchasingOverrideButton(onClick = onOverride)
                }
            }
        }
    }
}

@Composable
private fun PurchaseRequestDialog(onDismiss: () -> Unit, onSubmit: (CreatePurchaseRequestParams) -> Unit) {
    var title by remember { mutableStateOf("") }
    var justification by remember { mutableStateOf("") }
    var neededBy by remember { mutableStateOf("") }
    var lines by remember { mutableStateOf(listOf(RequestLineDraft())) }
    val valid = title.isNotBlank() && lines.all { it.description.isNotBlank() && it.unit.isNotBlank() && it.quantity.toBigDecimalOrNull()?.signum() == 1 && it.price.toBigDecimalOrNull()?.signum() != -1 }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("طلب شراء جديد") },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { OutlinedTextField(title, { title = it }, label = { Text("عنوان الطلب") }, modifier = Modifier.fillMaxWidth()) }
            item { OutlinedTextField(justification, { justification = it }, label = { Text("المبرر (اختياري)") }, modifier = Modifier.fillMaxWidth()) }
            item { OutlinedTextField(neededBy, { neededBy = it }, label = { Text("تاريخ الاحتياج yyyy-MM-dd") }, modifier = Modifier.fillMaxWidth()) }
            items(lines.indices.toList()) { index ->
                val line = lines[index]
                Card(shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
                    Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(line.description, { value -> lines = lines.toMutableList().also { it[index] = line.copy(description = value) } }, label = { Text("وصف البند") }, modifier = Modifier.fillMaxWidth())
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(line.quantity, { value -> lines = lines.toMutableList().also { it[index] = line.copy(quantity = normalizeDecimalInput(value)) } }, label = { Text("الكمية") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                            OutlinedTextField(line.unit, { value -> lines = lines.toMutableList().also { it[index] = line.copy(unit = value) } }, label = { Text("الوحدة") }, modifier = Modifier.weight(1f))
                        }
                        OutlinedTextField(line.price, { value -> lines = lines.toMutableList().also { it[index] = line.copy(price = normalizeDecimalInput(value)) } }, label = { Text("السعر التقديري") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                        if (lines.size > 1) TextButton(onClick = { lines = lines.filterIndexed { i, _ -> i != index } }) { Text("إزالة البند", color = RedStatus) }
                    }
                }
            }
            item { OutlinedButton(onClick = { if (lines.size < 50) lines = lines + RequestLineDraft() }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Text("إضافة بند") } }
        } },
        confirmButton = { Button(enabled = valid, onClick = { onSubmit(CreatePurchaseRequestParams(title.trim(), justification.trim().ifEmpty { null }, neededBy.trim().ifEmpty { null }, lines.map { PurchaseRequestLineInput(it.description.trim(), it.category.ifBlank { null }, it.quantity, it.unit.trim(), it.price) })) }) { Text("إرسال") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
private fun ReviewDialog(item: PurchaseRequestParams, department: Boolean, onDismiss: () -> Unit, onSubmit: (String, String?) -> Unit) {
    var note by remember { mutableStateOf("") }
    var reject by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (department) "مراجعة القسم" else "مراجعة المشتريات") },
        text = { Column { Text(item.title); OutlinedTextField(note, { note = it }, label = { Text(if (reject) "سبب الرفض (مطلوب)" else "ملاحظة (اختيارية)") }, modifier = Modifier.fillMaxWidth()) } },
        confirmButton = { Row {
            TextButton(onClick = { reject = true }, enabled = !reject) { Text("رفض", color = RedStatus) }
            Button(onClick = { if (reject) onSubmit("reject", note.trim()) else onSubmit("approve", note.trim().ifEmpty { null }) }, enabled = !reject || note.isNotBlank()) { Text(if (reject) "تأكيد الرفض" else "موافقة") }
        } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } }
    )
}

@Composable
private fun PurchaseOrdersTab(viewModel: MawaredViewModel, state: PurchasingUiState) {
    var editTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    var receiveTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    var cancelTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    var attachTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    // Commercial Wave 2 — Operations Slice E1.
    var receiptTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    var returnsTarget by remember { mutableStateOf<PurchaseOrderParams?>(null) }
    if (state.orders.isEmpty()) PurchasingEmptyState(Icons.Default.ReceiptLong, "لا توجد أوامر شراء ضمن هذا النطاق")
    else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(state.orders, key = { it.id }) { order ->
            Card(Modifier.fillMaxWidth(), shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Row(Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) {
                            Text(order.orderNumber, fontWeight = FontWeight.Bold)
                            Text("${order.vendorNameSnapshot} • ${order.requestNumber.orEmpty()}", style = MaterialTheme.typography.bodySmall, color = SlateLight)
                        }
                        Text(purchasingStatusLabel(order.status), color = purchasingStatusColor(order.status), fontWeight = FontWeight.Bold)
                    }
                    Text(formatCurrency(order.totalAmount), color = EmeraldMain, fontWeight = FontWeight.Bold)
                    order.lines.forEach { Text("${it.descriptionSnapshot}: ${it.quantity} × ${formatCurrency(it.unitPrice)}", style = MaterialTheme.typography.bodySmall) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                        TextButton(onClick = { attachTarget = order }) { Text(stringResource(com.example.R.string.attachment_list_title)) }
                        if (order.status == "draft" && state.canManageOrders) {
                            TextButton(onClick = { editTarget = order }) { Text("تعديل") }
                            Button(onClick = { viewModel.issuePurchaseOrder(order.id) }) { Text("إصدار") }
                        }
                        if (order.status in listOf("issued", "partially_received") && state.canReceive) {
                            TextButton(onClick = { receiptTarget = order }) { Text(stringResource(com.example.R.string.w2_receipt_record)) }
                            Button(onClick = { receiveTarget = order }) { Text("تأكيد الاستلام") }
                        }
                        if (order.status in listOf("issued", "partially_received", "received") &&
                            (state.canCreateReturns || state.canApproveReturns)
                        ) {
                            TextButton(onClick = { returnsTarget = order }) { Text(stringResource(com.example.R.string.w2_returns_title)) }
                        }
                        if (order.status in listOf("draft", "issued") && state.canManageOrders) TextButton(onClick = { cancelTarget = order }) { Text("إلغاء", color = RedStatus) }
                    }
                }
            }
        }
    }
    editTarget?.let { order ->
        val request = state.requests.find { it.id == order.purchaseRequestId }
        if (request != null) PurchaseOrderDialog(request, state.suppliers.filter { it.isSelectableForPurchaseOrder }, order, onDismiss = { editTarget = null }) { draft ->
            viewModel.updatePurchaseOrder(order.id, draft); editTarget = null
        }
    }
    receiveTarget?.let { order -> ReceiveDialog(onDismiss = { receiveTarget = null }) { note -> viewModel.receivePurchaseOrder(order.id, note); receiveTarget = null } }
    cancelTarget?.let { order -> ReasonDialog("إلغاء أمر الشراء", "سبب الإلغاء", onDismiss = { cancelTarget = null }) { reason -> viewModel.cancelPurchaseOrder(order.id, reason); cancelTarget = null } }
    attachTarget?.let { order ->
        PurchaseOrderAttachmentsDialog(orderId = order.id, onDismiss = { attachTarget = null })
    }
    receiptTarget?.let { order ->
        PurchaseReceiptDialog(
            orderId = order.id,
            controller = viewModel.purchasingWave2Controller,
            canOverrideReceipt = state.canAdminOverride,
            onDismiss = {
                receiptTarget = null
                viewModel.purchasingWave2Controller.dismissFeedback()
            }
        )
    }
    returnsTarget?.let { order ->
        PurchaseReturnsDialog(
            orderId = order.id,
            controller = viewModel.purchasingWave2Controller,
            canCreateReturn = state.canCreateReturns,
            canApproveReturn = state.canApproveReturns,
            onDismiss = {
                returnsTarget = null
                viewModel.purchasingWave2Controller.dismissFeedback()
            }
        )
    }
}

@Composable
private fun PurchaseOrderAttachmentsDialog(orderId: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val repo = remember { com.example.core.di.DependencyProvider.attachmentRepository }
    val cacheStore = remember { com.example.core.attachment.AttachmentCacheStore(context.applicationContext) }
    var items by remember { mutableStateOf<List<com.example.data.remote.repository.AttachmentMetadata>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri == null || repo == null) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            error = null
            when (repo.uploadFromUri(uri, purpose = "purchasing", purchaseOrderId = orderId)) {
                is com.example.core.utils.AppResult.Success -> {
                    when (val listed = repo.listForPurchaseOrder(orderId)) {
                        is com.example.core.utils.AppResult.Success -> items = listed.data
                        else -> error = context.getString(com.example.R.string.attachment_upload_failed)
                    }
                }
                else -> error = context.getString(com.example.R.string.attachment_upload_failed)
            }
            busy = false
        }
    }
    LaunchedEffect(orderId, repo) {
        if (repo == null) return@LaunchedEffect
        when (val listed = repo.listForPurchaseOrder(orderId)) {
            is com.example.core.utils.AppResult.Success -> items = listed.data
            else -> error = context.getString(com.example.R.string.attachment_download_failed)
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(com.example.R.string.attachment_list_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = RedStatus) }
                if (items.isEmpty() && !busy) Text("لا توجد مرفقات بعد", color = SlateLight)
                items.forEach { attachment ->
                    TextButton(onClick = {
                        if (repo == null) return@TextButton
                        scope.launch {
                            busy = true
                            when (val downloaded = repo.downloadToCache(attachment.id)) {
                                is com.example.core.utils.AppResult.Success -> {
                                    try {
                                        context.startActivity(
                                            android.content.Intent.createChooser(
                                                cacheStore.openViewerIntent(downloaded.data),
                                                context.getString(com.example.R.string.attachment_open)
                                            )
                                        )
                                    } catch (_: Exception) {
                                        error = context.getString(com.example.R.string.attachment_missing_viewer)
                                    }
                                }
                                else -> error = context.getString(com.example.R.string.attachment_download_failed)
                            }
                            busy = false
                        }
                    }) {
                        Text(attachment.originalFilename, color = EmeraldMain)
                    }
                }
            }
        },
        confirmButton = {
            Button(enabled = !busy && repo != null, onClick = { picker.launch("*/*") }) {
                Text(stringResource(com.example.R.string.attachment_pick))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } }
    )
}

@Composable
private fun PurchaseOrderDialog(request: PurchaseRequestParams, vendors: List<Supplier>, existing: PurchaseOrderParams?, onDismiss: () -> Unit, onSubmit: (PurchaseOrderDraftParams) -> Unit) {
    var vendorId by remember { mutableStateOf(existing?.vendorId ?: vendors.firstOrNull()?.id.orEmpty()) }
    var menuOpen by remember { mutableStateOf(false) }
    var lines by remember { mutableStateOf((existing?.lines?.map { PurchaseOrderLineInput(it.id, it.requestLineId, it.descriptionSnapshot, it.categorySnapshot, it.quantity, it.unitSnapshot, it.unitPrice) }
        ?: request.lines.map { PurchaseOrderLineInput(requestLineId = it.id, description = it.description, category = it.category, quantity = it.quantity, unit = it.unit, unitPrice = it.estimatedUnitPrice) })) }
    val total = lines.mapNotNull { line ->
        val quantity = line.quantity.toBigDecimalOrNull()
        val price = line.unitPrice.toBigDecimalOrNull()
        if (quantity != null && price != null) quantity.multiply(price).setScale(2, RoundingMode.HALF_UP) else null
    }.fold(BigDecimal.ZERO, BigDecimal::add).setScale(2).toPlainString()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (existing == null) "إنشاء أمر شراء" else "تعديل مسودة الأمر") },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Box { OutlinedButton(onClick = { menuOpen = true }, modifier = Modifier.fillMaxWidth()) { Text(vendors.find { it.id == vendorId }?.name ?: "اختر مورداً نشطاً") }; DropdownMenu(menuOpen, { menuOpen = false }) { vendors.forEach { vendor -> DropdownMenuItem(text = { Text(vendor.name) }, onClick = { vendorId = vendor.id; menuOpen = false }) } } } }
            items(lines.indices.toList()) { index ->
                val line = lines[index]
                Column {
                    Text(line.description, fontWeight = FontWeight.Bold)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(line.quantity, { value -> lines = lines.toMutableList().also { it[index] = line.copy(quantity = normalizeDecimalInput(value)) } }, label = { Text("الكمية") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                        OutlinedTextField(line.unitPrice, { value -> lines = lines.toMutableList().also { it[index] = line.copy(unitPrice = normalizeDecimalInput(value)) } }, label = { Text("سعر الوحدة") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                    }
                }
            }
            item { Text("الإجمالي: ${formatCurrency(total)}", fontWeight = FontWeight.Bold, color = EmeraldMain) }
        } },
        confirmButton = { Button(enabled = vendorId.isNotBlank() && lines.isNotEmpty() && lines.all { it.quantity.toBigDecimalOrNull()?.signum() == 1 && it.unitPrice.toBigDecimalOrNull()?.signum() != -1 }, onClick = { onSubmit(PurchaseOrderDraftParams(request.id, vendorId, lines)) }) { Text("حفظ المسودة") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("إلغاء") } }
    )
}

@Composable
private fun ReceiveDialog(onDismiss: () -> Unit, onSubmit: (String?) -> Unit) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Default.Inventory, null) },
        title = { Text("تأكيد الاستلام الكامل") },
        text = { Column { Text("هذا تأكيد إداري لاستلام الطلب ولا يمثل إثبات فاتورة أو سداد."); OutlinedTextField(note, { note = it }, label = { Text("ملاحظة الاستلام (اختيارية)") }) } },
        confirmButton = { Button(onClick = { onSubmit(note.trim().ifEmpty { null }) }) { Text("تأكيد الاستلام") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } }
    )
}

@Composable
private fun ReasonDialog(title: String, label: String, onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = { OutlinedTextField(reason, { reason = it }, label = { Text(label) }, modifier = Modifier.fillMaxWidth()) }, confirmButton = { Button(enabled = reason.isNotBlank(), onClick = { onSubmit(reason.trim()) }) { Text("تأكيد") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("رجوع") } })
}

@Composable
private fun PurchasingReportTab(viewModel: MawaredViewModel, state: PurchasingUiState) {
    val summary = state.report?.summary
    if (summary == null) PurchasingEmptyState(Icons.Default.Assessment, "لا توجد بيانات تقرير متاحة")
    else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("ملخص المشتريات", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("requestCount")), summary.requestCount.toString(), Modifier.weight(1f))
                PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("orderCount")), summary.orderCount.toString(), Modifier.weight(1f))
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("pendingDepartmentCount")), summary.pendingDepartmentCount.toString(), Modifier.weight(1f))
                PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("pendingPurchasingCount")), summary.pendingPurchasingCount.toString(), Modifier.weight(1f))
            }
        }
        item { PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("orderedTotal")), formatCurrency(summary.orderedTotal), Modifier.fillMaxWidth()) }
        item { PurchasingMetric(stringResource(MetricLabelResolver.resolveResId("receivedTotal")), formatCurrency(summary.receivedTotal), Modifier.fillMaxWidth()) }
        item { Text("الأرقام مبنية على السجلات المحفوظة ولا تمثل دفعاً أو قيداً محاسبياً.", style = MaterialTheme.typography.bodySmall, color = SlateLight) }
        item {
            PurchasingExportActions(
                canExport = state.canExportPurchasing,
                exportingFormat = state.exportingFormat,
                onExport = viewModel::exportPurchasingReport
            )
        }
    }
}

@Composable
private fun PurchasingMetric(label: String, value: String, modifier: Modifier) {
    Card(modifier, shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) { Column(Modifier.padding(12.dp)) { Text(label, style = MaterialTheme.typography.bodySmall, color = SlateLight); Text(value, fontWeight = FontWeight.Bold) } }
}

@Composable
private fun PurchasingEmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, message: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally) { Icon(icon, null, Modifier.size(48.dp), tint = SlateLight); Spacer(Modifier.height(8.dp)); Text(message, color = SlateLight) } }
}
